/**
 * Held-order sweep — hourly safety net for storefront orders parked in
 * ON_HOLD with reason INSUFFICIENT_FUNDS (Migration 0038).
 *
 * The Stripe deposit webhook already releases a vendor's funded holds the
 * instant a top-up lands, so in the happy path this job finds nothing. It
 * exists to cover the gaps that path can't: admin manual credits, a missed /
 * delayed webhook, or a credit applied by any future code path. For each
 * vendor with funds holds it re-runs allocation (which re-checks the balance
 * under a row lock), releasing as many as the wallet now covers.
 *
 * Unmapped-SKU / insufficient-stock / address holds are deliberately NOT swept
 * — those need a human (remap, restock, fix address), surfaced in the admin
 * held-orders queue instead.
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
      where: { status: "ON_HOLD", holdReason: "INSUFFICIENT_FUNDS" },
      distinct: ["vendorId"],
      select: { vendorId: true },
    });
    if (vendors.length === 0) return;

    this.logger.log({ vendorCount: vendors.length }, "Held-order sweep starting.");
    let released = 0;
    for (const { vendorId } of vendors) {
      try {
        released += await this.integrationOrders.releaseFundedHoldsForVendor(vendorId);
      } catch (err) {
        this.logger.warn({ err, vendorId }, "Sweep release failed for vendor.");
      }
    }
    if (released > 0) this.logger.log({ released }, "Held-order sweep released orders.");
  }
}
