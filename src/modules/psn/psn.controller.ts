import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import { Role } from "@prisma/client";
import type { Response } from "express";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { TenantGuard } from "../../common/guards/tenant.guard";
import { IdempotencyService } from "../../common/idempotency.service";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  createPsnSchema,
  listPsnsSchema,
  postPsnMessageSchema,
  updatePsnDraftSchema,
  type CreatePsnInput,
  type ListPsnsInput,
  type PostPsnMessageInput,
  type UpdatePsnDraftInput,
} from "../../common/schemas/psn.schema";

import { AdminPsnService } from "./admin-psn.service";
import { PsnMessageService } from "./psn-message.service";
import { PsnService } from "./psn.service";

@Controller({ path: "psns", version: "1" })
@Roles(Role.VENDOR, Role.VENDOR_SUB_USER)
@UseGuards(TenantGuard)
export class PsnController {
  constructor(
    private readonly psns: PsnService,
    private readonly idempotency: IdempotencyService,
    // payHold runs the same transaction as admin's hold lifecycle methods,
    // so the logic lives on AdminPsnService and the vendor controller
    // delegates to it. Tenant scoping is enforced inside the method via
    // vendorId comparison.
    private readonly adminPsns: AdminPsnService,
    private readonly messages: PsnMessageService,
  ) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(listPsnsSchema)) q: ListPsnsInput,
  ) {
    return this.psns.list(user.vendorId!, q);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createPsnSchema)) body: CreatePsnInput,
  ) {
    return this.psns.create(user.vendorId!, user.sub, body);
  }

  @Get(":id")
  get(@CurrentUser() user: AuthenticatedUser, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.psns.get(user.vendorId!, id);
  }

  /** Phase 2 — fetch the active Hold for the vendor's banner + Pay CTA. */
  @Get(":id/active-hold")
  activeHold(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    return this.adminPsns.activeHoldFor(id, user.vendorId!);
  }

  @Patch(":id")
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updatePsnDraftSchema)) body: UpdatePsnDraftInput,
  ) {
    return this.psns.updateDraft(user.vendorId!, user.sub, id, body);
  }

  @Post(":id/submit")
  @HttpCode(HttpStatus.OK)
  async submit(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    // PSN submit debits the wallet for the onboarding fee. The DRAFT-only
    // state machine already prevents double-charge, but we add explicit
    // Idempotency-Key support so retries return the original response.
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 255) {
      throw new BadRequestException({
        message: "Idempotency-Key header is required for PSN submit (8–255 chars).",
        code: "idempotency_key_required",
      });
    }

    const endpoint = `POST /v1/psns/${id}/submit`;
    const cached = await this.idempotency.lookup({
      key: idempotencyKey,
      endpoint,
      vendorId: user.vendorId!,
      body: { id },
    });
    if (cached) {
      res.status(cached.status);
      return cached.body;
    }

    const result = await this.psns.submit(user.vendorId!, user.sub, id);

    await this.idempotency.commit({
      key: idempotencyKey,
      endpoint,
      vendorId: user.vendorId!,
      body: { id },
      responseStatus: HttpStatus.OK,
      responseBody: result,
    });

    return result;
  }

  @Post(":id/cancel")
  @HttpCode(HttpStatus.OK)
  cancel(@CurrentUser() user: AuthenticatedUser, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.psns.cancel(user.vendorId!, user.sub, id);
  }

  /**
   * Phase 2 — pay the extra-charge Hold placed by admin. Debits the
   * vendor's wallet for the hold amount and transitions the PSN back to
   * AWAITING_RECEIPT. Insufficient funds → frontend renders the topup CTA.
   */
  @Post(":id/pay-hold")
  @HttpCode(HttpStatus.OK)
  payHold(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    return this.adminPsns.payHold(id, user.vendorId!, user.sub);
  }

  // ---------------------------------------------------------------------------
  // Migration 0024 — per-PSN chat (vendor side)
  //
  // `psns.get` already enforces tenant scoping (only the owning vendor
  // can resolve the PSN), so calling it before each message action gives
  // us the IDOR guard for free: an attempt to chat on another vendor's
  // PSN throws 404 before the message service is touched.
  // ---------------------------------------------------------------------------

  @Get(":id/messages")
  async listMessages(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    await this.psns.get(user.vendorId!, id);
    return this.messages.listForPsn(id);
  }

  @Post(":id/messages")
  @HttpCode(HttpStatus.OK)
  async postMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(postPsnMessageSchema)) body: PostPsnMessageInput,
  ) {
    await this.psns.get(user.vendorId!, id);
    return this.messages.postFromVendor({
      psnId: id,
      senderUserId: user.sub,
      body: body.body,
      attachmentUrls: body.attachmentUrls,
    });
  }

  @Post(":id/messages/read")
  @HttpCode(HttpStatus.NO_CONTENT)
  async markRead(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.psns.get(user.vendorId!, id);
    return this.messages.markReadByVendor(id);
  }
}
