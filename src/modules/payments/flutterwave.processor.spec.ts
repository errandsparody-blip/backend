import { FlutterwaveProcessor } from "./flutterwave.processor";

const SECRET = "FLWSECK_TEST-xxxx";
const HASH = "my-dashboard-verif-hash";

function okFetch(data: unknown) {
  return jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ status: "success", data }),
  });
}

describe("FlutterwaveProcessor.verifyAndParseWebhook", () => {
  const proc = new FlutterwaveProcessor(SECRET, HASH, jest.fn() as never);

  it("parses a charge.completed/successful into a paid event", () => {
    const raw = JSON.stringify({
      event: "charge.completed",
      data: {
        id: 285959875,
        status: "successful",
        amount: 56.98,
        currency: "USD",
        meta: { reference: "SF-000007" },
      },
    });
    const parsed = proc.verifyAndParseWebhook(raw, HASH);
    expect(parsed.type).toBe("paid");
    expect(parsed.reference).toBe("SF-000007"); // SF order ref from meta
    expect(parsed.paymentRef).toBe("285959875"); // numeric transaction id
    expect(parsed.amountCents).toBe(5698); // major → minor
    expect(parsed.currency).toBe("USD");
  });

  it("rejects a bad verif-hash", () => {
    const raw = JSON.stringify({ event: "charge.completed", data: { status: "successful" } });
    expect(() => proc.verifyAndParseWebhook(raw, "wrong-hash")).toThrow();
  });

  it("treats a non-successful charge as 'other'", () => {
    const raw = JSON.stringify({
      event: "charge.completed",
      data: { status: "failed", meta: {} },
    });
    const parsed = proc.verifyAndParseWebhook(raw, HASH);
    expect(parsed.type).toBe("other");
  });

  it("rejects when no secret hash is configured", () => {
    const noHash = new FlutterwaveProcessor(SECRET, "", jest.fn() as never);
    const raw = JSON.stringify({ event: "charge.completed", data: { status: "successful" } });
    expect(() => noHash.verifyAndParseWebhook(raw, "")).toThrow();
  });
});

describe("FlutterwaveProcessor.verifyTransaction", () => {
  it("verifies by transaction id and returns a paid event (meta reference)", async () => {
    const fetchMock = okFetch({
      id: 285959875,
      status: "successful",
      amount: 56.98,
      currency: "USD",
      tx_ref: "SF-000007-abc123",
      meta: { reference: "SF-000007" },
    });
    const proc = new FlutterwaveProcessor(SECRET, HASH, fetchMock as never);
    const parsed = await proc.verifyTransaction({ transactionId: "285959875" });
    expect(parsed.type).toBe("paid");
    expect(parsed.reference).toBe("SF-000007");
    expect(parsed.paymentRef).toBe("285959875");
    expect(parsed.amountCents).toBe(5698);
    expect(parsed.currency).toBe("USD");
    expect(String(fetchMock.mock.calls[0][0])).toContain("/transactions/285959875/verify");
  });

  it("verifies by tx_ref and derives the order reference when meta is absent", async () => {
    const fetchMock = okFetch({
      id: 111,
      status: "successful",
      amount: 12,
      currency: "USD",
      tx_ref: "CART-9f2-xyz789",
    });
    const proc = new FlutterwaveProcessor(SECRET, HASH, fetchMock as never);
    const parsed = await proc.verifyTransaction({ txRef: "CART-9f2-xyz789" });
    expect(parsed.type).toBe("paid");
    expect(parsed.reference).toBe("CART-9f2"); // suffix stripped
    expect(String(fetchMock.mock.calls[0][0])).toContain("/transactions/verify_by_reference?tx_ref=CART-9f2-xyz789");
  });

  it("returns 'other' for a non-successful transaction", async () => {
    const fetchMock = okFetch({ id: 1, status: "failed", amount: 10, currency: "USD" });
    const proc = new FlutterwaveProcessor(SECRET, HASH, fetchMock as never);
    const parsed = await proc.verifyTransaction({ transactionId: "1" });
    expect(parsed.type).toBe("other");
  });
});

describe("FlutterwaveProcessor.createCheckout", () => {
  it("creates a Standard payment with a flat subaccount split", async () => {
    const fetchMock = okFetch({ link: "https://checkout.flutterwave.com/pay/xyz" });
    const proc = new FlutterwaveProcessor(SECRET, HASH, fetchMock as never);
    const res = await proc.createCheckout({
      reference: "SF-000001",
      amountCents: 5698,
      platformFeeCents: 1100,
      currency: "USD",
      vendorExternalAccountId: "RS_SUB123",
      buyerEmail: "b@example.com",
      successUrl: "https://s/ok",
      cancelUrl: "https://s/no",
    });
    expect(res.checkoutUrl).toContain("flutterwave");
    expect(res.paymentRef).toMatch(/^SF-000001-/); // tx_ref carries the SF ref

    const [url, opts] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/payments");
    const body = JSON.parse((opts as { body: string }).body);
    expect(body.amount).toBe(56.98); // MAJOR unit, not cents
    expect(body.currency).toBe("USD");
    expect(body.customer.email).toBe("b@example.com");
    expect(body.subaccounts[0].id).toBe("RS_SUB123");
    expect(body.subaccounts[0].transaction_charge_type).toBe("flat");
    expect(body.subaccounts[0].transaction_charge).toBe(11); // platform fee, major unit
    expect(body.meta.reference).toBe("SF-000001");
  });
});

describe("FlutterwaveProcessor.createSubaccount / listBanks", () => {
  it("creates a subaccount and returns its id", async () => {
    const fetchMock = okFetch({ subaccount_id: "RS_ABC" });
    const proc = new FlutterwaveProcessor(SECRET, HASH, fetchMock as never);
    const { externalAccountId } = await proc.createSubaccount({
      businessName: "Acme",
      businessEmail: "acme@example.com",
      accountBank: "044",
      accountNumber: "0690000031",
      country: "NG",
    });
    expect(externalAccountId).toBe("RS_ABC");
    const [, opts] = fetchMock.mock.calls[0];
    const body = JSON.parse((opts as { body: string }).body);
    expect(body.account_bank).toBe("044");
    expect(body.account_number).toBe("0690000031");
    expect(body.business_email).toBe("acme@example.com");
    expect(body.country).toBe("NG");
  });

  it("reuses the existing subaccount when Flutterwave says it already exists", async () => {
    const fetchMock = jest
      .fn()
      // POST /subaccounts → duplicate error
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({
          status: "error",
          message: "A subaccount with the account number and bank already exists",
        }),
      })
      // GET /subaccounts?account_number=… → the existing one
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: "success",
          data: [{ subaccount_id: "RS_EXISTING", account_number: "0690000031" }],
        }),
      });
    const proc = new FlutterwaveProcessor(SECRET, HASH, fetchMock as never);
    const { externalAccountId } = await proc.createSubaccount({
      businessName: "Acme",
      businessEmail: "acme@example.com",
      accountBank: "044",
      accountNumber: "0690000031",
      country: "NG",
    });
    expect(externalAccountId).toBe("RS_EXISTING");
    expect(String(fetchMock.mock.calls[1][0])).toContain("/subaccounts?account_number=0690000031");
  });

  it("maps banks to {name, code}", async () => {
    const fetchMock = okFetch([
      { id: 1, code: "044", name: "Access Bank" },
      { id: 2, code: "058", name: "GTBank" },
    ]);
    const proc = new FlutterwaveProcessor(SECRET, HASH, fetchMock as never);
    const banks = await proc.listBanks("GH");
    expect(banks).toEqual([
      { name: "Access Bank", code: "044" },
      { name: "GTBank", code: "058" },
    ]);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/banks/GH");
  });
});

describe("FlutterwaveProcessor unified cart payment (collect-then-payout)", () => {
  it("createPlatformCheckout charges the platform with NO subaccount split", async () => {
    const fetchMock = okFetch({ link: "https://checkout.flutterwave.com/pay/cart" });
    const proc = new FlutterwaveProcessor(SECRET, HASH, fetchMock as never);
    expect(proc.supportsPlatformCollection()).toBe(true);
    const res = await proc.createPlatformCheckout({
      reference: "CART-1",
      amountCents: 12000,
      currency: "USD",
      buyerEmail: "b@example.com",
      successUrl: "https://s/ok",
      cancelUrl: "https://s/no",
    });
    expect(res.checkoutUrl).toContain("flutterwave");
    const [, opts] = fetchMock.mock.calls[0];
    const body = JSON.parse((opts as { body: string }).body);
    expect(body.amount).toBe(120); // major unit
    expect(body.subaccounts).toBeUndefined(); // funds go to the platform
    expect(body.meta.reference).toBe("CART-1");
  });

  it("transferToVendor pays out via the Transfers API using the vendor's bank details", async () => {
    const fetchMock = okFetch({ id: 909090 });
    const proc = new FlutterwaveProcessor(SECRET, HASH, fetchMock as never);
    const res = await proc.transferToVendor({
      externalAccountId: "RS_1",
      amountCents: 5000,
      currency: "USD",
      reference: "SF-000008",
      bankCode: "044",
      accountNumber: "0690000031",
    });
    expect(res.transferId).toBe("909090");
    const [url, opts] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/transfers");
    const body = JSON.parse((opts as { body: string }).body);
    expect(body.account_bank).toBe("044");
    expect(body.account_number).toBe("0690000031");
    expect(body.amount).toBe(50); // major unit
    expect(body.reference).toBe("payout_SF-000008"); // idempotent per sub-order
  });

  it("transferToVendor throws when bank details are missing", async () => {
    const proc = new FlutterwaveProcessor(SECRET, HASH, jest.fn() as never);
    await expect(
      proc.transferToVendor({
        externalAccountId: "RS_1",
        amountCents: 1000,
        currency: "USD",
        reference: "SF-1",
      }),
    ).rejects.toThrow();
  });
});

describe("FlutterwaveProcessor.isConfigured", () => {
  it("is false without a secret key", () => {
    expect(new FlutterwaveProcessor("", "", jest.fn() as never).isConfigured()).toBe(false);
  });
  it("is true with a secret key", () => {
    expect(new FlutterwaveProcessor(SECRET, HASH, jest.fn() as never).isConfigured()).toBe(true);
  });
});
