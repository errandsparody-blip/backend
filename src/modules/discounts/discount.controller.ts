/**
 * Vendor discount codes (Migration 0059, Layer 8).
 *
 *   POST   /v1/storefront/discounts        — create a code (this vendor's goods)
 *   GET    /v1/storefront/discounts        — list this vendor's codes
 *   DELETE /v1/storefront/discounts/:id    — deactivate a code
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { Role } from "@prisma/client";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { TenantGuard } from "../../common/guards/tenant.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  createVendorDiscountSchema,
  type CreateVendorDiscountInput,
} from "../../common/schemas/discount.schema";

import { DiscountService } from "./discount.service";

@Controller({ path: "storefront/discounts", version: "1" })
@Roles(Role.VENDOR, Role.VENDOR_SUB_USER)
@UseGuards(TenantGuard)
export class DiscountController {
  constructor(private readonly discounts: DiscountService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createVendorDiscountSchema)) body: CreateVendorDiscountInput,
  ) {
    return this.discounts.createVendorCode(user.vendorId!, body);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.discounts.listVendorCodes(user.vendorId!);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  async deactivate(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    await this.discounts.deactivateVendorCode(user.vendorId!, id);
    return { ok: true };
  }
}
