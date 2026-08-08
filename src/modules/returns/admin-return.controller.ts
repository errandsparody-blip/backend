/**
 * Admin return endpoints. Implementation Plan §6.7.
 *
 *   GET    /v1/admin/returns                 — operator queue
 *   POST   /v1/admin/returns/:id/receive     — mark inbound received
 *   POST   /v1/admin/returns/:id/inspect     — set disposition + refund
 */

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
import { RequiresPage } from "../../common/decorators/requires-page.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";

// Migration 0039 — ADMIN role reference.
const ROLE_ADMIN = "ADMIN" as Role;
import {
  finalizeReturnSchema,
  inspectReturnSchema,
  listReturnsSchema,
  presignReturnUploadSchema,
  receiveReturnSchema,
  type FinalizeReturnInput,
  type InspectReturnInput,
  type ListReturnsInput,
  type PresignReturnUploadInput,
  type ReceiveReturnInput,
} from "../../common/schemas/return.schema";
import { R2Service } from "../integrations/r2/r2.service";

import { ReturnService } from "./return.service";

@Controller({ path: "admin/returns", version: "1" })
// Migration 0039 — ADMIN added. Default is write; GET overrides to
// read. `inspect` triggers refunds to the vendor wallet, but stays
// grantable to ADMIN via config since it doesn't move money OUT of
// the platform — only back to the vendor. SUPER_ADMIN can revoke
// admin.returns.write if they want to lock this down.
@Roles(Role.WAREHOUSE_OPERATOR, Role.FINANCE_ADMIN, Role.SUPER_ADMIN, ROLE_ADMIN)
@RequiresPage("admin.returns.write")
export class AdminReturnController {
  constructor(
    private readonly returns: ReturnService,
    private readonly r2: R2Service,
  ) {}

  @Get()
  @RequiresPage("admin.returns.read")
  list(@Query(new ZodValidationPipe(listReturnsSchema)) q: ListReturnsInput) {
    return this.returns.adminList(q);
  }

  /**
   * Returns v2 — the configurable processing fee (cents), so the admin
   * finalize preview shows the exact charge instead of a hard-coded
   * default.
   */
  @Get("config")
  @RequiresPage("admin.returns.read")
  async config() {
    return { processingFeeCents: await this.returns.getProcessingFeeCents() };
  }

  // Declared AFTER the literal "config" route so /admin/returns/config
  // resolves to the config handler, not this param route.
  @Get(":id")
  @RequiresPage("admin.returns.read")
  get(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.returns.adminGet(id);
  }

  @Post(":id/receive")
  @HttpCode(HttpStatus.OK)
  receive(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(receiveReturnSchema)) body: ReceiveReturnInput,
  ) {
    return this.returns.adminReceive(user.sub, id, body);
  }

  /**
   * Returns v2 — record condition + share photos of the received items,
   * then move to INSPECTED and ask the vendor for handling instructions.
   * No disposition or money here.
   */
  @Post(":id/inspect")
  @HttpCode(HttpStatus.OK)
  inspect(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(inspectReturnSchema)) body: InspectReturnInput,
  ) {
    return this.returns.adminInspect(user.sub, id, body);
  }

  /**
   * Returns v2 — apply the vendor's disposition (restock/dispose/donate),
   * charge the flat processing fee + any handling cost, and close the
   * return. Requires vendor instructions unless a legal/safety disposal
   * override reason is provided.
   */
  @Post(":id/finalize")
  @HttpCode(HttpStatus.OK)
  finalize(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(finalizeReturnSchema)) body: FinalizeReturnInput,
  ) {
    return this.returns.finalize(user.sub, id, body);
  }

  /**
   * Presign a PUT so the operator can upload a photo of the received
   * items at inspection time (policy: "take and share pictures"). Keys
   * are scoped under admin/returns/<id>.
   */
  @Post(":id/uploads")
  @HttpCode(HttpStatus.OK)
  presignUpload(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(presignReturnUploadSchema)) body: PresignReturnUploadInput,
  ) {
    const key = this.r2.generateKey(`admin/returns/${id}/received`, body.filename);
    return this.r2.presignPut({
      key,
      contentType: body.contentType,
      contentLengthBytes: body.contentLengthBytes,
    });
  }
}
