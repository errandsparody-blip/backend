import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from "@nestjs/common";
import { Role } from "@prisma/client";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  completeReceivingSchema,
  listPsnsSchema,
  placeHoldSchema,
  postPsnMessageSchema,
  rejectPsnSchema,
  requestPsnReturnSchema,
  resolveDiscrepancySchema,
  type CompleteReceivingInput,
  type ListPsnsInput,
  type PlaceHoldInput,
  type PostPsnMessageInput,
  type RejectPsnInput,
  type RequestPsnReturnInput,
  type ResolveDiscrepancyInput,
} from "../../common/schemas/psn.schema";
import {
  presignShopperUploadSchema,
  type PresignShopperUploadInput,
} from "../../common/schemas/shopper.schema";

import { R2Service } from "../integrations/r2/r2.service";

import { AdminPsnService } from "./admin-psn.service";
import { PsnMessageService } from "./psn-message.service";

@Controller({ path: "admin/psns", version: "1" })
@Roles(Role.WAREHOUSE_OPERATOR, Role.FINANCE_ADMIN, Role.SUPER_ADMIN)
export class AdminPsnController {
  constructor(
    private readonly admin: AdminPsnService,
    private readonly messages: PsnMessageService,
    private readonly r2: R2Service,
  ) {}

  @Get()
  list(@Query(new ZodValidationPipe(listPsnsSchema)) q: ListPsnsInput) {
    return this.admin.listIncoming(q);
  }

  @Get(":id")
  get(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.admin.get(id);
  }

  /** Phase 2 — return the currently-active hold (or null) for a PSN. */
  @Get(":id/active-hold")
  activeHold(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.admin.activeHoldFor(id);
  }

  @Post(":id/receive")
  @HttpCode(HttpStatus.OK)
  receive(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(completeReceivingSchema)) body: CompleteReceivingInput,
  ) {
    return this.admin.completeReceiving(id, user.sub, body);
  }

  /**
   * Phase 2 — place the PSN on Hold pending an extra payment from vendor.
   * Status: AWAITING_RECEIPT / PARTIALLY_RECEIVED / DISCREPANCY → HOLD.
   */
  @Post(":id/hold")
  @HttpCode(HttpStatus.OK)
  placeHold(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(placeHoldSchema)) body: PlaceHoldInput,
  ) {
    return this.admin.placeHold(id, user.sub, body);
  }

  /**
   * Phase 2 — refuse the PSN outright. No inventory. Onboarding fee stays
   * debited (finance can refund separately if appropriate).
   */
  @Post(":id/reject")
  @HttpCode(HttpStatus.OK)
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(rejectPsnSchema)) body: RejectPsnInput,
  ) {
    return this.admin.reject(id, user.sub, body);
  }

  /**
   * Close out a DISCREPANCY PSN with the previously-recorded
   * quantities accepted as final. No inventory change — just flips
   * status DISCREPANCY → RECEIVED with an audit-logged note explaining
   * the reconciliation (vendor confirmation, follow-up shipment, etc.).
   */
  @Post(":id/resolve-discrepancy")
  @HttpCode(HttpStatus.OK)
  resolveDiscrepancy(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(resolveDiscrepancySchema)) body: ResolveDiscrepancyInput,
  ) {
    return this.admin.resolveDiscrepancy(id, user.sub, body);
  }

  /**
   * Phase 2 — ship the package back to the vendor unopened. Wallet debits
   * the return-shipping cost immediately (insufficient funds → 4xx, admin
   * resolves).
   */
  @Post(":id/request-return")
  @HttpCode(HttpStatus.OK)
  requestReturn(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(requestPsnReturnSchema)) body: RequestPsnReturnInput,
  ) {
    return this.admin.requestReturn(id, user.sub, body);
  }

  // ---------------------------------------------------------------------------
  // Migration 0024 — per-PSN chat (admin side)
  // ---------------------------------------------------------------------------

  /** GET /v1/admin/psns/:id/messages — full thread for this PSN. */
  @Get(":id/messages")
  listMessages(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.messages.listForPsn(id);
  }

  /**
   * POST /v1/admin/psns/:id/messages — admin posts a message. Fans an
   * in-app notification + email to every active user on the vendor org.
   */
  @Post(":id/messages")
  @HttpCode(HttpStatus.OK)
  postMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(postPsnMessageSchema)) body: PostPsnMessageInput,
  ) {
    return this.messages.postFromAdmin({
      psnId: id,
      senderUserId: user.sub,
      body: body.body,
      attachmentUrls: body.attachmentUrls,
    });
  }

  /**
   * POST /v1/admin/psns/:id/messages/read — drop the admin-side unread
   * badge for this PSN's vendor-authored messages to zero.
   */
  @Post(":id/messages/read")
  @HttpCode(HttpStatus.NO_CONTENT)
  markRead(@Param("id", new ParseUUIDPipe()) id: string): Promise<void> {
    return this.messages.markReadByAdmin(id);
  }

  /**
   * Migration 0024 — presign an R2 PUT for a chat attachment. Reuses the
   * shopper presign schema (same MIME allow-list, same 25 MB cap) so we
   * only have one source of truth for what a chat attachment can be.
   * Key prefix is scoped to `psn/<id>/admin` for forensic auditing.
   */
  @Post(":id/uploads")
  @HttpCode(HttpStatus.OK)
  async presignChatUpload(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(presignShopperUploadSchema))
    body: PresignShopperUploadInput,
  ) {
    // Confirm the PSN exists — admin role is already gated by @Roles
    // above, so we don't need vendor-scope here.
    await this.admin.get(id);
    const key = this.r2.generateKey(`psn/${id}/admin`, body.filename);
    return this.r2.presignPut({
      key,
      contentType: body.contentType,
      contentLengthBytes: body.contentLengthBytes,
    });
  }
}
