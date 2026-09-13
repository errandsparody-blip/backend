import { FlutterwaveProcessor } from "./flutterwave.processor";
import { PaymentProcessorRegistry } from "./payment-processor.registry";
import { StripeConnectProcessor } from "./stripe-connect.processor";

function fakeStripe() {
  return {
    checkout: {
      sessions: {
        create: jest.fn().mockResolvedValue({
          url: "https://checkout.stripe/xyz",
          payment_intent: "pi_123",
          id: "cs_123",
        }),
      },
    },
    accounts: {
      create: jest.fn().mockResolvedValue({ id: "acct_new" }),
      retrieve: jest.fn().mockResolvedValue({
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true,
      }),
    },
    accountLinks: {
      create: jest.fn().mockResolvedValue({ url: "https://connect.stripe/onboard" }),
    },
    customers: {
      list: jest.fn().mockResolvedValue({ data: [] }),
      create: jest.fn().mockResolvedValue({ id: "cus_1" }),
    },
    setupIntents: {
      create: jest.fn().mockResolvedValue({ id: "seti_1", client_secret: "seti_secret" }),
    },
    paymentIntents: {
      create: jest.fn().mockResolvedValue({ id: "pi_x", status: "succeeded" }),
    },
    transfers: {
      create: jest.fn().mockResolvedValue({ id: "tr_1" }),
      createReversal: jest.fn().mockResolvedValue({ id: "trr_1" }),
    },
    webhooks: {
      constructEvent: jest.fn(),
    },
  };
}

describe("StripeConnectProcessor.createCheckout", () => {
  it("creates a destination charge with application fee + transfer destination", async () => {
    const stripe = fakeStripe();
    const proc = new StripeConnectProcessor(stripe as never, "whsec");
    const res = await proc.createCheckout({
      reference: "SF-000001",
      amountCents: 4800,
      platformFeeCents: 1100,
      currency: "USD",
      vendorExternalAccountId: "acct_vendor",
      buyerEmail: "b@example.com",
      successUrl: "https://s/ok",
      cancelUrl: "https://s/no",
    });
    expect(res.checkoutUrl).toContain("stripe");
    expect(res.paymentRef).toBe("pi_123");

    const arg = stripe.checkout.sessions.create.mock.calls[0][0];
    expect(arg.payment_intent_data.application_fee_amount).toBe(1100);
    expect(arg.payment_intent_data.transfer_data.destination).toBe("acct_vendor");
    expect(arg.metadata.reference).toBe("SF-000001");
  });
});

describe("StripeConnectProcessor.verifyAndParseWebhook", () => {
  it("parses a paid checkout.session.completed", () => {
    const stripe = fakeStripe();
    stripe.webhooks.constructEvent.mockReturnValue({
      type: "checkout.session.completed",
      data: {
        object: {
          payment_status: "paid",
          payment_intent: "pi_123",
          amount_total: 4800,
          currency: "usd",
          metadata: { reference: "SF-000001" },
        },
      },
    });
    const proc = new StripeConnectProcessor(stripe as never, "whsec");
    const parsed = proc.verifyAndParseWebhook("raw", "sig");
    expect(parsed.type).toBe("paid");
    expect(parsed.reference).toBe("SF-000001");
    expect(parsed.paymentRef).toBe("pi_123");
    expect(parsed.amountCents).toBe(4800);
    expect(parsed.currency).toBe("USD");
  });

  it("parses a direct payment_intent.succeeded (single-card flow)", () => {
    const stripe = fakeStripe();
    stripe.webhooks.constructEvent.mockReturnValue({
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_direct",
          amount_received: 4800,
          amount: 4800,
          currency: "usd",
          metadata: { reference: "SF-000009" },
        },
      },
    });
    const proc = new StripeConnectProcessor(stripe as never, "whsec");
    const parsed = proc.verifyAndParseWebhook("raw", "sig");
    expect(parsed.type).toBe("paid");
    expect(parsed.reference).toBe("SF-000009");
    expect(parsed.paymentRef).toBe("pi_direct");
    expect(parsed.amountCents).toBe(4800);
  });

  it("throws when the signature can't be verified", () => {
    const stripe = fakeStripe();
    stripe.webhooks.constructEvent.mockImplementation(() => {
      throw new Error("bad sig");
    });
    const proc = new StripeConnectProcessor(stripe as never, "whsec");
    expect(() => proc.verifyAndParseWebhook("raw", "sig")).toThrow();
  });
});

describe("StripeConnectProcessor single-card primitives", () => {
  it("ensureCustomer reuses an existing customer, else creates one", async () => {
    const stripe = fakeStripe();
    stripe.customers.list.mockResolvedValueOnce({ data: [{ id: "cus_existing" }] });
    const proc = new StripeConnectProcessor(stripe as never, "whsec");
    expect(await proc.ensureCustomer("b@x.com")).toBe("cus_existing");
    stripe.customers.list.mockResolvedValueOnce({ data: [] });
    expect(await proc.ensureCustomer("new@x.com")).toBe("cus_1");
  });

  it("createSetupIntent returns a client secret to vault the card", async () => {
    const proc = new StripeConnectProcessor(fakeStripe() as never, "whsec");
    const res = await proc.createSetupIntent("cus_1");
    expect(res.clientSecret).toBe("seti_secret");
    expect(res.setupIntentId).toBe("seti_1");
  });

  it("chargeWithSavedCard makes an off-session destination charge with the app fee", async () => {
    const stripe = fakeStripe();
    const proc = new StripeConnectProcessor(stripe as never, "whsec");
    const res = await proc.chargeWithSavedCard({
      customerId: "cus_1",
      paymentMethodId: "pm_1",
      amountCents: 6100,
      platformFeeCents: 1100,
      currency: "USD",
      destination: "acct_v",
      metadata: { reference: "SF-1" },
    });
    expect(res).toEqual({ paymentIntentId: "pi_x", status: "succeeded" });
    const arg = stripe.paymentIntents.create.mock.calls[0][0];
    expect(arg.off_session).toBe(true);
    expect(arg.confirm).toBe(true);
    expect(arg.application_fee_amount).toBe(1100);
    expect(arg.transfer_data.destination).toBe("acct_v");
  });
});

describe("StripeConnectProcessor unified cart payment (collect-then-payout)", () => {
  it("createPlatformCheckout charges the platform (no transfer_data / app fee)", async () => {
    const stripe = fakeStripe();
    const proc = new StripeConnectProcessor(stripe as never, "whsec");
    expect(proc.supportsPlatformCollection()).toBe(true);
    const res = await proc.createPlatformCheckout({
      reference: "CART-1",
      amountCents: 12000,
      currency: "USD",
      buyerEmail: "b@example.com",
      successUrl: "https://s/ok",
      cancelUrl: "https://s/no",
    });
    expect(res.paymentRef).toBe("pi_123");
    const arg = stripe.checkout.sessions.create.mock.calls[0][0];
    // Platform charge: funds land on the platform, so NO destination / app fee.
    expect(arg.payment_intent_data.transfer_data).toBeUndefined();
    expect(arg.payment_intent_data.application_fee_amount).toBeUndefined();
    expect(arg.line_items[0].price_data.unit_amount).toBe(12000);
  });

  it("transferToVendor pays one vendor, idempotency-keyed on the sub-order ref", async () => {
    const stripe = fakeStripe();
    const proc = new StripeConnectProcessor(stripe as never, "whsec");
    const res = await proc.transferToVendor({
      externalAccountId: "acct_vendor",
      amountCents: 5000,
      currency: "USD",
      reference: "SF-000008",
    });
    expect(res.transferId).toBe("tr_1");
    const [body, opts] = stripe.transfers.create.mock.calls[0];
    expect(body.amount).toBe(5000);
    expect(body.destination).toBe("acct_vendor");
    expect((opts as { idempotencyKey: string }).idempotencyKey).toBe("transfer:SF-000008");
  });

  it("reverseTransfer reverses a vendor payout", async () => {
    const stripe = fakeStripe();
    const proc = new StripeConnectProcessor(stripe as never, "whsec");
    const res = await proc.reverseTransfer({ transferId: "tr_1", amountCents: 5000 });
    expect(res.reversalId).toBe("trr_1");
    expect(stripe.transfers.createReversal.mock.calls[0][0]).toBe("tr_1");
  });
});

describe("PaymentProcessorRegistry", () => {
  it("resolves processors by key and lists configured ones", () => {
    const stripe = new StripeConnectProcessor(fakeStripe() as never, "whsec"); // configured
    const flutterwave = new FlutterwaveProcessor("", "", jest.fn() as never); // not configured
    const registry = new PaymentProcessorRegistry(stripe, flutterwave);
    expect(registry.get("STRIPE").key).toBe("STRIPE");
    expect(registry.get("FLUTTERWAVE").key).toBe("FLUTTERWAVE");
    // PAYSTACK is intentionally unregistered now → unsupported_processor.
    expect(() => registry.get("PAYSTACK")).toThrow();
    expect(registry.configuredKeys()).toEqual(["STRIPE"]);
  });
});
