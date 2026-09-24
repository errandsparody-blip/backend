/**
 * PaymentProcessor — the abstraction every storefront payment rail implements
 * (Migration 0059). Stripe Connect and Flutterwave are the two concrete
 * implementations; the checkout + webhook code depends ONLY on this interface,
 * so adding a rail later is Open/Closed (new class, no caller changes) and each
 * implementation is substitutable (Liskov).
 *
 * Money model: USA Errands never custodies product cash. The buyer pays once;
 * the processor splits so the vendor's connected account receives the product
 * amount directly and USA Errands receives `platformFeeCents` (shipping +
 * fulfillment). All amounts are integer USD cents.
 */

// PAYSTACK is retained in the union for backward compatibility with any historic
// vendor_payout_accounts rows, but it is no longer wired: the African rail is now
// FLUTTERWAVE (one account covers 30+ countries, unlike Paystack's per-country model).
export type ProcessorKey = "STRIPE" | "PAYSTACK" | "FLUTTERWAVE";

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

/**
 * Unified cart payment (collect-then-payout). The platform takes ONE charge for
 * a multi-vendor cart, then transfers each vendor's product share out. Distinct
 * from `createCheckout`, which is a direct destination charge to a single vendor.
 */
export interface PlatformCheckoutArgs {
  /** Cart-group reference echoed back on the webhook. */
  reference: string;
  /** The full cart total the buyer pays (all products − discounts + shipping +
   *  fulfillment + tax), in cents. */
  amountCents: number;
  currency: string;
  buyerEmail: string;
  successUrl: string;
  cancelUrl: string;
  metadata?: Record<string, string>;
}

/** Move one vendor's product amount from the platform balance to their account. */
export interface VendorTransferArgs {
  /** Vendor's connected destination on this rail (Stripe acct_… / FLW subaccount). */
  externalAccountId: string;
  amountCents: number;
  currency: string;
  /** Sub-order reference — used as the idempotency key so a retry never
   *  double-pays a vendor. */
  reference: string;
  /**
   * Bank-account details for rails that pay out to a bank rather than a
   * connected-account id (Flutterwave Transfers API). Ignored by rails that
   * transfer to a connected account (Stripe uses externalAccountId).
   */
  bankCode?: string;
  accountNumber?: string;
  recipientName?: string;
  metadata?: Record<string, string>;
}

export interface TransferResult {
  transferId: string;
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

  // ---------------------------------------------------------------------------
  // Unified cart payment (collect-then-payout) — OPTIONAL capability.
  //
  // These are concrete (not abstract) with a default that rejects, so a rail
  // that doesn't support platform collection (or a future/legacy rail) keeps
  // compiling and simply reports the capability as unavailable — Open/Closed,
  // and callers fail loudly rather than silently mis-routing money. Rails that
  // support it (Stripe, Flutterwave) override.
  // ---------------------------------------------------------------------------

  /** Whether this rail can act as the single platform collector for a cart. */
  supportsPlatformCollection(): boolean {
    return false;
  }

  /** One charge to the PLATFORM account for the whole cart (no vendor split). */
  createPlatformCheckout(_args: PlatformCheckoutArgs): Promise<CheckoutResult> {
    throw new Error(`${this.key} does not support platform (collect-then-payout) checkout.`);
  }

  /** Pay one vendor their product share out of the platform balance. */
  transferToVendor(_args: VendorTransferArgs): Promise<TransferResult> {
    throw new Error(`${this.key} does not support vendor payouts (transfers).`);
  }

  /** Reverse a vendor payout (used when that vendor's sub-order is refunded). */
  reverseTransfer(_args: {
    transferId: string;
    amountCents?: number;
    reference?: string;
  }): Promise<{ reversalId: string }> {
    throw new Error(`${this.key} does not support transfer reversal.`);
  }

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

  /**
   * Verify a transaction directly with the processor (server-to-server), used by
   * the return/redirect confirmation path so a paid order is recognised even if
   * the webhook is delayed or never delivered. Returns the same normalised event
   * shape as the webhook parser. Default: not supported → "other" (the webhook
   * remains the source of truth). Rails that can verify (Flutterwave) override.
   */
  verifyTransaction(_args: {
    transactionId?: string | null;
    txRef?: string | null;
  }): Promise<ParsedPaymentEvent> {
    return Promise.resolve({
      type: "other",
      reference: null,
      paymentRef: null,
      amountCents: null,
      currency: null,
    });
  }
}
