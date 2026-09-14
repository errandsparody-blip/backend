/**
 * Admin view + actions on storefront orders (Migration 0059) — records across
 * all vendors, plus admin-initiated refunds.
 *
 *   GET  /v1/admin/storefront/orders?status=PAID
 *   POST /v1/admin/storefront/orders/:reference/refund      { amountCents? }
 *   GET  /v1/admin/storefront/orders/payouts/failed         — unified-cart payout failures
 *   POST /v1/admin/storefront/orders/:reference/payout/retry
 *   POST /v1/admin/storefront/orders/reservations/sweep      { maxAgeMinutes? } — release abandoned-cart stock now
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

import { StorefrontCheckoutService } from "./storefront-checkout.service";
import { StorefrontOrderService } from "./storefront-order.service";

const refundSchema = z.object({
  amountCents: z.number().int().positive().max(100_000_000).optional(),
});
type RefundInput = z.infer<typeof refundSchema>;

// Manual abandoned-cart sweep. The floor of 5 minutes stops an operator from
// releasing stock out from under a buyer who is mid-payment on the hosted
// checkout page (a redirect that legitimately takes a couple of minutes).
const sweepSchema = z.object({
  maxAgeMinutes: z.number().int().min(5).max(1440).optional(),
});
type SweepInput = z.infer<typeof sweepSchema>;

@Controller({ path: "admin/storefront/orders", version: "1" })
@Roles(Role.SUPER_ADMIN, Role.FINANCE_ADMIN, Role.WAREHOUSE_OPERATOR)
export class AdminStorefrontOrderController {
  constructor(
    private readonly orders: StorefrontOrderService,
    private readonly checkout: StorefrontCheckoutService,
  ) {}

  @Get()
  list(@Query("status") status?: string) {
    return this.orders.adminList({ status: status?.trim() || undefined });
  }

  /** Unified-cart sub-orders whose vendor payout failed — for admin follow-up. */
  @Get("payouts/failed")
  failedPayouts() {
    return this.orders.listFailedPayouts();
  }

  /**
   * Release stock held by abandoned (still-unpaid) checkouts right now, instead
   * of waiting for the 5-minute background sweep. Handy after a burst of test
   * checkouts leaves a product hidden from the storefront (available − reserved
   * hit zero). Returns how many orders were released.
   */
  @Post("reservations/sweep")
  @HttpCode(HttpStatus.OK)
  async sweepReservations(
    @Body(new ZodValidationPipe(sweepSchema)) body: SweepInput,
  ): Promise<{ released: number }> {
    const released = await this.checkout.sweepAbandonedReservations(body.maxAgeMinutes ?? 20);
    return { released };
  }

  /** Retry a failed vendor payout (finance-gated — it moves money). */
  @Post(":reference/payout/retry")
  @Roles(Role.SUPER_ADMIN, Role.FINANCE_ADMIN)
  @HttpCode(HttpStatus.OK)
  retryPayout(@Param("reference") reference: string) {
    return this.orders.retryPayout(reference);
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
