/**
 * Held-order sweep — hourly safety net for storefront orders parked in
 * ON_HOLD waiting on something that has since arrived.
 *
 * Three self-healing reasons are swept:
 *   - INSUFFICIENT_FUNDS: the Stripe deposit webhook already releases funded
 *     holds the instant a top-up lands; this covers the gaps that path can't
 *     (admin manual credits, a missed / delayed webhook).
 *   - INSUFFICIENT_STOCK: the PSN-receive flow releases stock holds inline the
 *     moment inventory lands; this covers restock via admin SKU adjustment, a
 *     failed inline release, or any other path that raises stock.
 *   - UNMAPPED_SKU: resolves when the vendor creates the product or maps its
 *     code/storeSku to the one the storefront sends. The product create/update
 *     flow releases these inline; this sweep is the backstop so an order placed
 *     before its product existed self-heals within the hour.
 *
 * Re-running allocation under a row lock places every order now resolvable.
 * ADDRESS_INVALID holds still need a human (fix the address) and are not swept.
 */

import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";

import { PrismaService } from "../../common/prisma.service";
import { IntegrationOrderService } from "../integration/integration-order.service";

@Injectable()
export class HeldOrderSweepJob {
  private readonly logger = new Logger(HeldOrderSweepJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly integrationOrders: IntegrationOrderService,
  ) {}

  /** Top of every hour. */
  @Cron("0 * * * *", { name: "held-order-sweep", timeZone: "UTC" })
  async run(): Promise<void> {
    const vendors = await this.prisma.order.findMany({
      where: {
        status: "ON_HOLD",
        holdReason: { in: ["INSUFFICIENT_FUNDS", "INSUFFICIENT_STOCK", "UNMAPPED_SKU"] },
      },
      distinct: ["vendorId"],
      select: { vendorId: true },
    });
    if (vendors.length === 0) return;

    this.logger.log({ vendorCount: vendors.length }, "Held-order sweep starting.");
    let released = 0;
    for (const { vendorId } of vendors) {
      try {
        // Funds first (wallet-gated, stops at the balance), then the
        // product/SKU-gated reasons (unmapped + stock), which are independent
        // per order. Both are best-effort and isolated per vendor.
        released += await this.integrationOrders.releaseFundedHoldsForVendor(vendorId);
        released += await this.integrationOrders.releaseResolvableHoldsForVendor(vendorId);
      } catch (err) {
        this.logger.warn({ err, vendorId }, "Sweep release failed for vendor.");
      }
    }
    if (released > 0) this.logger.log({ released }, "Held-order sweep released orders.");
  }
}
