import { createHmac } from "crypto";

import { PaystackProcessor } from "./paystack.processor";

const SECRET = "sk_test_secret";

function sign(raw: string): string {
  return createHmac("sha512", SECRET).update(raw).digest("hex");
}

describe("PaystackProcessor.verifyAndParseWebhook", () => {
  const proc = new PaystackProcessor(SECRET, jest.fn() as never);

  it("parses a signed charge.success into a paid event", () => {
    const raw = JSON.stringify({
      event: "charge.success",
      data: {
        reference: "SF-000007-abc",
        amount: 5698,
        currency: "USD",
        metadata: { reference: "SF-000007" },
      },
    });
    const parsed = proc.verifyAndParseWebhook(raw, sign(raw));
    expect(parsed.type).toBe("paid");
    expect(parsed.reference).toBe("SF-000007"); // the SF order ref from metadata
    expect(parsed.paymentRef).toBe("SF-000007-abc");
    expect(parsed.amountCents).toBe(5698);
    expect(parsed.currency).toBe("USD");
  });

  it("rejects a bad signature", () => {
    const raw = JSON.stringify({ event: "charge.success", data: {} });
    expect(() => proc.verifyAndParseWebhook(raw, "deadbeef")).toThrow();
  });

  it("treats non-charge events as 'other'", () => {
    const raw = JSON.stringify({ event: "transfer.success", data: {} });
    const parsed = proc.verifyAndParseWebhook(raw, sign(raw));
    expect(parsed.type).toBe("other");
  });
});

describe("PaystackProcessor.createCheckout", () => {
  it("initializes a split transaction (subaccount + transaction_charge)", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: true,
        data: { authorization_url: "https://paystack/checkout/xyz", reference: "SF-1-abc" },
      }),
    });
    const proc = new PaystackProcessor(SECRET, fetchMock as never);
    const res = await proc.createCheckout({
      reference: "SF-000001",
      amountCents: 5698,
      platformFeeCents: 1100,
      currency: "USD",
      vendorExternalAccountId: "ACCT_sub123",
      buyerEmail: "b@example.com",
      successUrl: "https://s/ok",
      cancelUrl: "https://s/no",
    });
    expect(res.checkoutUrl).toContain("paystack");
    expect(res.paymentRef).toBe("SF-1-abc");

    const [, opts] = fetchMock.mock.calls[0];
    const body = JSON.parse((opts as { body: string }).body);
    expect(body.subaccount).toBe("ACCT_sub123");
    expect(body.transaction_charge).toBe(1100);
    expect(body.amount).toBe(5698);
    expect(body.currency).toBe("USD");
    expect(body.metadata.reference).toBe("SF-000001");
  });
});

describe("PaystackProcessor.isConfigured", () => {
  it("is false without a secret key", () => {
    expect(new PaystackProcessor("", jest.fn() as never).isConfigured()).toBe(false);
  });
  it("is true with a secret key", () => {
    expect(new PaystackProcessor(SECRET, jest.fn() as never).isConfigured()).toBe(true);
  });
});
