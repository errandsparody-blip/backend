/**
 * Storefront failed-payout retry sweep (Migration 0067, unified cart payment).
 *
 * Under collect-then-payout the platform takes one charge then transfers each
 * vendor their share. A transfer can fail transiently (rate limit, momentary
 * account issue); the sub-order is marked payout_status = FAILED. This hourly
 * sweep retries those, bounded per run. Idempotent: each transfer is keyed on
 * the sub-order reference, so a payout that actually went through never
 * double-pays. Admins can also retry manually from the failed-payout view.
 */
import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";

import { StorefrontOrderService } from "../storefront/storefront-order.service";

/** Only retry payouts that have been FAILED for at least this long. */
const RETRY_AFTER_MINUTES = 30;

@Injectable()
export class StorefrontPayoutRetryJob {
  private readonly logger = new Logger(StorefrontPayoutRetryJob.name);

  constructor(private readonly orders: StorefrontOrderService) {}

  @Cron("45 * * * *", { name: "storefront-payout-retry", timeZone: "UTC" })
  async run(): Promise<void> {
    try {
      const attempted = await this.orders.sweepFailedPayouts(RETRY_AFTER_MINUTES);
      if (attempted > 0) {
        this.logger.log({ attempted }, "Storefront failed-payout retry sweep ran.");
      }
    } catch (err) {
      this.logger.warn({ err: `${err}` }, "Storefront failed-payout retry sweep failed.");
    }
  }
}
