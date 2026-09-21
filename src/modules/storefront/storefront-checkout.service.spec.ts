import { BadRequestException } from "@nestjs/common";

// Deliverability does a live DNS lookup; stub it so checkout tests are
// deterministic and don't depend on the sandbox resolver.
jest.mock("../shopper/email-deliverability.util", () => ({
  assertEmailDeliverable: jest.fn().mockResolvedValue(undefined),
}));

import { StorefrontCheckoutService } from "./storefront-checkout.service";

function sqlText(q: { strings?: readonly string[]; sql?: string }): string {
  if (q.strings) return q.strings.join(" ");
  return String(q.sql ?? "");
}

const ADDR = {
  recipientName: "Jane",
  line1: "1 Main",
  city: "Austin",
  state: "TX",
  postalCode: "78701",
  country: "US",
};
const PRODUCT = "22222222-2222-2222-2222-222222222222";

function productRow() {
  return {
    id: PRODUCT,
    name: "Ankara Dress",
    retail_price_cents: 2500,
    weight_oz: 16,
    length_in: 10,
    width_in: 8,
    height_in: 3,
    available: 10,
  };
}

function makeDeps(opts: { rates: unknown[]; twoSpeeds?: boolean }) {
  const publicStore = {
    resolveBySlug: jest.fn().mockResolvedValue({ vendorId: "v1", slug: "acme" }),
  };
  const shippo = { getRates: jest.fn().mockResolvedValue({ shipmentId: "sh1", rates: opts.rates }) };
  const createCheckout = jest
    .fn()
    .mockResolvedValue({ checkoutUrl: "https://pay/x", paymentRef: "pi_1" });
  const createPlatformCheckout = jest
    .fn()
    .mockResolvedValue({ checkoutUrl: "https://pay/platform", paymentRef: "pi_cart" });
  const registry = {
    get: jest.fn().mockReturnValue({
      createCheckout,
      createPlatformCheckout,
      isConfigured: () => true,
      supportsPlatformCollection: () => true,
    }),
  };

  const executed: string[] = [];
  const prisma = {
    // Fee schedule for fulfillment math (base + per-additional-unit, capped).
    configuration: {
      findUnique: jest.fn().mockResolvedValue({
        value: {
          fulfillment: { baseCents: 300, perAdditionalUnitCents: 150, maxCents: 100_000 },
          shippingMarkupBps: 1000,
        },
      }),
    },
    $queryRaw: jest.fn(async (q: never) => {
      const t = sqlText(q);
      if (t.includes("FROM products")) return [productRow()];
      if (t.includes("FROM vendor_payout_accounts")) return [{ external_account_id: "acct_v" }];
      return [];
    }),
    $executeRaw: jest.fn(async (q: never) => {
      executed.push(sqlText(q));
      return 1;
    }),
    $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        $queryRaw: jest.fn(async (q: never) => {
          const t = sqlText(q);
          if (t.includes("nextval")) return [{ n: 1n }];
          if (t.includes("INSERT INTO storefront_orders")) return [{ id: "ord1" }];
          if (t.includes("FROM skus")) return [{ id: "sku1", free: 10 }];
          return [];
        }),
        $executeRaw: jest.fn(async () => 1),
      };
      return cb(tx);
    }),
  };

  const discounts = {
    quoteForCheckout: jest.fn(),
    redeem: jest.fn().mockResolvedValue(undefined),
  };
  const tax = { taxFor: jest.fn().mockResolvedValue(0) };
  const service = new StorefrontCheckoutService(
    prisma as never,
    shippo as never,
    registry as never,
    publicStore as never,
    discounts as never,
    tax as never,
  );
  return { service, createCheckout, createPlatformCheckout, executed, prisma, discounts, tax, shippo };
}

const STD_ONLY = [
  { rateId: "r1", shipmentId: "s", carrier: "USPS", service: "Ground", estimatedDeliveryDays: 4, costCents: 800 },
];
const TWO = [
  { rateId: "r1", shipmentId: "s", carrier: "USPS", service: "Ground", estimatedDeliveryDays: 5, costCents: 800 },
  { rateId: "r2", shipmentId: "s", carrier: "UPS", service: "Express", estimatedDeliveryDays: 2, costCents: 2200 },
];

describe("StorefrontCheckoutService.quote", () => {
  it("prices the cart and returns options without the internal service token", async () => {
    const { service } = makeDeps({ rates: TWO });
    const q = await service.quote("acme", {
      items: [{ productId: PRODUCT, quantity: 2 }],
      shipAddress: ADDR,
    });
    expect(q.productSubtotalCents).toBe(5000);
    expect(q.shippingOptions.map((o) => o.speed)).toEqual(["STANDARD", "EXPRESS"]);
    expect(q.shippingOptions[0]).not.toHaveProperty("serviceToken");
  });
});

describe("StorefrontCheckoutService.quoteCrossVendor", () => {
  it("returns ONE consolidated shipping quote for the whole cart", async () => {
    const { service, shippo } = makeDeps({ rates: TWO });
    const q = await service.quoteCrossVendor({
      shipAddress: ADDR,
      groups: [
        { slug: "acme", items: [{ productId: PRODUCT, quantity: 1 }] },
        { slug: "beta", items: [{ productId: PRODUCT, quantity: 2 }] },
      ],
    });
    // 2500 (qty 1) + 5000 (qty 2), summed across vendors.
    expect(q.productSubtotalCents).toBe(7500);
    expect(q.shippingOptions.map((o) => o.speed)).toEqual(["STANDARD", "EXPRESS"]);
    // A single combined-parcel estimate — not one Shippo call per store.
    expect(shippo.getRates).toHaveBeenCalledTimes(1);
  });
});

describe("StorefrontCheckoutService.createCrossVendorOrder", () => {
  const shared = {
    shipAddress: ADDR,
    buyerEmail: "buyer@gmail.com",
    // One delivery speed for the whole cart.
    shippingSpeed: "STANDARD" as const,
    groups: [
      { slug: "acme", items: [{ productId: PRODUCT, quantity: 1 }], processor: "STRIPE" as const },
      { slug: "beta", items: [{ productId: PRODUCT, quantity: 2 }], processor: "FLUTTERWAVE" as const },
    ],
  };

  it("charges shipping once across the cart and returns a checkout per store", async () => {
    const { service, createCheckout, shippo } = makeDeps({ rates: TWO });
    const res = await service.createCrossVendorOrder(shared);
    expect(res.results).toHaveLength(2);
    expect(res.errors).toHaveLength(0);
    expect(res.results.map((r) => r.slug)).toEqual(["acme", "beta"]);
    // One consolidated shipping estimate for the cart.
    expect(shippo.getRates).toHaveBeenCalledTimes(1);
    // Buyer pays product + delivery only — fulfillment is charged to the vendor's
    // wallet, NOT the buyer. So platform fee = shipping (+ tax). Shipping (800) is
    // charged once on one leg; the other leg has no shipping and no tax → 0.
    const fees = createCheckout.mock.calls.map((c) => (c[0] as { platformFeeCents: number }).platformFeeCents).sort((a, b) => a - b);
    expect(fees).toEqual([0, 800]);
  });

  it("unified mode: opens ONE platform charge and returns a single cart result", async () => {
    const OLD = process.env.STOREFRONT_UNIFIED_CART_PAYMENT;
    process.env.STOREFRONT_UNIFIED_CART_PAYMENT = "true";
    try {
      const { service, createPlatformCheckout, createCheckout } = makeDeps({ rates: TWO });
      const res = await service.createCrossVendorOrder(shared);
      expect(res.errors).toHaveLength(0);
      // One result for the whole cart (single "Complete payment" button).
      expect(res.results).toHaveLength(1);
      expect(res.results[0]!.slug).toBe("cart");
      expect(res.results[0]!.reference).toMatch(/^CART-/);
      // Exactly one platform charge; no per-vendor destination charges.
      expect(createPlatformCheckout).toHaveBeenCalledTimes(1);
      expect(createCheckout).not.toHaveBeenCalled();
      // Charge total = Σ sub-order totals (product + shipping only; fulfillment is
      // billed to vendor wallets, not the buyer): acme 3300 (2500+800) + beta 5000
      // (5000+0) = 8300.
      expect((createPlatformCheckout.mock.calls[0][0] as { amountCents: number }).amountCents).toBe(8300);
    } finally {
      process.env.STOREFRONT_UNIFIED_CART_PAYMENT = OLD;
    }
  });

  it("reports a leg whose payment fails without dropping the others", async () => {
    const { service, createCheckout } = makeDeps({ rates: TWO });
    createCheckout
      .mockResolvedValueOnce({ checkoutUrl: "https://pay/1", paymentRef: "pi_1" })
      .mockRejectedValueOnce(new Error("processor down"));
    const res = await service.createCrossVendorOrder(shared);
    expect(res.results).toHaveLength(1);
    expect(res.results[0]!.slug).toBe("acme");
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]!.slug).toBe("beta");
    expect(res.errors[0]!.code).toBe("storefront_checkout_failed");
  });
});

describe("StorefrontCheckoutService.sweepAbandonedReservations", () => {
  function makeSweep(stale: Array<{ id: string; items: unknown }>, updateReturns: Array<{ id: string }>) {
    const skuUpdates: string[] = [];
    const prisma = {
      $queryRaw: jest.fn(async (q: never) => {
        if (sqlText(q).includes("FROM storefront_orders")) return stale;
        return [];
      }),
      $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({
          $queryRaw: jest.fn(async (q: never) =>
            sqlText(q).includes("UPDATE storefront_orders") ? updateReturns : [],
          ),
          $executeRaw: jest.fn(async (q: never) => {
            if (sqlText(q).includes("UPDATE skus")) skuUpdates.push("sku");
            return 1;
          }),
        }),
      ),
    };
    const service = new StorefrontCheckoutService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, skuUpdates };
  }

  it("releases + cancels an abandoned order and frees its stock", async () => {
    const { service, skuUpdates } = makeSweep(
      [{ id: "so1", items: [{ allocations: [{ skuId: "sku1", qty: 2 }] }] }],
      [{ id: "so1" }],
    );
    const released = await service.sweepAbandonedReservations(60);
    expect(released).toBe(1);
    expect(skuUpdates.length).toBe(1); // one SKU freed
  });

  it("skips an order that was paid in the meantime (guard returns 0 rows)", async () => {
    const { service, skuUpdates } = makeSweep(
      [{ id: "so1", items: [{ allocations: [{ skuId: "sku1", qty: 2 }] }] }],
      [],
    );
    const released = await service.sweepAbandonedReservations(60);
    expect(released).toBe(0);
    expect(skuUpdates.length).toBe(0);
  });
});

describe("StorefrontCheckoutService.createOrder", () => {
  it("rejects a delivery speed that isn't available", async () => {
    const { service } = makeDeps({ rates: STD_ONLY });
    await expect(
      service.createOrder("acme", {
        items: [{ productId: PRODUCT, quantity: 1 }],
        shipAddress: ADDR,
        buyerEmail: "buyer@gmail.com",
        shippingSpeed: "EXPRESS",
        processor: "STRIPE",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("reserves stock, creates the order, and opens a split checkout", async () => {
    const { service, createCheckout } = makeDeps({ rates: TWO });
    const res = await service.createOrder("acme", {
      items: [{ productId: PRODUCT, quantity: 2 }],
      shipAddress: ADDR,
      buyerEmail: "buyer@gmail.com",
      shippingSpeed: "STANDARD",
      processor: "STRIPE",
    });
    expect(res.reference).toBe("SF-000001");
    expect(res.checkoutUrl).toBe("https://pay/x");
    // Buyer pays product + delivery only (fulfillment is charged to the vendor
    // wallet, not the buyer): total = product(5000) + shipping(800) = 5800;
    // platform fee = shipping(800).
    expect(createCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 5800, platformFeeCents: 800, currency: "USD" }),
    );
  });
});
