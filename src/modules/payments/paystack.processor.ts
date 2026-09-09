/**
 * PaystackProcessor — storefront payments via Paystack (Migration 0059).
 *
 * Onboarding: the vendor's payout destination is a Paystack SUBACCOUNT created
 * from their bank details (Paystack has no hosted KYC redirect like Stripe).
 *
 * Charge: a Transaction Initialize with `subaccount` + `transaction_charge`.
 * The subaccount (vendor) receives the product amount; `transaction_charge`
 * (shipping + fulfillment) routes to the USA Errands main account. Charged in
 * USD (Paystack accepts U.S. cards); amounts are in the minor unit (cents).
 *
 * The secret key + fetch implementation are constructor-injectable so unit
 * tests run without network or real keys.
 */
import { Injectable, Logger, Optional } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "crypto";

import {
  PaymentProcessor,
  type CheckoutResult,
  type CreateCheckoutArgs,
  type ParsedPaymentEvent,
  type PayoutAccountSnapshot,
  type ProcessorKey,
} from "./payment-processor.interface";

type FetchFn = typeof fetch;

const PAYSTACK_BASE = "https://api.paystack.co";

export interface CreateSubaccountArgs {
  businessName: string;
  settlementBank: string; // Paystack bank code
  accountNumber: string;
  /** Percentage Paystack keeps for the MAIN account on split (we use flat charge instead → 0). */
  percentageCharge?: number;
}

@Injectable()
export class PaystackProcessor extends PaymentProcessor {
  readonly key: ProcessorKey = "PAYSTACK";
  private readonly logger = new Logger(PaystackProcessor.name);
  private readonly secretKey: string;
  private readonly fetchFn: FetchFn;

  // @Optional() so Nest DI doesn't try to resolve these test-only params in
  // production (falls back to the environment + global fetch).
  constructor(@Optional() secretKey?: string, @Optional() fetchFn?: FetchFn) {
    super();
    this.secretKey = secretKey ?? process.env.PAYSTACK_SECRET_KEY ?? "";
    this.fetchFn = fetchFn ?? globalThis.fetch;
  }

  isConfigured(): boolean {
    return this.secretKey.length > 0;
  }

  private async call<T>(
    path: string,
    method: "GET" | "POST",
    body?: unknown,
  ): Promise<T> {
    if (!this.isConfigured()) throw new Error("Paystack is not configured.");
    const res = await this.fetchFn(`${PAYSTACK_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json()) as { status: boolean; message?: string; data?: T };
    if (!res.ok || !json.status) {
      throw new Error(`Paystack ${method} ${path} failed: ${json.message ?? res.status}`);
    }
    return json.data as T;
  }

  /** Create a payout subaccount from the vendor's bank details. */
  async createSubaccount(args: CreateSubaccountArgs): Promise<{ externalAccountId: string }> {
    const data = await this.call<{ subaccount_code: string }>("/subaccount", "POST", {
      business_name: args.businessName,
      settlement_bank: args.settlementBank,
      account_number: args.accountNumber,
      percentage_charge: args.percentageCharge ?? 0,
    });
    return { externalAccountId: data.subaccount_code };
  }

  /** List settlement banks (name + code) for the subaccount bank picker. */
  async listBanks(country = "nigeria"): Promise<Array<{ name: string; code: string }>> {
    const data = await this.call<Array<{ name: string; code: string }>>(
      `/bank?country=${encodeURIComponent(country)}&perPage=100`,
      "GET",
    );
    return (data ?? []).map((b) => ({ name: b.name, code: b.code }));
  }

  async getAccountStatus(externalAccountId: string): Promise<PayoutAccountSnapshot> {
    const data = await this.call<{ active?: boolean; is_verified?: boolean }>(
      `/subaccount/${encodeURIComponent(externalAccountId)}`,
      "GET",
    );
    // A created subaccount with a valid settlement bank is ready to receive
    // split settlements; treat active as ACTIVE, otherwise PENDING.
    const active = data.active !== false;
    return {
      externalAccountId,
      status: active ? "ACTIVE" : "PENDING",
      detailsSubmitted: true,
      chargesEnabled: active,
      payoutsEnabled: active,
    };
  }

  async createCheckout(args: CreateCheckoutArgs): Promise<CheckoutResult> {
    // Unique per attempt so retries don't collide with a used reference; the
    // SF order reference travels in metadata for lookup on the webhook.
    const txRef = `${args.reference}-${Date.now().toString(36)}`;
    const data = await this.call<{ authorization_url: string; reference: string }>(
      "/transaction/initialize",
      "POST",
      {
        email: args.buyerEmail,
        amount: args.amountCents, // minor unit (USD cents)
        currency: args.currency,
        reference: txRef,
        callback_url: args.successUrl,
        subaccount: args.vendorExternalAccountId,
        transaction_charge: args.platformFeeCents,
        bearer: "account", // platform bears Paystack's processing fee
        metadata: { reference: args.reference, ...(args.metadata ?? {}) },
      },
    );
    return { checkoutUrl: data.authorization_url, paymentRef: data.reference };
  }

  async refund(args: {
    paymentRef: string;
    amountCents?: number;
    reason?: string;
  }): Promise<{ refundId: string }> {
    const data = await this.call<{ id?: number | string }>("/refund", "POST", {
      transaction: args.paymentRef,
      ...(args.amountCents != null ? { amount: args.amountCents } : {}),
      ...(args.reason ? { merchant_note: args.reason } : {}),
    });
    return { refundId: String(data.id ?? args.paymentRef) };
  }

  verifyAndParseWebhook(rawBody: Buffer | string, signature: string): ParsedPaymentEvent {
    const raw = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
    const expected = createHmac("sha512", this.secretKey).update(raw).digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(signature ?? "");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new Error("Invalid Paystack webhook signature.");
    }

    const event = JSON.parse(raw) as {
      event?: string;
      data?: {
        reference?: string;
        amount?: number;
        currency?: string;
        metadata?: { reference?: string };
      };
    };
    if (event.event === "charge.success" && event.data) {
      return {
        type: "paid",
        reference: event.data.metadata?.reference ?? null,
        paymentRef: event.data.reference ?? null,
        amountCents: typeof event.data.amount === "number" ? event.data.amount : null,
        currency: event.data.currency ?? null,
      };
    }
    return { type: "other", reference: null, paymentRef: null, amountCents: null, currency: null };
  }
}
