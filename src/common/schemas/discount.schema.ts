/**
 * Discount-code schemas (Migration 0059, Layer 8).
 *
 * Two scopes:
 *   VENDOR      — a vendor's own code; only ever discounts THAT vendor's goods.
 *   MARKETPLACE — a super-admin code targeting all vendors (no vendorIds) or a
 *                 chosen subset (vendorIds).
 */
import { z } from "zod";

const codeField = z
  .string()
  .trim()
  .toUpperCase()
  .min(3, "At least 3 characters.")
  .max(40, "At most 40 characters.")
  .regex(/^[A-Z0-9][A-Z0-9-]*$/, "Letters, numbers and hyphens only.");

const baseDiscount = z
  .object({
    code: codeField,
    discountType: z.enum(["PERCENT", "FIXED"]),
    // PERCENT uses basis points (1000 = 10%); FIXED uses cents.
    valueBps: z.number().int().positive().max(10_000).optional(),
    valueCents: z.number().int().positive().max(100_000_000).optional(),
    startsAt: z.coerce.date().optional(),
    endsAt: z.coerce.date().optional(),
    minSubtotalCents: z.number().int().nonnegative().max(100_000_000).optional(),
    maxRedemptions: z.number().int().positive().max(1_000_000).optional(),
  })
  .refine((v) => (v.discountType === "PERCENT" ? v.valueBps != null : true), {
    message: "Percentage discounts need a percentage value.",
    path: ["valueBps"],
  })
  .refine((v) => (v.discountType === "FIXED" ? v.valueCents != null : true), {
    message: "Fixed discounts need an amount.",
    path: ["valueCents"],
  })
  .refine((v) => !(v.startsAt && v.endsAt) || v.endsAt > v.startsAt, {
    message: "End date must be after the start date.",
    path: ["endsAt"],
  });

export const createVendorDiscountSchema = baseDiscount;
export type CreateVendorDiscountInput = z.infer<typeof createVendorDiscountSchema>;

// Marketplace codes add optional vendor targeting. z.intersection keeps the
// base refinements intact while extending the object.
export const createMarketplaceDiscountSchema = z.intersection(
  baseDiscount,
  z.object({ vendorIds: z.array(z.string().uuid()).max(500).optional() }),
);
export type CreateMarketplaceDiscountInput = z.infer<typeof createMarketplaceDiscountSchema>;

export const setDiscountActiveSchema = z.object({ active: z.boolean() });
export type SetDiscountActiveInput = z.infer<typeof setDiscountActiveSchema>;

export const validateDiscountSchema = z.object({
  code: codeField,
  subtotalCents: z.number().int().positive().max(100_000_000),
});
export type ValidateDiscountInput = z.infer<typeof validateDiscountSchema>;
