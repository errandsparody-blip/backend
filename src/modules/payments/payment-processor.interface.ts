/**
 * PaymentProcessor — the abstraction every storefront payment rail implements
 * (Migration 0059). Stripe Connect and Paystack are the two concrete
 * implementations; the checkout + webhook code depends ONLY on this interface,
 * so adding a rail later is Open/Closed (new class, no caller changes) and each
 * implementation is substitutable (Liskov).
 *
 * Money model: USA Errands never custodies product cash. The buyer pays once;
 * the processor splits so the vendor's connected account receives the product
 * amount directly and USA Errands receives `platformFeeCents` (shipping +
 * fulfillment). All amounts are integer USD cents.
 */

export type ProcessorKey = "STRIPE" | "PAYSTACK";

export type PayoutAccountStatus =
  | "PENDING"
  | "ACTIVE"
  | "RESTRICTED"
  | "DISABLED";

export interface PayoutAccountSnapshot {
  externalAccountId: string;
  status: PayoutAccountStatus;
  detailsSubmitted: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
}

export interface CreateCheckoutArgs {
  /** Storefront order reference (SF-000001) — echoed back on the webhook. */
  reference: string;
  /** Total the buyer pays (product − discount + shipping + tax), in cents. */
  amountCents: number;
  /** Platform share retained by USA Errands (shipping + fulfillment), in cents. */
  platformFeeCents: number;
  currency: string; // "USD"
  /** The vendor's connected destination — Stripe acct_… or Paystack subaccount. */
  vendorExternalAccountId: string;
  buyerEmail: string;
  successUrl: string;
  cancelUrl: string;
  /** Extra metadata mirrored onto the charge for reconciliation. */
  metadata?: Record<string, string>;
}

export interface CheckoutResult {
  /** Hosted page the buyer is redirected to. */
  checkoutUrl: string;
  /** Processor reference/intent id persisted on the storefront order. */
  paymentRef: string;
}

/** Normalised webhook outcome. `paid` is the only event checkout cares about. */
export interface ParsedPaymentEvent {
  type: "paid" | "other";
  /** Storefront order reference carried in metadata. */
  reference: string | null;
  /** Processor payment reference/intent id. */
  paymentRef: string | null;
  amountCents: number | null;
  currency: string | null;
}

export abstract class PaymentProcessor {
  abstract readonly key: ProcessorKey;

  /** True when the processor's credentials are configured in this environment. */
  abstract isConfigured(): boolean;

  /** Create a split checkout session; returns the hosted URL + payment ref. */
  abstract createCheckout(args: CreateCheckoutArgs): Promise<CheckoutResult>;

  /** Read the live status of a connected account (mirrored to our DB). */
  abstract getAccountStatus(externalAccountId: string): Promise<PayoutAccountSnapshot>;

  /**
   * Refund a charge (full or partial). `paymentRef` is the value returned from
   * createCheckout (Stripe PaymentIntent id / Paystack transaction reference).
   * Omit amountCents for a full refund.
   */
  abstract refund(args: {
    paymentRef: string;
    amountCents?: number;
    reason?: string;
  }): Promise<{ refundId: string }>;

  /**
   * Verify the webhook signature and normalise the event. MUST throw when the
   * signature is invalid — the caller treats a thrown error as "reject".
   */
  abstract verifyAndParseWebhook(
    rawBody: Buffer | string,
    signature: string,
  ): ParsedPaymentEvent;
}
