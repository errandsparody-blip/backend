/**
 * Pure-math unit tests for order fees. The math has to be unambiguous and
 * round-trip-safe, because every cent here ends up on the ledger.
 */

import { aggregateParcel, computeOrderFees } from "./order-fees";
import type { FeeSchedule } from "./fees";

const SCHEDULE: FeeSchedule = {
  onboarding: {
    SMALL: { stockingCents: 100, firstMonthStorageCents: 100, totalCents: 200 },
    MEDIUM: { stockingCents: 200, firstMonthStorageCents: 200, totalCents: 400 },
    LARGE: { stockingCents: 300, firstMonthStorageCents: 400, totalCents: 700 },
    X_LARGE: { stockingCents: 500, firstMonthStorageCents: 600, totalCents: 1100 },
    PALLET: { negotiated: true },
  },
  monthlyStorage: { SMALL: 100, MEDIUM: 200, LARGE: 400, X_LARGE: 600, PALLET: null },
  fulfillment: { baseCents: 250, perAdditionalUnitCents: 75, maxCents: 100_000 },
  returnsHandlingCents: 500,
  shippingMarkupBps: 1000, // 10%
};

describe("computeOrderFees", () => {
  it("base case: 1 unit, $5.00 carrier cost, no insurance", () => {
    const r = computeOrderFees({
      schedule: SCHEDULE,
      totalUnits: 1,
      carrierCostCents: 500,
      declaredValueCents: 2500,
      insuranceRequested: false,
    });
    // 10% markup of 500 = 50, rounded up. shipping fee = 550.
    expect(r.shippingCostCents).toBe(500);
    expect(r.shippingFeeCents).toBe(550);
    // Fulfillment: base only.
    expect(r.fulfillmentFeeCents).toBe(250);
    // No insurance.
    expect(r.insuranceFeeCents).toBe(0);
    expect(r.totalChargedCents).toBe(800);
  });

  it("4 units → fulfillment is base + 3 × per-unit", () => {
    const r = computeOrderFees({
      schedule: SCHEDULE,
      totalUnits: 4,
      carrierCostCents: 1000,
      declaredValueCents: 12000,
      insuranceRequested: false,
    });
    expect(r.fulfillmentFeeCents).toBe(250 + 3 * 75); // 475
    expect(r.shippingFeeCents).toBe(1100);            // 1000 + 100 markup
    expect(r.totalChargedCents).toBe(475 + 1100);
  });

  it("insurance: 1.5% of declared, rounded UP", () => {
    const r = computeOrderFees({
      schedule: SCHEDULE,
      totalUnits: 1,
      carrierCostCents: 500,
      declaredValueCents: 12345, // 1.5% = 185.175 → 186
      insuranceRequested: true,
    });
    expect(r.insuranceFeeCents).toBe(186);
    expect(r.totalChargedCents).toBe(550 + 250 + 186);
  });

  it("rounds shipping markup UP to never under-bill", () => {
    // 333 cents × 10% = 33.3 → markup 34 → shippingFee 367.
    const r = computeOrderFees({
      schedule: SCHEDULE,
      totalUnits: 1,
      carrierCostCents: 333,
      declaredValueCents: 0,
      insuranceRequested: false,
    });
    expect(r.shippingFeeCents).toBe(367);
  });

  it("honours a configurable shipping markup from the schedule", () => {
    // 20% markup of 500 = 100 → shipping fee 600.
    const r = computeOrderFees({
      schedule: { ...SCHEDULE, shippingMarkupBps: 2000 },
      totalUnits: 1,
      carrierCostCents: 500,
      declaredValueCents: 0,
      insuranceRequested: false,
    });
    expect(r.shippingFeeCents).toBe(600);
  });

  it("a zero markup passes the carrier cost straight through", () => {
    const r = computeOrderFees({
      schedule: { ...SCHEDULE, shippingMarkupBps: 0 },
      totalUnits: 1,
      carrierCostCents: 500,
      declaredValueCents: 0,
      insuranceRequested: false,
    });
    expect(r.shippingFeeCents).toBe(500);
  });

  it("falls back to the default markup when the field is missing", () => {
    // Simulate a schedule row written before shippingMarkupBps existed.
    const legacy = { ...SCHEDULE } as FeeSchedule;
    delete (legacy as Partial<FeeSchedule>).shippingMarkupBps;
    const r = computeOrderFees({
      schedule: legacy,
      totalUnits: 1,
      carrierCostCents: 500,
      declaredValueCents: 0,
      insuranceRequested: false,
    });
    expect(r.shippingFeeCents).toBe(550); // default 10%
  });

  describe("fulfillment fee cap", () => {
    // Production-shaped schedule: $2.99 base + $0.99/extra, capped at $10.99.
    const capped: FeeSchedule = {
      ...SCHEDULE,
      fulfillment: { baseCents: 299, perAdditionalUnitCents: 99, maxCents: 1099 },
    };
    const fulfillmentFor = (units: number, schedule: FeeSchedule = capped): number =>
      computeOrderFees({
        schedule,
        totalUnits: units,
        carrierCostCents: 0,
        declaredValueCents: 0,
        insuranceRequested: false,
      }).fulfillmentFeeCents;

    it("9 items stays under the cap (299 + 8×99 = 1091)", () => {
      expect(fulfillmentFor(9)).toBe(1091);
    });

    it("10 items is capped (1190 → 1099)", () => {
      expect(fulfillmentFor(10)).toBe(1099);
    });

    it("11 and 12 items are also capped at 1099", () => {
      expect(fulfillmentFor(11)).toBe(1099);
      expect(fulfillmentFor(12)).toBe(1099);
    });

    it("falls back to the default cap when maxCents is missing", () => {
      const legacy = {
        ...capped,
        fulfillment: { baseCents: 299, perAdditionalUnitCents: 99 },
      } as unknown as FeeSchedule;
      // 10 items uncapped = 1190 → default $10.99 cap applies.
      expect(fulfillmentFor(10, legacy)).toBe(1099);
    });
  });

  it("rejects bad inputs", () => {
    expect(() =>
      computeOrderFees({
        schedule: SCHEDULE,
        totalUnits: 0,
        carrierCostCents: 100,
        declaredValueCents: 0,
        insuranceRequested: false,
      }),
    ).toThrow();
    expect(() =>
      computeOrderFees({
        schedule: SCHEDULE,
        totalUnits: 1,
        carrierCostCents: -1,
        declaredValueCents: 0,
        insuranceRequested: false,
      }),
    ).toThrow();
    expect(() =>
      computeOrderFees({
        schedule: SCHEDULE,
        totalUnits: 1,
        carrierCostCents: 1.5,
        declaredValueCents: 0,
        insuranceRequested: false,
      }),
    ).toThrow();
  });
});

describe("aggregateParcel", () => {
  it("sums weights, takes max of length/width, stacks heights", () => {
    const r = aggregateParcel([
      { qty: 2, weightOz: 8, lengthIn: 10, widthIn: 6, heightIn: 2 },
      { qty: 1, weightOz: 4, lengthIn: 12, widthIn: 4, heightIn: 3 },
    ]);
    expect(r.weightOz).toBe(20); // 8*2 + 4*1
    expect(r.lengthIn).toBe(12);
    expect(r.widthIn).toBe(6);
    expect(r.heightIn).toBe(2 * 2 + 3 * 1); // 7
  });

  it("ignores zero-qty lines", () => {
    const r = aggregateParcel([
      { qty: 0, weightOz: 8, lengthIn: 10, widthIn: 6, heightIn: 2 },
      { qty: 1, weightOz: 4, lengthIn: 4, widthIn: 4, heightIn: 4 },
    ]);
    expect(r.weightOz).toBe(4);
  });

  it("rejects empty input", () => {
    expect(() => aggregateParcel([])).toThrow();
  });
});
