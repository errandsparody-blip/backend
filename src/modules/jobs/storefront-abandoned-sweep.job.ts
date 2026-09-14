/**
 * Storefront abandoned-cart sweep (Migration 0059) — safety net.
 *
 * Checkout reserves stock the instant an order row is written; if the buyer
 * never completes payment, that inventory would stay reserved forever — and
 * because the catalog hides any product whose (available − reserved) drops to
 * zero, an abandoned cart makes the product vanish from the storefront until
 * its reservation is released. This releases + cancels any PENDING_PAYMENT
 * storefront order older than the threshold. Guarded so it can never cancel an
 * order a webhook just paid.
 *
 * Runs every 5 minutes so an abandoned checkout frees its stock quickly instead
 * of the product staying hidden for the better part of an hour.
 */
import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";

import { StorefrontCheckoutService } from "../storefront/storefront-checkout.service";

/**
 * Unpaid orders older than this are considered abandoned and their reserved
 * stock is released. Kept comfortably longer than a realistic hosted-checkout
 * completion (a buyer redirected to Stripe/Flutterwave pays within a few
 * minutes) but short enough that an abandoned cart frees stock quickly instead
 * of hiding a product from the storefront for an hour.
 */
const ABANDON_AFTER_MINUTES = 20;

@Injectable()
export class StorefrontAbandonedSweepJob {
  private readonly logger = new Logger(StorefrontAbandonedSweepJob.name);

  constructor(private readonly checkout: StorefrontCheckoutService) {}

  @Cron("*/5 * * * *", { name: "storefront-abandoned-sweep", timeZone: "UTC" })
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
