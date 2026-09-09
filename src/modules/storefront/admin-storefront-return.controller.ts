/**
 * Admin storefront returns queue (Migration 0061).
 *
 *   GET  /v1/admin/storefront/returns?status=REQUESTED
 *   POST /v1/admin/storefront/returns/:id/approve   { amountCents? }  → refund
 *   POST /v1/admin/storefront/returns/:id/reject    { note? }
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
import { z } from "zod";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";

import { StorefrontReturnService } from "./storefront-return.service";

const approveSchema = z.object({ amountCents: z.number().int().positive().max(100_000_000).optional() });
const rejectSchema = z.object({ note: z.string().trim().max(1000).optional() });

@Controller({ path: "admin/storefront/returns", version: "1" })
@Roles(Role.SUPER_ADMIN, Role.FINANCE_ADMIN, Role.WAREHOUSE_OPERATOR)
export class AdminStorefrontReturnController {
  constructor(private readonly returns: StorefrontReturnService) {}

  @Get()
  list(@Query("status") status?: string) {
    return this.returns.adminList({ status: status?.trim() || undefined });
  }

  @Post(":id/approve")
  @Roles(Role.SUPER_ADMIN, Role.FINANCE_ADMIN)
  @HttpCode(HttpStatus.OK)
  approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(approveSchema)) body: z.infer<typeof approveSchema>,
  ) {
    return this.returns.approve(id, user.sub, body.amountCents);
  }

  @Post(":id/reject")
  @Roles(Role.SUPER_ADMIN, Role.FINANCE_ADMIN)
  @HttpCode(HttpStatus.OK)
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(rejectSchema)) body: z.infer<typeof rejectSchema>,
  ) {
    return this.returns.reject(id, user.sub, body.note);
  }
}
