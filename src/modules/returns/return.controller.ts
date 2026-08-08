/**
 * Vendor-facing return endpoints. Implementation Plan §6.7.
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
  UseGuards,
} from "@nestjs/common";
import { Role } from "@prisma/client";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { TenantGuard } from "../../common/guards/tenant.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  createReturnSchema,
  instructReturnSchema,
  listReturnsSchema,
  presignReturnUploadSchema,
  type CreateReturnInput,
  type InstructReturnInput,
  type ListReturnsInput,
  type PresignReturnUploadInput,
} from "../../common/schemas/return.schema";
import { R2Service } from "../integrations/r2/r2.service";

import { ReturnService } from "./return.service";

@Controller({ path: "returns", version: "1" })
@Roles(Role.VENDOR, Role.VENDOR_SUB_USER)
@UseGuards(TenantGuard)
export class ReturnController {
  constructor(
    private readonly returns: ReturnService,
    private readonly r2: R2Service,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createReturnSchema)) body: CreateReturnInput,
  ) {
    return this.returns.create(user.vendorId!, user.sub, body);
  }

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(listReturnsSchema)) q: ListReturnsInput,
  ) {
    return this.returns.list(user.vendorId!, q);
  }

  @Get(":id")
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    return this.returns.get(user.vendorId!, id);
  }

  @Post(":id/cancel")
  @HttpCode(HttpStatus.OK)
  cancel(@CurrentUser() user: AuthenticatedUser, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.returns.cancel(user.vendorId!, user.sub, id);
  }

  /**
   * Returns v2 — vendor submits handling instructions (restock / dispose
   * / donate per line) after USA Errands has inspected the items and
   * shared photos. Only valid while the return is INSPECTED.
   */
  @Post(":id/instructions")
  @HttpCode(HttpStatus.OK)
  instruct(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(instructReturnSchema)) body: InstructReturnInput,
  ) {
    return this.returns.submitInstructions(user.vendorId!, user.sub, id, body);
  }

  /**
   * Presign a single PUT for a return-attachment upload. Used by the
   * AttachmentUploader on the request-return form so vendors can drop
   * photos / receipts at RMA-creation time. Tenant-scoped via the
   * outer @Roles + @UseGuards(TenantGuard); the key prefix scopes
   * objects to this vendor so cross-tenant key collisions are
   * impossible even if R2 keys leak.
   */
  @Post("uploads")
  @HttpCode(HttpStatus.OK)
  async presignUpload(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(presignReturnUploadSchema)) body: PresignReturnUploadInput,
  ) {
    const key = this.r2.generateKey(`returns/${user.vendorId}/evidence`, body.filename);
    return this.r2.presignPut({
      key,
      contentType: body.contentType,
      contentLengthBytes: body.contentLengthBytes,
    });
  }
}
