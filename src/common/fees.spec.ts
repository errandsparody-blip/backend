/**
 * Pure-math unit tests for computeOnboardingFeeCents.
 *
 * Every cent here lands on the ledger and on the receipt the vendor
 * sees, so the math has to be unambiguous and the mode validation has
 * to fail fast and fail structurally (stable error code, not a NaN
 * silently propagated into the wallet debit).
 *
 * Fixture uses round numbers ($1, $2, $4, $5 stocking; $1, $2, $4, $6
 * storage; $45 pallet/mo) so any failure is easy to read at a glance.
 */

import {
  InvalidShippingDeclarationError,
  MissingTierFeeError,
  NegotiatedTierError,
  computeOnboardingFeeCents,
} from "./fees";
import type { FeeSchedule } from "./fees";

// Per-tier:
//   stocking = $1, $2, $4, $5
//   firstMonthStorage = $1, $2, $4, $6
//   totalCents = stocking + firstMonthStorage
// Pallet:
//   monthlyStorage.PALLET = $45 (the seeded production rate, kept real
//   here so the assertion that the pallet line equals $45 is self-
//   documenting against the rest of the codebase).
const SCHEDULE: FeeSchedule = {
  onboarding: {
    SMALL:   { stockingCents: 100, firstMonthStorageCents: 100, totalCents: 200 },
    MEDIUM:  { stockingCents: 200, firstMonthStorageCents: 200, totalCents: 400 },
    LARGE:   { stockingCents: 400, firstMonthStorageCents: 400, totalCents: 800 },
    X_LARGE: { stockingCents: 500, firstMonthStorageCents: 600, totalCents: 1100 },
    PALLET:  { negotiated: true },
  },
  monthlyStorage: { SMALL: 100, MEDIUM: 200, LARGE: 400, X_LARGE: 600, PALLET: 4500 },
  fulfillment: { baseCents: 299, perAdditionalUnitCents: 99 },
  returnsHandlingCents: 500,
  shippingMarkupBps: 1000,
};

describe("computeOnboardingFeeCents — LOOSE mode", () => {
  it("charges stocking + first-month storage per box for a single tier", () => {
    const r = computeOnboardingFeeCents(SCHEDULE, { MEDIUM: 4 }, "LOOSE");
    // 4 × $4 (= stocking $2 + first-month $2) = $16
    expect(r.totalCents).toBe(1600);
    expect(r.perTier).toEqual([{ tier: "MEDIUM", count: 4, subtotalCents: 1600 }]);
  });

  it("sums across multiple tiers", () => {
    const r = computeOnboardingFeeCents(
      SCHEDULE,
      { SMALL: 2, MEDIUM: 1, LARGE: 1 },
      "LOOSE",
    );
    // 2 × 200 + 1 × 400 + 1 × 800 = 1600
    expect(r.totalCents).toBe(1600);
    expect(r.perTier).toHaveLength(3);
  });

  it("rejects a PALLET tier in the declaration with code psn_invalid_shipping_declaration", () => {
    expect(() =>
      computeOnboardingFeeCents(SCHEDULE, { MEDIUM: 2, PALLET: 1 }, "LOOSE"),
    ).toThrow(InvalidShippingDeclarationError);
  });

  it("propagates NegotiatedTierError for a tier marked negotiated", () => {
    const negotiatedSchedule: FeeSchedule = {
      ...SCHEDULE,
      onboarding: { ...SCHEDULE.onboarding, MEDIUM: { negotiated: true } },
    };
    expect(() =>
      computeOnboardingFeeCents(negotiatedSchedule, { MEDIUM: 1 }, "LOOSE"),
    ).toThrow(NegotiatedTierError);
  });

  it("propagates MissingTierFeeError when a declared tier has no schedule row", () => {
    const incompleteSchedule: FeeSchedule = {
      ...SCHEDULE,
      onboarding: {
        ...SCHEDULE.onboarding,
        // Cast through unknown — we're deliberately constructing an
        // invalid shape to exercise the defensive branch.
        MEDIUM: undefined as unknown as FeeSchedule["onboarding"]["MEDIUM"],
      },
    };
    expect(() =>
      computeOnboardingFeeCents(incompleteSchedule, { MEDIUM: 1 }, "LOOSE"),
    ).toThrow(MissingTierFeeError);
  });
});

describe("computeOnboardingFeeCents — PALLET mode", () => {
  it("charges stocking-only per box + pallet's $45 first-month line", () => {
    const r = computeOnboardingFeeCents(
      SCHEDULE,
      { MEDIUM: 4, PALLET: 1 },
      "PALLET",
    );
    // 4 × $2 stocking + 1 × $45 pallet first-month = $8 + $45 = $53
    expect(r.totalCents).toBe(4 * 200 + 4500);
    // perTier is keyed in iteration order over the declared object, so
    // assert by content rather than position.
    expect(r.perTier).toEqual(
      expect.arrayContaining([
        { tier: "MEDIUM", count: 4, subtotalCents: 800 },
        { tier: "PALLET", count: 1, subtotalCents: 4500 },
      ]),
    );
  });

  it("rejects when no PALLET tier is declared", () => {
    expect(() =>
      computeOnboardingFeeCents(SCHEDULE, { MEDIUM: 4 }, "PALLET"),
    ).toThrow(InvalidShippingDeclarationError);
  });

  it("handles multiple pallets (each adds another $45)", () => {
    const r = computeOnboardingFeeCents(
      SCHEDULE,
      { MEDIUM: 24, PALLET: 2 },
      "PALLET",
    );
    // 24 × $2 + 2 × $45 = $48 + $90 = $138
    expect(r.totalCents).toBe(24 * 200 + 2 * 4500);
  });
});

describe("computeOnboardingFeeCents — ADD_TO_PALLET mode", () => {
  it("charges stocking only — no pallet line, no first-month storage", () => {
    const r = computeOnboardingFeeCents(
      SCHEDULE,
      { MEDIUM: 4 },
      "ADD_TO_PALLET",
    );
    // 4 × $2 stocking = $8. Crucially, NOT $4 (which would be the
    // loose-mode per-box total) and NOT $8 + $45 (which would be the
    // pallet-mode line).
    expect(r.totalCents).toBe(800);
    expect(r.perTier).toEqual([{ tier: "MEDIUM", count: 4, subtotalCents: 800 }]);
  });

  it("rejects a declaration with a PALLET tier (no new pallet is being created)", () => {
    expect(() =>
      computeOnboardingFeeCents(
        SCHEDULE,
        { MEDIUM: 4, PALLET: 1 },
        "ADD_TO_PALLET",
      ),
    ).toThrow(InvalidShippingDeclarationError);
  });

  it("rejects a declaration with more than one box tier (pallets are uniform-tier per policy)", () => {
    expect(() =>
      computeOnboardingFeeCents(
        SCHEDULE,
        { SMALL: 2, MEDIUM: 2 },
        "ADD_TO_PALLET",
      ),
    ).toThrow(InvalidShippingDeclarationError);
  });

  it("rejects a declaration with no box tiers", () => {
    expect(() =>
      // The Zod layer also rejects this (declaredBoxCountsSchema requires
      // at least one positive entry) but we test the service layer's own
      // guard to keep the contract enforced even if the schema changes.
      computeOnboardingFeeCents(SCHEDULE, { SMALL: 0 }, "ADD_TO_PALLET"),
    ).toThrow(InvalidShippingDeclarationError);
  });

  it("produces the same per-box stocking as PALLET mode (vendor saves only on storage)", () => {
    // This is the core economic guarantee: adding to an existing pallet
    // costs the SAME per-box stocking as creating a new pallet. The only
    // saving is the $45 pallet line — which makes sense because the
    // existing pallet already has its $45/mo running.
    const palletMode = computeOnboardingFeeCents(
      SCHEDULE,
      { LARGE: 3, PALLET: 1 },
      "PALLET",
    );
    const addToPalletMode = computeOnboardingFeeCents(
      SCHEDULE,
      { LARGE: 3 },
      "ADD_TO_PALLET",
    );
    expect(addToPalletMode.totalCents).toBe(palletMode.totalCents - 4500);
  });
});
