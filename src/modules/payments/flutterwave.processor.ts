/**
 * FlutterwaveProcessor — storefront payments via Flutterwave (replaces the
 * earlier Paystack rail). Flutterwave is used instead of Paystack because a
 * single Flutterwave account covers 30+ African countries, so one integration
 * pays vendors into their own local bank across countries — no per-country
 * account juggling.
 *
 * Onboarding: the vendor's payout destination is a Flutterwave SUBACCOUNT
 * created from their bank details (bank code + account number + country).
 *
 * Charge: a Standard payment (`POST /v3/payments`) with a `subaccounts` split.
 * We use a per-transaction `flat` commission so USA Errands keeps
 * `platformFeeCents` (shipping + fulfillment + tax) and the vendor's subaccount
 * receives the remainder (the product amount). Flutterwave amounts are in the
 * MAJOR currency unit (e.g. dollars/naira), NOT minor units — we convert from
 * the interface's integer cents on the way in and back on the way out.
 *
 * The secret key + fetch implementation are constructor-injectable so unit
 * tests run without network or real keys.
 */
import { Injectable, Logger, Optional } from "@nestjs/common";
import { timingSafeEqual } from "crypto";

import {
  PaymentProcessor,
  type CheckoutResult,
  type CreateCheckoutArgs,
  type ParsedPaymentEvent,
  type PayoutAccountSnapshot,
  type PlatformCheckoutArgs,
  type ProcessorKey,
  type TransferResult,
  type VendorTransferArgs,
} from "./payment-processor.interface";

type FetchFn = typeof fetch;

const FLW_BASE = "https://api.flutterwave.com/v3";

export interface CreateSubaccountArgs {
  businessName: string;
  /** Required by Flutterwave for subaccount creation. */
  businessEmail: string;
  /** Flutterwave bank code (from listBanks). */
  accountBank: string;
  accountNumber: string;
  /** ISO country code of the bank account, e.g. "NG", "GH", "KE". */
  country: string;
  businessMobile?: string;
  /**
   * Country-specific extras Flutterwave requires for some banks:
   *   US → { swiftCode, routingNumber }
   *   GH/UG/RW/TZ → { bank_branch }
   */
  meta?: Record<string, string>;
}

@Injectable()
export class FlutterwaveProcessor extends PaymentProcessor {
  readonly key: ProcessorKey = "FLUTTERWAVE";
  private readonly logger = new Logger(FlutterwaveProcessor.name);
  private readonly secretKey: string;
  /** Dashboard-configured secret hash Flutterwave echoes in the verif-hash header. */
  private readonly secretHash: string;
  private readonly fetchFn: FetchFn;

  constructor(
    @Optional() secretKey?: string,
    @Optional() secretHash?: string,
    @Optional() fetchFn?: FetchFn,
  ) {
    super();
    this.secretKey = secretKey ?? process.env.FLUTTERWAVE_SECRET_KEY ?? "";
    this.secretHash = secretHash ?? process.env.FLUTTERWAVE_SECRET_HASH ?? "";
    this.fetchFn = fetchFn ?? globalThis.fetch;
  }

  isConfigured(): boolean {
    return this.secretKey.length > 0;
  }

  private async call<T>(path: string, method: "GET" | "POST", body?: unknown): Promise<T> {
    if (!this.isConfigured()) throw new Error("Flutterwave is not configured.");
    const res = await this.fetchFn(`${FLW_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json()) as { status: string; message?: string; data?: T };
    if (!res.ok || json.status !== "success") {
      throw new Error(`Flutterwave ${method} ${path} failed: ${json.message ?? res.status}`);
    }
    return json.data as T;
  }

  /** Create a payout subaccount from the vendor's bank details. */
  async createSubaccount(args: CreateSubaccountArgs): Promise<{ externalAccountId: string }> {
    try {
      const data = await this.call<{ subaccount_id: string }>("/subaccounts", "POST", {
        account_bank: args.accountBank,
        account_number: args.accountNumber,
        business_name: args.businessName,
        business_email: args.businessEmail,
        business_mobile: args.businessMobile ?? "",
        country: args.country,
        // Defaults; the real split is set per-transaction as a flat commission in
        // createCheckout, so the platform keeps exactly shipping + fulfillment + tax.
        split_type: "percentage",
        split_value: 0,
        ...(args.meta ? { meta: args.meta } : {}),
      });
      return { externalAccountId: data.subaccount_id };
    } catch (err) {
      // Idempotent connect: Flutterwave rejects a duplicate bank+account with
      // "A subaccount with the account number and bank already exists". That's not
      // a failure for us — the payout destination is already there, so look it up
      // and reuse its id instead of surfacing an error to the vendor.
      if (err instanceof Error && /already exists/i.test(err.message)) {
        const existing = await this.findSubaccountByAccountNumber(args.accountNumber);
        if (existing) return { externalAccountId: existing };
      }
      throw err;
    }
  }

  /** Find an existing subaccount's id by its settlement account number. */
  private async findSubaccountByAccountNumber(accountNumber: string): Promise<string | null> {
    const data = await this.call<
      Array<{ subaccount_id?: string; account_number?: string }>
    >(`/subaccounts?account_number=${encodeURIComponent(accountNumber)}`, "GET");
    const list = Array.isArray(data) ? data : [];
    const match =
      list.find((s) => s.account_number === accountNumber) ?? list[0];
    return match?.subaccount_id ?? null;
  }

  /** List settlement banks (name + code) for a country's bank picker. */
  async listBanks(country = "NG"): Promise<Array<{ name: string; code: string }>> {
    const data = await this.call<Array<{ id: number; code: string; name: string }>>(
      `/banks/${encodeURIComponent(country.toUpperCase())}`,
      "GET",
    );
    return (data ?? []).map((b) => ({ name: b.name, code: b.code }));
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getAccountStatus(externalAccountId: string): Promise<PayoutAccountSnapshot> {
    // Flutterwave subaccounts have no Stripe-style KYC gate: once created with a
    // valid bank account they can immediately receive split settlements and never
    // change state. There's nothing to poll, so we report ACTIVE without a network
    // round-trip (the GET /subaccounts/:id endpoint is also finicky about id form).
    return {
      externalAccountId,
      status: "ACTIVE",
      detailsSubmitted: true,
      chargesEnabled: true,
      payoutsEnabled: true,
    };
  }

  async createCheckout(args: CreateCheckoutArgs): Promise<CheckoutResult> {
    // Unique per attempt so retries don't collide; the SF order reference travels
    // in meta for lookup on the webhook.
    const txRef = `${args.reference}-${Date.now().toString(36)}`;
    const data = await this.call<{ link: string }>("/payments", "POST", {
      tx_ref: txRef,
      amount: args.amountCents / 100, // major unit
      currency: args.currency,
      redirect_url: args.successUrl,
      customer: { email: args.buyerEmail },
      customizations: { title: "USA Errands" },
      subaccounts: [
        {
          id: args.vendorExternalAccountId,
          // "flat" ⇒ the platform keeps this flat commission, the subaccount gets
          // the rest. platformFeeCents is shipping + fulfillment + tax.
          transaction_charge_type: "flat",
          transaction_charge: args.platformFeeCents / 100,
        },
      ],
      meta: { reference: args.reference, ...(args.metadata ?? {}) },
    });
    // Flutterwave identifies the payment by tx_ref until the webhook delivers the
    // numeric transaction id; persist tx_ref as the payment ref.
    return { checkoutUrl: data.link, paymentRef: txRef };
  }

  // ---------------------------------------------------------------------------
  // Unified cart payment (collect-then-payout) — Flutterwave overrides.
  //
  // createPlatformCheckout: one Standard charge with NO `subaccounts` split, so
  // the funds land on the PLATFORM balance (vs createCheckout, which splits
  // directly to a vendor subaccount). Vendor payout (transferToVendor) is NOT
  // implemented here yet: Flutterwave pays out via the Transfers API to a bank
  // account, which needs the vendor's bank code + account number — we currently
  // store only the subaccount id. Until that's stored (see design doc), the base
  // class's throwing default applies, so the flow fails loudly rather than
  // mis-routing money. (For an all-Flutterwave cart the native multi-subaccount
  // split on a single charge is the better long-term path.)
  // ---------------------------------------------------------------------------

  override supportsPlatformCollection(): boolean {
    return this.isConfigured();
  }

  override async createPlatformCheckout(args: PlatformCheckoutArgs): Promise<CheckoutResult> {
    const txRef = `${args.reference}-${Date.now().toString(36)}`;
    const data = await this.call<{ link: string }>("/payments", "POST", {
      tx_ref: txRef,
      amount: args.amountCents / 100, // major unit
      currency: args.currency,
      redirect_url: args.successUrl,
      customer: { email: args.buyerEmail },
      customizations: { title: "USA Errands" },
      // No `subaccounts`: the whole amount settles to the platform, to be
      // distributed to vendors after the webhook confirms.
      meta: { reference: args.reference, cart: "1", ...(args.metadata ?? {}) },
    });
    return { checkoutUrl: data.link, paymentRef: txRef };
  }

  /**
   * Pay a vendor via the Transfers API. Needs the vendor's bank code + account
   * number (a subaccount only receives split settlements at charge time), so the
   * caller passes the stored bank details. `reference` is unique per sub-order so
   * Flutterwave dedupes a retry (idempotent payout).
   */
  override async transferToVendor(args: VendorTransferArgs): Promise<TransferResult> {
    if (!args.bankCode || !args.accountNumber) {
      throw new Error(
        "Flutterwave payout requires the vendor's bank code + account number.",
      );
    }
    const data = await this.call<{ id: number | string }>("/transfers", "POST", {
      account_bank: args.bankCode,
      account_number: args.accountNumber,
      amount: args.amountCents / 100, // major unit
      currency: args.currency,
      debit_currency: args.currency,
      reference: `payout_${args.reference}`,
      narration: `USA Errands payout ${args.reference}`,
      ...(args.recipientName ? { beneficiary_name: args.recipientName } : {}),
    });
    return { transferId: String(data.id) };
  }
  // Note: reverseTransfer is intentionally NOT overridden — Flutterwave transfers
  // can't be programmatically reversed once processed; a refund reverses the
  // platform charge instead (see StorefrontOrderService.refund).

  async refund(args: {
    paymentRef: string;
    amountCents?: number;
    reason?: string;
  }): Promise<{ refundId: string }> {
    // paymentRef is the tx_ref; resolve it to Flutterwave's numeric transaction id.
    const tx = await this.call<{ id: number | string }>(
      `/transactions/verify_by_reference?tx_ref=${encodeURIComponent(args.paymentRef)}`,
      "GET",
    );
    const data = await this.call<{ id?: number | string }>(
      `/transactions/${encodeURIComponent(String(tx.id))}/refund`,
      "POST",
      args.amountCents != null ? { amount: args.amountCents / 100 } : {},
    );
    return { refundId: String(data.id ?? tx.id) };
  }

  verifyAndParseWebhook(rawBody: Buffer | string, signature: string): ParsedPaymentEvent {
    // Flutterwave doesn't HMAC the body; it echoes the dashboard-configured secret
    // hash in the `verif-hash` header. Compare in constant time.
    const expected = Buffer.from(this.secretHash);
    const got = Buffer.from(signature ?? "");
    if (
      this.secretHash.length === 0 ||
      expected.length !== got.length ||
      !timingSafeEqual(expected, got)
    ) {
      throw new Error("Invalid Flutterwave webhook signature.");
    }

    const raw = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
    const event = JSON.parse(raw) as {
      event?: string;
      data?: {
        id?: number | string;
        status?: string;
        amount?: number;
        currency?: string;
        meta?: { reference?: string };
      };
    };
    if (event.event === "charge.completed" && event.data?.status === "successful") {
      return {
        type: "paid",
        reference: event.data.meta?.reference ?? null,
        paymentRef: event.data.id != null ? String(event.data.id) : null,
        amountCents: typeof event.data.amount === "number" ? Math.round(event.data.amount * 100) : null,
        currency: event.data.currency ?? null,
      };
    }
    return { type: "other", reference: null, paymentRef: null, amountCents: null, currency: null };
  }
}
