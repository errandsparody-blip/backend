import {
  buyerIdCheckPassed,
  buyerIdVerificationRequired,
  itemsSubtotalForIdGate,
  requiresIdVerificationAtSubtotal,
} from "./shopper-id-verification.util";

describe("shopper-id-verification.util", () => {
  const threshold = 100_000; // $1,000

  describe("requiresIdVerificationAtSubtotal", () => {
    it("requires ID at threshold", () => {
      expect(requiresIdVerificationAtSubtotal(100_000, threshold)).toBe(true);
    });

    it("skips ID below threshold", () => {
      expect(requiresIdVerificationAtSubtotal(99_999, threshold)).toBe(false);
    });
  });

  describe("buyerIdCheckPassed", () => {
    it("passes below threshold without APPROVED", () => {
      expect(
        buyerIdCheckPassed(
          {
            itemsSubtotalCents: 50_000,
            itemsActualSubtotalCents: null,
            idVerificationStatus: "PENDING_UPLOAD",
          },
          threshold,
        ),
      ).toBe(true);
    });

    it("blocks above threshold until APPROVED", () => {
      expect(
        buyerIdCheckPassed(
          {
            itemsSubtotalCents: 150_000,
            itemsActualSubtotalCents: null,
            idVerificationStatus: "PENDING_UPLOAD",
          },
          threshold,
        ),
      ).toBe(false);
      expect(
        buyerIdCheckPassed(
          {
            itemsSubtotalCents: 150_000,
            itemsActualSubtotalCents: null,
            idVerificationStatus: "APPROVED",
          },
          threshold,
        ),
      ).toBe(true);
    });

    it("uses quoted actuals over intake estimate", () => {
      expect(
        buyerIdCheckPassed(
          {
            itemsSubtotalCents: 200_000,
            itemsActualSubtotalCents: 80_000,
            idVerificationStatus: "PENDING_UPLOAD",
          },
          threshold,
        ),
      ).toBe(true);
      expect(itemsSubtotalForIdGate({ itemsSubtotalCents: 200_000, itemsActualSubtotalCents: 80_000 })).toBe(
        80_000,
      );
    });
  });

  describe("buyerIdVerificationRequired", () => {
    it("matches subtotal gate used by the buyer UI", () => {
      expect(
        buyerIdVerificationRequired(
          { itemsSubtotalCents: 150_000, itemsActualSubtotalCents: null },
          threshold,
        ),
      ).toBe(true);
    });
  });
});
