/**
 * StripeConnectProcessor — storefront payments via Stripe Connect (Migration 0059).
 *
 * Onboarding: the vendor completes Stripe's hosted Express onboarding (Stripe
 * runs their KYC). We store the connected account id and mirror its status.
 *
 * Charge: a destination charge on a Checkout Session. `application_fee_amount`
 * is USA Errands' share (shipping + fulfillment); the remainder settles to the
 * vendor's connected account. USA Errands never holds the product cash.
 *
 * The Stripe client + webhook secret are constructor-injectable so unit tests
 * can supply fakes; in production they default to the environment.
 */
import { Injectable, Logger, Optional } from "@nestjs/common";
import Stripe from "stripe";

import {
  PaymentProcessor,
  type CheckoutResult,
  type CreateCheckoutArgs,
  type ParsedPaymentEvent,
  type PayoutAccountSnapshot,
  type ProcessorKey,
} from "./payment-processor.interface";

export interface CreateAccountLinkArgs {
  /** Existing connected account, if the vendor started onboarding before. */
  externalAccountId?: string | null;
  email?: string;
  country?: string; // ISO-2; Stripe defaults to US if omitted
  refreshUrl: string;
  returnUrl: string;
}

@Injectable()
export class StripeConnectProcessor extends PaymentProcessor {
  readonly key: ProcessorKey = "STRIPE";
  private readonly logger = new Logger(StripeConnectProcessor.name);
  private readonly stripe: Stripe | null;
  private readonly webhookSecret: string;

  // Params are constructor-injectable for tests only; @Optional() stops Nest's
  // DI from trying to resolve them as providers in production (it injects
  // nothing and we fall back to the environment).
  constructor(
    @Optional() stripeClient?: Stripe | null,
    @Optional() webhookSecret?: string,
  ) {
    super();
    const apiKey = process.env.STRIPE_SECRET_KEY ?? "";
    // A dedicated endpoint secret for storefront/Connect events keeps them
    // isolated from the existing shopper/deposit webhook; falls back to the
    // shared secret so a single-endpoint setup still works.
    this.webhookSecret =
      webhookSecret ??
      process.env.STRIPE_CONNECT_WEBHOOK_SECRET ??
      process.env.STRIPE_WEBHOOK_SECRET ??
      "";

    if (stripeClient !== undefined) {
      this.stripe = stripeClient;
    } else if (apiKey) {
      this.stripe = new Stripe(apiKey, {
        appInfo: { name: "usa-errands-storefront", version: "0.1.0" },
        timeout: 10_000,
        maxNetworkRetries: 2,
      });
    } else {
      if (process.env.NODE_ENV === "production") {
        this.logger.warn("STRIPE_SECRET_KEY not set — storefront Stripe payments disabled.");
      }
      this.stripe = null;
    }
  }

  isConfigured(): boolean {
    return this.stripe !== null;
  }

  private client(): Stripe {
    if (!this.stripe) throw new Error("Stripe is not configured.");
    return this.stripe;
  }

  /** Create (if needed) an Express connected account + a hosted onboarding link. */
  async createAccountLink(
    args: CreateAccountLinkArgs,
  ): Promise<{ url: string; externalAccountId: string }> {
    const stripe = this.client();
    let accountId = args.externalAccountId ?? null;
    if (!accountId) {
      // Platforms created in the current Stripe dashboard must create connected
      // accounts with the Accounts v2 API (`POST /v2/core/accounts`); the old
      // v1 `accounts.create` endpoint is rejected ("Stripe no longer recommends
      // Accounts v1 for new integrations"). The pinned SDK (17.x) doesn't expose
      // typed v2 account methods yet, so we call the endpoint via `rawRequest`
      // with the preview API version.
      //
      // This recreates our Express / Marketplace setup: an Express-style Stripe
      // dashboard; the `merchant` configuration (card_payments) and the
      // `recipient` configuration (stripe_transfers) — the latter is required
      // for the account to be the destination of our destination charges; the
      // platform pays Stripe's fees and covers losses. Stripe collects the
      // account's onboarding requirements via the hosted account link below.
      //
      // v2 account ids are accepted by the v1 endpoints used elsewhere in this
      // file (accountLinks.create, accounts.retrieve) and by Checkout's
      // transfer_data.destination, so only creation changes.
      // Fields mirror Stripe's documented working v2 create example. The
      // `merchant` configuration (card_payments) enables the account to be paid;
      // for an `express` dashboard Stripe requires both fees_collector and
      // losses_collector to be `application` (the platform), matching the
      // Marketplace setup chosen in the dashboard. Stripe collects the account's
      // onboarding requirements through the hosted account link below.
      const params: Record<string, unknown> = {
        dashboard: "express",
        identity: { country: (args.country || "US").toLowerCase() },
        configuration: {
          merchant: { capabilities: { card_payments: { requested: true } } },
        },
        defaults: {
          responsibilities: {
            fees_collector: "application",
            losses_collector: "application",
          },
        },
        include: ["configuration.merchant", "identity"],
      };
      if (args.email) params.contact_email = args.email;

      const created = (await stripe.rawRequest("POST", "/v2/core/accounts", params, {
        apiVersion: "2026-08-26.dahlia",
      })) as unknown as { id: string };
      accountId = created.id;
    }
    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: args.refreshUrl,
      return_url: args.returnUrl,
      type: "account_onboarding",
    });
    return { url: link.url, externalAccountId: accountId };
  }

  async getAccountStatus(externalAccountId: string): Promise<PayoutAccountSnapshot> {
    const account = await this.client().accounts.retrieve(externalAccountId);
    const chargesEnabled = account.charges_enabled === true;
    const payoutsEnabled = account.payouts_enabled === true;
    const detailsSubmitted = account.details_submitted === true;
    const status: PayoutAccountSnapshot["status"] = chargesEnabled
      ? "ACTIVE"
      : detailsSubmitted
        ? "RESTRICTED"
        : "PENDING";
    return { externalAccountId, status, detailsSubmitted, chargesEnabled, payoutsEnabled };
  }

  async createCheckout(args: CreateCheckoutArgs): Promise<CheckoutResult> {
    const stripe = this.client();
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: args.buyerEmail,
      payment_method_types: ["card"],
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: args.currency.toLowerCase(),
            unit_amount: args.amountCents,
            product_data: { name: `USA Errands order ${args.reference}` },
          },
        },
      ],
      payment_intent_data: {
        application_fee_amount: args.platformFeeCents,
        transfer_data: { destination: args.vendorExternalAccountId },
        metadata: { reference: args.reference, ...(args.metadata ?? {}) },
      },
      metadata: { reference: args.reference, ...(args.metadata ?? {}) },
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
    });
    return {
      checkoutUrl: session.url ?? "",
      paymentRef:
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : session.id,
    };
  }

  // ---------------------------------------------------------------------------
  // Cross-vendor single-card (Elements) primitives.
  //
  // Vault the buyer's card once against a platform Customer (SetupIntent), then
  // charge it off-session to each vendor's connected account as a destination
  // charge. Lets a multi-store cart be paid with a single card entry. Only
  // Stripe vendors qualify; the web Elements form + live SCA handling is the
  // follow-up that exercises these.
  // ---------------------------------------------------------------------------

  /** Find-or-create a platform Customer for the buyer's email. */
  async ensureCustomer(email: string): Promise<string> {
    const stripe = this.client();
    const existing = await stripe.customers.list({ email, limit: 1 });
    if (existing.data[0]) return existing.data[0].id;
    const created = await stripe.customers.create({ email });
    return created.id;
  }

  /** SetupIntent to vault a reusable (off-session) card for the customer. */
  async createSetupIntent(
    customerId: string,
  ): Promise<{ clientSecret: string; setupIntentId: string }> {
    const si = await this.client().setupIntents.create({
      customer: customerId,
      usage: "off_session",
      payment_method_types: ["card"],
    });
    return { clientSecret: si.client_secret ?? "", setupIntentId: si.id };
  }

  /**
   * Charge a vaulted card off-session to a vendor's connected account. Throws
   * with code `requires_action` when the bank demands authentication (the buyer
   * must then complete that charge interactively) — the caller handles per-charge
   * outcomes.
   */
  async chargeWithSavedCard(args: {
    customerId: string;
    paymentMethodId: string;
    amountCents: number;
    platformFeeCents: number;
    currency: string;
    destination: string;
    metadata?: Record<string, string>;
  }): Promise<{ paymentIntentId: string; status: string }> {
    const pi = await this.client().paymentIntents.create({
      amount: args.amountCents,
      currency: args.currency.toLowerCase(),
      customer: args.customerId,
      payment_method: args.paymentMethodId,
      confirm: true,
      off_session: true,
      application_fee_amount: args.platformFeeCents,
      transfer_data: { destination: args.destination },
      metadata: args.metadata ?? {},
    });
    return { paymentIntentId: pi.id, status: pi.status };
  }

  async refund(args: {
    paymentRef: string;
    amountCents?: number;
    reason?: string;
  }): Promise<{ refundId: string }> {
    // On a destination charge the application fee is refunded pro-rata by
    // default; refund_application_fee keeps USA Errands + the vendor sharing
    // the reversal rather than the platform eating it all.
    const refund = await this.client().refunds.create({
      payment_intent: args.paymentRef,
      ...(args.amountCents != null ? { amount: args.amountCents } : {}),
      refund_application_fee: true,
      reverse_transfer: true,
    });
    return { refundId: refund.id };
  }

  verifyAndParseWebhook(rawBody: Buffer | string, signature: string): ParsedPaymentEvent {
    // Throws when the signature can't be verified — caller rejects.
    const event = this.client().webhooks.constructEvent(
      rawBody,
      signature,
      this.webhookSecret,
    );

    if (
      event.type === "checkout.session.completed" ||
      event.type === "checkout.session.async_payment_succeeded"
    ) {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.payment_status === "paid") {
        return {
          type: "paid",
          reference: (session.metadata?.reference as string) ?? null,
          paymentRef:
            typeof session.payment_intent === "string"
              ? session.payment_intent
              : session.id,
          amountCents: session.amount_total ?? null,
          currency: session.currency ? session.currency.toUpperCase() : null,
        };
      }
    }

    // Direct PaymentIntent charges (the single-card Elements flow) don't emit a
    // Checkout Session — they confirm as payment_intent.succeeded.
    if (event.type === "payment_intent.succeeded") {
      const intent = event.data.object as Stripe.PaymentIntent;
      return {
        type: "paid",
        reference: (intent.metadata?.reference as string) ?? null,
        paymentRef: intent.id,
        amountCents: intent.amount_received ?? intent.amount ?? null,
        currency: intent.currency ? intent.currency.toUpperCase() : null,
      };
    }
    return { type: "other", reference: null, paymentRef: null, amountCents: null, currency: null };
  }
}
