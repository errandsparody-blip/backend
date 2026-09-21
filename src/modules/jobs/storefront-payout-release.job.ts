/**
 * Storefront held-payout release sweep (Migration 0071, delayed payout).
 *
 * Under collect-then-payout with return-window holds, each vendor's product
 * share is HELD on the platform balance until their return window elapses, so
 * refunds during the window are instant and clawback-free. This sweep releases
 * (pays out) HELD shares whose window has passed and that have no open return.
 * Runs hourly; idempotent (each transfer is keyed on the sub-order reference).
 */
import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";

import { StorefrontOrderService } from "../storefront/storefront-order.service";

@Injectable()
export class StorefrontPayoutReleaseJob {
  private readonly logger = new Logger(StorefrontPayoutReleaseJob.name);

  constructor(private readonly orders: StorefrontOrderService) {}

  @Cron("15 * * * *", { name: "storefront-payout-release", timeZone: "UTC" })
  async run(): Promise<void> {
    try {
      const released = await this.orders.releaseHeldPayouts();
      if (released > 0) {
        this.logger.log({ released }, "Storefront held-payout release sweep ran.");
      }
    } catch (err) {
      this.logger.warn({ err: `${err}` }, "Storefront held-payout release sweep failed.");
    }
  }
}
