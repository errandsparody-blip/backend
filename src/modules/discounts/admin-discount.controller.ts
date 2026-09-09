/**
 * Super-admin marketplace discount codes (Migration 0059, Layer 8).
 * A marketplace code applies to ALL vendors, or a targeted subset.
 *
 *   POST   /v1/admin/marketplace/discounts       — create a marketplace code
 *   GET    /v1/admin/marketplace/discounts       — list marketplace codes
 *   DELETE /v1/admin/marketplace/discounts/:id   — deactivate
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
} from "@nestjs/common";
import { Role } from "@prisma/client";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  createMarketplaceDiscountSchema,
  type CreateMarketplaceDiscountInput,
} from "../../common/schemas/discount.schema";

import { DiscountService } from "./discount.service";

@Controller({ path: "admin/marketplace/discounts", version: "1" })
@Roles(Role.SUPER_ADMIN)
export class AdminDiscountController {
  constructor(private readonly discounts: DiscountService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createMarketplaceDiscountSchema))
    body: CreateMarketplaceDiscountInput,
  ) {
    return this.discounts.createMarketplaceCode(user.sub, body);
  }

  @Get()
  list() {
    return this.discounts.listMarketplaceCodes();
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  async deactivate(@Param("id", new ParseUUIDPipe()) id: string) {
    await this.discounts.deactivateMarketplaceCode(id);
    return { ok: true };
  }
}
