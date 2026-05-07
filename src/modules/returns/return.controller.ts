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
  listReturnsSchema,
  type CreateReturnInput,
  type ListReturnsInput,
} from "../../common/schemas/return.schema";

import { ReturnService } from "./return.service";

@Controller({ path: "returns", version: "1" })
@Roles(Role.VENDOR, Role.VENDOR_SUB_USER)
@UseGuards(TenantGuard)
export class ReturnController {
  constructor(private readonly returns: ReturnService) {}

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
  get(@CurrentUser() user: AuthenticatedUser, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.returns.get(user.vendorId!, id);
  }

  @Post(":id/cancel")
  @HttpCode(HttpStatus.OK)
  cancel(@CurrentUser() user: AuthenticatedUser, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.returns.cancel(user.vendorId!, user.sub, id);
  }
}
