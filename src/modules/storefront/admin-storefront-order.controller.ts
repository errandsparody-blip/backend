/**
 * Admin view + actions on storefront orders (Migration 0059) — records across
 * all vendors, plus admin-initiated refunds.
 *
 *   GET  /v1/admin/storefront/orders?status=PAID
 *   POST /v1/admin/storefront/orders/:reference/refund   { amountCents? }
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { Role } from "@prisma/client";
import { z } from "zod";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";

import { StorefrontOrderService } from "./storefront-order.service";

const refundSchema = z.object({
  amountCents: z.number().int().positive().max(100_000_000).optional(),
});
type RefundInput = z.infer<typeof refundSchema>;

@Controller({ path: "admin/storefront/orders", version: "1" })
@Roles(Role.SUPER_ADMIN, Role.FINANCE_ADMIN, Role.WAREHOUSE_OPERATOR)
export class AdminStorefrontOrderController {
  constructor(private readonly orders: StorefrontOrderService) {}

  @Get()
  list(@Query("status") status?: string) {
    return this.orders.adminList({ status: status?.trim() || undefined });
  }

  // Refunds are finance-gated (warehouse operators can view but not refund).
  @Post(":reference/refund")
  @Roles(Role.SUPER_ADMIN, Role.FINANCE_ADMIN)
  @HttpCode(HttpStatus.OK)
  refund(
    @CurrentUser() user: AuthenticatedUser,
    @Param("reference") reference: string,
    @Body(new ZodValidationPipe(refundSchema)) body: RefundInput,
  ) {
    return this.orders.refund(reference, user.sub, body.amountCents);
  }
}
