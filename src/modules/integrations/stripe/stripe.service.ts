/**
 * StripeService — wraps the Stripe SDK with our domain operations.
 *
 *   createPaymentIntent({ vendorId, netAmountCents, idempotencyKey })
 *   verifyWebhook(rawBody, signature)
 *
 * Implementation Plan §6.5.1, §14.2.
 *
 * Gross-up math: the payer covers Stripe's processing fee, so the wallet
 * credit (or the net the platform keeps) equals the requested amount.
 *
 *   gross = (net + fixed) / (1 - percent)   — rounded UP to the nearest cent.
 *
 * Rate: our customers frequently pay with INTERNATIONAL cards (e.g. Ghana,
 * Nigeria), which Stripe charges more for — the standard 2.9% PLUS a 1.5%
 * international-card fee ≈ 4.4% + $0.30. If we grossed up at only the 2.9%
 * domestic rate, every international deposit would come up ~1.5% short and
 * the platform would silently absorb it. So we gross up at the international
 * rate (with a small cushion) — the payer covers all fees, and the platform
 * is never short. Domestic cards net a few cents over target (kept by the
 * platform), which is the acceptable trade-off for not being able to know
 * the card's country before the charge is created.
 *
 * Wallet credit happens ONLY in the webhook handler — never from the API call.
 * This avoids double-credits when a 3DS step puts the intent in
 * `requires_action` for several minutes.
 */

import { Injectable, Logger } from "@nestjs/common";
import Stripe from "stripe";

import { loadConfig } from "../../../common/config";

// International-card rate: Stripe 2.9% + 1.5% (international) = 4.4%, plus a
// 0.1% cushion so rounding/variance never leaves the platform short. Fixed
// fee stays $0.30. Bump toward ~5.4% if you also need to cover Stripe's +1%
// currency-conversion fee for cards Stripe converts.
const STRIPE_PERCENT = 0.045;
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

// ---------------------------------------------------------------------------
// Personal Shopper checkout types
// ---------------------------------------------------------------------------

export interface CreateShopperIntakeSessionArgs {
  /** Shopper request id — surfaced in metadata + success URL. */
  requestId: string;
  /** Buyer email — used as customer_email + receipt destination. */
  buyerEmail: string;
  /** Sum of buyer estimates in cents (the items line). */
  itemsSubtotalCents: number;
  /** Platform commission in cents (the service-fee line). */
  commissionCents: number;
  /**
   * Estimated U.S. sales tax in cents (the tax line). Zero collapses the
   * line item to a $0 entry which Stripe rejects, so the service drops it
   * silently when zero — buyer's checkout still shows the right total.
   */
  estimatedTaxCents: number;
  /**
   * Tax state (e.g. "TX") + rate in basis points (e.g. 825 = 8.25%), used to
   * label the tax line as "TX sales tax (8.25%)". Optional — when absent the
   * tax line falls back to a generic "Sales tax" label.
   */
  taxState?: string | null;
  taxRateBps?: number;
  /** Idempotency key — typically `shopper:intake:<requestId>`. */
  idempotencyKey: string;
  /** Where Stripe sends the buyer after success — must include {CHECKOUT_SESSION_ID}. */
  successUrl: string;
  /** Where Stripe sends the buyer if they cancel checkout. */
  cancelUrl: string;
}

export interface CreateShopperFollowupSessionArgs {
  requestId: string;
  buyerEmail: string;
  /**
   * Signed amount cents: must be > 0 for a Checkout session. Negative deltas
   * use `refundShopperIntake` instead.
   */
  amountCents: number;
  /** Optional pretty description for the line item ("Items adjustment + shipping"). */
  description?: string;
  idempotencyKey: string;
  successUrl: string;
  cancelUrl: string;
}

export interface RefundShopperIntakeArgs {
  /** PaymentIntent id captured at intake. */
  paymentIntentId: string;
  /** Always positive cents — the refund magnitude (caller flips the sign). */
  amountCents: number;
  /** Tag the refund with the request id for cross-checking. */
  requestId: string;
  /** Idempotency key — typically `shopper:refund:<requestId>`. */
  idempotencyKey: string;
  /** Free text — appears on the buyer's bank statement reference. */
  reason?: "duplicate" | "fraudulent" | "requested_by_customer";
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

  /** True when a Stripe API key is configured (card payments are possible). */
  isConfigured(): boolean {
    return this.stripe !== null;
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

  // ---------------------------------------------------------------------------
  // Personal Shopper — Checkout Sessions + Refunds
  // ---------------------------------------------------------------------------

  /**
   * Build the buyer-facing service-fee + tax line-item names with their exact
   * rates, e.g. "Service fee (10%)" and "TX sales tax (8.25%)". The service
   * rate is derived from commission ÷ items so it always matches the charge;
   * the tax state + rate come from the request when available.
   */
  private shopperFeeLineNames(args: {
    itemsSubtotalCents: number;
    commissionCents: number;
    taxState?: string | null;
    taxRateBps?: number;
  }): { service: string; tax: string } {
    const fmtPct = (p: number): string => Number(p.toFixed(2)).toString();
    const servicePct =
      args.itemsSubtotalCents > 0 ? (args.commissionCents / args.itemsSubtotalCents) * 100 : 0;
    const service = `Service fee (${fmtPct(servicePct)}%)`;
    const rate = typeof args.taxRateBps === "number" ? ` (${fmtPct(args.taxRateBps / 100)}%)` : "";
    const tax = args.taxState ? `${args.taxState} sales tax${rate}` : `Sales tax${rate}`;
    return { service, tax };
  }

  /**
   * Create a Checkout Session for the buyer's intake payment.
   *
   * NOTE (May 2026): The buyer-facing intake flow has moved to manual
   * payment rails (wire / ACH / Zelle / CashApp) and no longer routes
   * through Stripe. This method is retained for any legacy code paths
   * that may still call it but is not used by the new shopper flow.
   *
   * Two line items are presented separately so the buyer's receipt
   * clearly shows what they're paying the platform vs. what's being
   * held against their items. The actual items are NOT a Stripe product
   * — Stripe never sees the merchandise URLs, only the totals.
   *
   * Returns the session id + the hosted Checkout URL. The caller
   * persists the session id on the ShopperRequest before redirecting.
   */
  async createShopperIntakeSession(args: CreateShopperIntakeSessionArgs): Promise<{
    sessionId: string;
    paymentIntentId: string | null;
    url: string;
  }> {
    if (!this.stripe) throw new Error("Stripe is not configured.");
    if (!Number.isInteger(args.itemsSubtotalCents) || args.itemsSubtotalCents <= 0) {
      throw new Error("itemsSubtotalCents must be a positive integer.");
    }
    if (!Number.isInteger(args.commissionCents) || args.commissionCents < 0) {
      throw new Error("commissionCents must be a non-negative integer.");
    }

    // Build line items, dropping any zero-amount entries — Stripe rejects
    // a line with `unit_amount: 0`. Tax can legitimately be zero in dev or
    // for tax-free states; commission too if the operator sets the rate
    // to 0%. Items must always be > 0 (validated above).
    const feeNames = this.shopperFeeLineNames(args);
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: args.itemsSubtotalCents,
          product_data: { name: "Items (estimate, charged at procurement)" },
        },
      },
    ];
    if (args.commissionCents > 0) {
      lineItems.push({
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: args.commissionCents,
          product_data: { name: feeNames.service },
        },
      });
    }
    if (args.estimatedTaxCents > 0) {
      lineItems.push({
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: args.estimatedTaxCents,
          product_data: {
            name: feeNames.tax,
          },
        },
      });
    }


    const session = await this.stripe.checkout.sessions.create(
      {
        mode: "payment",
        customer_email: args.buyerEmail,
        // We don't enable Link / wallets explicitly — Stripe's defaults
        // surface what's available in the buyer's region.
        payment_method_types: ["card"],
        line_items: lineItems,
        // The webhook handler reads these to identify which request was paid.
        metadata: {
          purpose: "shopper.intake",
          shopperRequestId: args.requestId,
        },
        payment_intent_data: {
          // Mirror the metadata onto the underlying PaymentIntent so refund
          // and dispute webhooks can also find the request id without a
          // session lookup.
          metadata: {
            purpose: "shopper.intake",
            shopperRequestId: args.requestId,
          },
          description: `USA Errands shopper intake · ${args.requestId}`,
        },
        success_url: args.successUrl,
        cancel_url: args.cancelUrl,
        // Buyers don't have accounts — let them enter shipping themselves
        // on the form, not in Stripe Checkout.
        billing_address_collection: "auto",
      },
      { idempotencyKey: args.idempotencyKey },
    );

    return {
      sessionId: session.id,
      paymentIntentId:
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : session.payment_intent?.id ?? null,
      url: session.url ?? "",
    };
  }

  /**
   * Create a Checkout Session for a buyer who picks "card" at the manual-
   * payment picker. Unlike the legacy intake session above, the buyer here
   * covers the Stripe processing fee: we gross up (items + commission + tax)
   * with the same 2.9% + $0.30 math the wallet funding uses, and surface the
   * fee as its own line so the buyer sees exactly what they're paying.
   *
   * Carries `purpose: "shopper.card_intake"` so the webhook routes it to the
   * card-confirm path (which lands the request straight in PROCURING, the
   * same place an admin-confirmed wire lands it).
   */
  async createShopperCardIntakeSession(args: CreateShopperIntakeSessionArgs): Promise<{
    sessionId: string;
    paymentIntentId: string | null;
    url: string;
    grossAmountCents: number;
    processorFeeCents: number;
  }> {
    if (!this.stripe) throw new Error("Stripe is not configured.");
    if (!Number.isInteger(args.itemsSubtotalCents) || args.itemsSubtotalCents <= 0) {
      throw new Error("itemsSubtotalCents must be a positive integer.");
    }
    if (!Number.isInteger(args.commissionCents) || args.commissionCents < 0) {
      throw new Error("commissionCents must be a non-negative integer.");
    }

    // Net is what the platform must net after Stripe's cut. The processor fee
    // is the difference the buyer pays on top.
    const netCents = args.itemsSubtotalCents + args.commissionCents + args.estimatedTaxCents;
    const { processorFeeCents } = StripeService.grossUpCents(netCents);

    const feeNames = this.shopperFeeLineNames(args);
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: args.itemsSubtotalCents,
          product_data: { name: "Items (estimate, charged at procurement)" },
        },
      },
    ];
    if (args.commissionCents > 0) {
      lineItems.push({
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: args.commissionCents,
          product_data: { name: feeNames.service },
        },
      });
    }
    if (args.estimatedTaxCents > 0) {
      lineItems.push({
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: args.estimatedTaxCents,
          product_data: {
            name: feeNames.tax,
          },
        },
      });
    }
    // Processor fee always > 0 (gross-up adds at least the $0.30 fixed part).
    lineItems.push({
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: processorFeeCents,
        product_data: { name: "Card processing fee" },
      },
    });

    const metadata = {
      purpose: "shopper.card_intake",
      shopperRequestId: args.requestId,
    };
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: "payment",
        customer_email: args.buyerEmail,
        payment_method_types: ["card"],
        line_items: lineItems,
        metadata,
        payment_intent_data: {
          metadata,
          description: `USA Errands shopper card intake · ${args.requestId}`,
        },
        success_url: args.successUrl,
        cancel_url: args.cancelUrl,
        billing_address_collection: "auto",
      },
      { idempotencyKey: args.idempotencyKey },
    );

    return {
      sessionId: session.id,
      paymentIntentId:
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : session.payment_intent?.id ?? null,
      url: session.url ?? "",
      grossAmountCents: netCents + processorFeeCents,
      processorFeeCents,
    };
  }

  /**
   * Create a Checkout Session for the buyer's follow-up payment (positive
   * delta — when actual items + shipping exceeded the intake estimate).
   */
  async createShopperFollowupSession(args: CreateShopperFollowupSessionArgs): Promise<{
    sessionId: string;
    paymentIntentId: string | null;
    url: string;
  }> {
    if (!this.stripe) throw new Error("Stripe is not configured.");
    if (!Number.isInteger(args.amountCents) || args.amountCents <= 0) {
      throw new Error("amountCents must be a positive integer for a follow-up Checkout session.");
    }

    const session = await this.stripe.checkout.sessions.create(
      {
        mode: "payment",
        customer_email: args.buyerEmail,
        payment_method_types: ["card"],
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: args.amountCents,
              product_data: { name: args.description ?? "Adjustment + shipping" },
            },
          },
        ],
        metadata: {
          purpose: "shopper.followup",
          shopperRequestId: args.requestId,
        },
        payment_intent_data: {
          metadata: {
            purpose: "shopper.followup",
            shopperRequestId: args.requestId,
          },
          description: `USA Errands shopper follow-up · ${args.requestId}`,
        },
        success_url: args.successUrl,
        cancel_url: args.cancelUrl,
      },
      { idempotencyKey: args.idempotencyKey },
    );
    return {
      sessionId: session.id,
      paymentIntentId:
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : session.payment_intent?.id ?? null,
      url: session.url ?? "",
    };
  }

  /**
   * Migration 0027 — Stripe Checkout session for the shipping-only
   * invoice the buyer pays after admin sets the freight cost. Same
   * shape as the follow-up session but with `purpose: shopper.shipping`
   * so the webhook handler can branch on it. Always single-line-item
   * (the shipping charge) since the receipt panel in the chat thread
   * already shows the full breakdown.
   */
  async createShopperShippingSession(args: CreateShopperFollowupSessionArgs): Promise<{
    sessionId: string;
    paymentIntentId: string | null;
    url: string;
    grossAmountCents: number;
    processorFeeCents: number;
  }> {
    if (!this.stripe) throw new Error("Stripe is not configured.");
    if (!Number.isInteger(args.amountCents) || args.amountCents <= 0) {
      throw new Error("amountCents must be a positive integer for a shipping Checkout session.");
    }

    // The buyer covers Stripe's processing fee on company-freight shipping —
    // same gross-up math as wallet funding. The shipping cost is the net the
    // platform must receive; the fee is surfaced as its own line so the buyer
    // sees exactly what they're paying.
    const { processorFeeCents } = StripeService.grossUpCents(args.amountCents);

    const session = await this.stripe.checkout.sessions.create(
      {
        mode: "payment",
        customer_email: args.buyerEmail,
        payment_method_types: ["card"],
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: args.amountCents,
              product_data: { name: args.description ?? "Shipping & handling" },
            },
          },
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: processorFeeCents,
              product_data: { name: "Card processing fee" },
            },
          },
        ],
        metadata: {
          purpose: "shopper.shipping",
          shopperRequestId: args.requestId,
        },
        payment_intent_data: {
          metadata: {
            purpose: "shopper.shipping",
            shopperRequestId: args.requestId,
          },
          description: `USA Errands shopper shipping · ${args.requestId}`,
        },
        success_url: args.successUrl,
        cancel_url: args.cancelUrl,
      },
      { idempotencyKey: args.idempotencyKey },
    );
    return {
      sessionId: session.id,
      paymentIntentId:
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : session.payment_intent?.id ?? null,
      url: session.url ?? "",
      grossAmountCents: args.amountCents + processorFeeCents,
      processorFeeCents,
    };
  }

  /**
   * Issue a refund against the original intake PaymentIntent. Used when:
   *   - actual items + shipping came in UNDER the intake estimate, OR
   *   - the request is being cancelled with `issueRefund=true`.
   *
   * Returns the Refund id; caller persists it on the ShopperRequest.
   */
  async refundShopperIntake(args: RefundShopperIntakeArgs): Promise<{ refundId: string }> {
    if (!this.stripe) throw new Error("Stripe is not configured.");
    if (!Number.isInteger(args.amountCents) || args.amountCents <= 0) {
      throw new Error("amountCents must be a positive integer.");
    }

    const refund = await this.stripe.refunds.create(
      {
        payment_intent: args.paymentIntentId,
        amount: args.amountCents,
        reason: args.reason,
        metadata: {
          purpose: "shopper.refund",
          shopperRequestId: args.requestId,
        },
      },
      { idempotencyKey: args.idempotencyKey },
    );

    return { refundId: refund.id };
  }

  /**
   * Sum the cents already refunded against a PaymentIntent. Used by the
   * cancel-with-refund path to compute the *remaining* refundable amount,
   * so a previous partial refund (from the negative-followup branch, a
   * support-issued refund from the Stripe Dashboard, or a dispute) doesn't
   * cause a 4xx when we try to refund again.
   *
   * Counts both `succeeded` and `pending` refunds — pending ones reserve
   * the funds even if they haven't fully settled at the bank yet, so
   * trying to refund the "remaining" again would race and fail.
   *
   * Returns 0 if Stripe isn't configured (dev) or the intent has no refunds.
   */
  async getRefundedAmountForIntent(paymentIntentId: string): Promise<number> {
    if (!this.stripe) return 0;
    let total = 0;
    // The list endpoint returns up to 100 per page. In practice a single
    // intent rarely has more than a couple of refunds; we still iterate
    // pages defensively in case a buyer racks up many. Hard cap at 50
    // pages (5,000 refunds) so a misbehaving response can't loop forever.
    let startingAfter: string | undefined;
    let hasMore = true;
    for (let page = 0; page < 50 && hasMore; page++) {
      const res = await this.stripe.refunds.list({
        payment_intent: paymentIntentId,
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      for (const r of res.data) {
        if (r.status === "succeeded" || r.status === "pending") {
          total += r.amount;
        }
      }
      hasMore = res.has_more;
      const last = res.data[res.data.length - 1];
      startingAfter = last?.id;
      if (!last) break;
    }
    return total;
  }

  /**
   * Verify the Stripe webhook signature. Throws on tamper or expired timestamp.
   * Returns the parsed Stripe event on success.
   */
  /**
   * Expire a Checkout session early so any outstanding pay-link the
   * buyer might still hold becomes inert. Best-effort: returns `false`
   * (and never throws) when the session has already expired, been
   * completed, or doesn't exist. Used by the shopper shipping-invoice
   * flow (security audit M-3) to invalidate an old session whenever
   * admin re-saves the form with a different amount.
   */
  async expireCheckoutSession(sessionId: string): Promise<boolean> {
    if (!this.stripe) return false;
    if (!sessionId) return false;
    try {
      await this.stripe.checkout.sessions.expire(sessionId);
      return true;
    } catch (err) {
      // Common no-op cases: session already expired, already complete,
      // or unknown id. We log at debug rather than warn — for the
      // re-save path, "no old session to expire" is the happy path.
      this.logger.debug(
        { err: (err as Error).message, sessionId },
        "stripe.checkout.expire_session_failed",
      );
      return false;
    }
  }

  verifyWebhook(rawBody: Buffer | string, signature: string | undefined): Stripe.Event {
    if (!this.stripe) throw new Error("Stripe is not configured.");
    if (!this.webhookSecret) {
      const cfg = loadConfig();
      // Security audit M-1 — only bypass the signature check in
      // `development`. Previously the bypass triggered for anything
      // that wasn't strictly `production`, which left staging / test /
      // CI exposed if the secret happened to be unset. Real non-dev
      // environments must have a real `whsec_…` secret configured.
      if (cfg.NODE_ENV !== "development") {
        throw new Error(
          "STRIPE_WEBHOOK_SECRET is required outside of development. " +
            "Set it in the environment before accepting webhook traffic.",
        );
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
