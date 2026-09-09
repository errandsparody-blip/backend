/**
 * Storefront abandoned-cart sweep (Migration 0059) — hourly safety net.
 *
 * Checkout reserves stock the instant an order row is written; if the buyer
 * never completes payment, that inventory would stay reserved forever. This
 * releases + cancels any PENDING_PAYMENT storefront order older than the
 * threshold. Guarded so it can never cancel an order a webhook just paid.
 */
import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";

import { StorefrontCheckoutService } from "../storefront/storefront-checkout.service";

/** Unpaid orders older than this are considered abandoned. */
const ABANDON_AFTER_MINUTES = 60;

@Injectable()
export class StorefrontAbandonedSweepJob {
  private readonly logger = new Logger(StorefrontAbandonedSweepJob.name);

  constructor(private readonly checkout: StorefrontCheckoutService) {}

  @Cron("15 * * * *", { name: "storefront-abandoned-sweep", timeZone: "UTC" })
  async run(): Promise<void> {
    try {
      const released = await this.checkout.sweepAbandonedReservations(ABANDON_AFTER_MINUTES);
      if (released > 0) {
        this.logger.log({ released }, "Storefront abandoned-cart sweep released reservations.");
      }
    } catch (err) {
      this.logger.warn({ err: `${err}` }, "Storefront abandoned-cart sweep failed.");
    }
  }
}
