/**
 * StripeService — wraps the Stripe SDK with our domain operations.
 *
 *   createPaymentIntent({ vendorId, netAmountCents, idempotencyKey })
 *   verifyWebhook(rawBody, signature)
 *
 * Implementation Plan §6.5.1, §14.2.
 *
 * Gross-up math: Stripe takes 2.9% + $0.30 per successful charge. Per
 * PRD §6.5.4 the platform passes those fees to the vendor by grossing up the
 * charged amount so the wallet credit equals the requested net.
 *
 *   gross = (net + 30) / (1 - 0.029)
 *
 * Rounded UP to the nearest cent. The vendor sees the gross at checkout; the
 * wallet credit is exactly `net` once the webhook confirms.
 *
 * Wallet credit happens ONLY in the webhook handler — never from the API call.
 * This avoids double-credits when a 3DS step puts the intent in
 * `requires_action` for several minutes.
 */

import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";

import { loadConfig } from "../../../common/config";

const STRIPE_PERCENT = 0.029;
const STRIPE_FIXED_CENTS = 30;

export interface CreatePaymentIntentArgs {
  vendorId: string;
  /** Net cents the vendor wants in their wallet after the deposit. */
  netAmountCents: number;
  /** Stripe idempotency key (UUID). */
  idempotencyKey: string;
  /** Vendor email for receipts (Stripe will send the receipt directly). */
  receiptEmail?: string;
}

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private readonly stripe: Stripe | null;
  private readonly webhookSecret: string;

  constructor() {
    const cfg = loadConfig();
    const apiKey = process.env.STRIPE_SECRET_KEY ?? "";
    this.webhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? "";

    if (!apiKey) {
      if (cfg.NODE_ENV === "production") {
        throw new Error("STRIPE_SECRET_KEY is required in production.");
      }
      this.logger.warn("STRIPE_SECRET_KEY not set — Stripe calls will throw until configured.");
      this.stripe = null;
    } else {
      // Omit `apiVersion` so the SDK uses its own pinned default. Pinning a
      // string here means every `stripe` package upgrade has to land in
      // lockstep; trusting the SDK's pin is the lower-risk default.
      this.stripe = new Stripe(apiKey, {
        appInfo: { name: "usa-errands", version: "0.1.0" },
        timeout: 10_000,
        maxNetworkRetries: 2,
      });
    }
  }

  /**
   * Compute the gross-up amount, rounded up to the nearest cent.
   * Pure function — no Stripe call. Exposed as a static helper so unit tests
   * verify the math without a live Stripe client.
   */
  static grossUpCents(netCents: number): { grossCents: number; processorFeeCents: number } {
    if (!Number.isInteger(netCents) || netCents <= 0) {
      throw new Error("netCents must be a positive integer.");
    }
    const grossExact = (netCents + STRIPE_FIXED_CENTS) / (1 - STRIPE_PERCENT);
    const grossCents = Math.ceil(grossExact);
    const processorFeeCents = grossCents - netCents;
    return { grossCents, processorFeeCents };
  }

  /**
   * Create a payment intent for `netAmountCents` after gross-up. Returns the
   * client_secret for Stripe Elements + the gross amount + processor fee
   * snapshot so the UI can display "you pay $X" / "you receive $Y".
   */
  async createPaymentIntent(args: CreatePaymentIntentArgs): Promise<{
    clientSecret: string;
    paymentIntentId: string;
    grossAmountCents: number;
    netAmountCents: number;
    processorFeeCents: number;
  }> {
    if (!this.stripe) throw new Error("Stripe is not configured.");
    const { grossCents, processorFeeCents } = StripeService.grossUpCents(args.netAmountCents);

    const intent = await this.stripe.paymentIntents.create(
      {
        amount: grossCents,
        currency: "usd",
        // Wallet funding never has a customer's card saved — they fund via card on each call.
        automatic_payment_methods: { enabled: true },
        receipt_email: args.receiptEmail,
        // The webhook handler reads these to know who to credit.
        metadata: {
          vendorId: args.vendorId,
          netAmountCents: String(args.netAmountCents),
          processorFeeCents: String(processorFeeCents),
          purpose: "wallet.fund",
        },
        description: `USA Errands wallet deposit — ${args.netAmountCents / 100} USD net`,
      },
      { idempotencyKey: args.idempotencyKey },
    );

    return {
      clientSecret: intent.client_secret ?? "",
      paymentIntentId: intent.id,
      grossAmountCents: grossCents,
      netAmountCents: args.netAmountCents,
      processorFeeCents,
    };
  }

  /**
   * Verify the Stripe webhook signature. Throws on tamper or expired timestamp.
   * Returns the parsed Stripe event on success.
   */
  verifyWebhook(rawBody: Buffer | string, signature: string | undefined): Stripe.Event {
    if (!this.stripe) throw new Error("Stripe is not configured.");
    if (!this.webhookSecret) {
      const cfg = loadConfig();
      if (cfg.NODE_ENV === "production") {
        throw new Error("STRIPE_WEBHOOK_SECRET is required in production.");
      }
      this.logger.warn("STRIPE_WEBHOOK_SECRET not set — accepting unsigned webhook (dev only).");
      return JSON.parse(typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")) as Stripe.Event;
    }
    if (!signature) {
      throw new Error("Missing Stripe-Signature header.");
    }
    return this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
  }
}
