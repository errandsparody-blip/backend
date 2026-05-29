import { z } from "zod";

const tierSchema = z.enum(["SMALL", "MEDIUM", "LARGE", "X_LARGE", "PALLET"]);

// Migration 0033 — explicit shipping mode. LOOSE is the default so any
// client that hasn't been updated to send the field continues to work
// identically to the pre-migration behaviour (per-box stocking + first-
// month storage). The fee math layer validates the declaration shape
// against the mode and surfaces a structured 400 on mismatch.
export const shippingModeSchema = z.enum(["LOOSE", "PALLET", "ADD_TO_PALLET"]);
export type ShippingModeInput = z.infer<typeof shippingModeSchema>;

export const psnLineInputSchema = z.object({
  productId: z.string().uuid(),
  declaredQty: z.number().int().positive().max(100_000),
  notes: z.string().max(500).optional(),
});
export type PsnLineInput = z.infer<typeof psnLineInputSchema>;

export const declaredBoxCountsSchema = z
  .record(tierSchema, z.number().int().nonnegative().max(1000))
  .refine((obj) => Object.values(obj).some((v) => (v ?? 0) > 0), {
    message: "Declare at least one box.",
  });

export const createPsnSchema = z.object({
  expectedArrivalDate: z.coerce.date().optional(),
  carrier: z.string().min(2).max(60).optional(),
  masterTracking: z.string().min(3).max(80).optional(),
  shippingMode: shippingModeSchema.default("LOOSE"),
  declaredBoxCounts: declaredBoxCountsSchema,
  notes: z.string().max(1000).optional(),
  lines: z.array(psnLineInputSchema).min(1, "At least one line is required."),
});
export type CreatePsnInput = z.infer<typeof createPsnSchema>;

export const updatePsnDraftSchema = createPsnSchema.partial();
export type UpdatePsnDraftInput = z.infer<typeof updatePsnDraftSchema>;

// All PSN statuses the admin queue or vendor list may filter on. Includes
// the post-Migration-0020 lifecycle states (HOLD / REJECTED /
// RETURN_REQUESTED) so the admin "Received history" tab can surface them
// alongside RECEIVED and DISCREPANCY.
const PSN_STATUS_ENUM = z.enum([
  "DRAFT",
  "SUBMITTED",
  "AWAITING_RECEIPT",
  "PARTIALLY_RECEIVED",
  "RECEIVED",
  "DISCREPANCY",
  "CANCELLED",
  "HOLD",
  "REJECTED",
  "RETURN_REQUESTED",
]);

export const listPsnsSchema = z.object({
  // Accept either a single status or a comma-separated list. The
  // History tab in the admin receiving page sends a four-status list
  // (e.g. "RECEIVED,DISCREPANCY,REJECTED,RETURN_REQUESTED"); the legacy
  // vendor list endpoint and the inbox view send a single status or
  // nothing. We preprocess into an array of valid statuses so the
  // downstream service always sees one shape.
  status: z
    .preprocess(
      (v) => {
        if (v === undefined || v === null || v === "") return undefined;
        if (Array.isArray(v)) return v;
        if (typeof v === "string") {
          const parts = v.split(",").map((x) => x.trim()).filter(Boolean);
          return parts.length === 1 ? parts[0] : parts;
        }
        return v;
      },
      z.union([PSN_STATUS_ENUM, z.array(PSN_STATUS_ENUM).min(1)]),
    )
    .optional(),
  // Optional vendor scope. Super admin uses this to narrow the History
  // tab to a single vendor's shipments without losing the cross-vendor
  // default.
  vendorId: z.string().uuid().optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
});
export type ListPsnsInput = z.infer<typeof listPsnsSchema>;

// ---- admin (operator) receiving ----
export const receiveLineSchema = z.object({
  lineId: z.string().uuid(),
  acceptedQty: z.number().int().nonnegative(),
  damagedQty: z.number().int().nonnegative().default(0),
  // Migration 0024 — items declared but not in the box (courier loss,
  // mispack, etc.). Distinct from damagedQty because the financial story
  // is different; persisted for the audit trail.
  missingQty: z.number().int().nonnegative().default(0),
  notes: z.string().max(500).optional(),
});
export type ReceiveLineInput = z.infer<typeof receiveLineSchema>;

export const completeReceivingSchema = z.object({
  lines: z.array(receiveLineSchema).min(1),
});
export type CompleteReceivingInput = z.infer<typeof completeReceivingSchema>;

// Migration 0024 — PSN chat thread. Both vendor + admin post into the
// same shape; the controller derives sender from the authenticated user.
export const postPsnMessageSchema = z.object({
  body: z.string().trim().min(1, "Message can't be empty.").max(10_000),
  attachmentUrls: z
    .array(z.string().url().max(2048))
    .max(10, "Up to 10 attachments per message.")
    .optional()
    .default([]),
});
export type PostPsnMessageInput = z.infer<typeof postPsnMessageSchema>;

// ---------------------------------------------------------------------------
// Phase 2 — admin receiving actions beyond Accept / Edit & Accept.
// ---------------------------------------------------------------------------

/**
 * Stable reason codes for placing a Hold. Free-text explanation lives in
 * reasonNote; the code is what we filter / report on. Keep aligned with the
 * UI dropdown on the admin receive page.
 */
export const PSN_HOLD_REASON_CODES = [
  "WRONG_TIER",        // Vendor declared SMALL, package is MEDIUM/LARGE/etc.
  "PACKAGING_FEE",     // Non-standard packaging requires repackaging fee.
  "DISCREPANCY_FEE",   // Item count mismatch handling fee.
  "ADDITIONAL_HANDLING", // Oversize, fragile, hazardous, etc.
  "OTHER",
] as const;

export const placeHoldSchema = z.object({
  // Cents. Positive integer. 50¢ minimum so admin can't accidentally
  // create a 1¢ hold with no operational meaning.
  extraChargeCents: z
    .number()
    .int()
    .min(50, "Hold charge must be at least $0.50.")
    .max(5_000_000, "Hold charge cannot exceed $50,000."),
  reasonCode: z.enum(PSN_HOLD_REASON_CODES),
  // Plain text shown to the vendor on their dashboard banner + in email.
  reasonNote: z.string().trim().min(10, "Explain the reason in at least 10 characters.").max(500),
});
export type PlaceHoldInput = z.infer<typeof placeHoldSchema>;

export const rejectPsnSchema = z.object({
  reason: z.string().trim().min(10, "Explain the rejection in at least 10 characters.").max(500),
});
export type RejectPsnInput = z.infer<typeof rejectPsnSchema>;

// Close out a DISCREPANCY PSN with the previously-recorded quantities
// accepted as final. The note is required so the audit log has a
// human-readable record of how the discrepancy was reconciled
// (vendor confirmation, follow-up shipment arrived separately, etc).
export const resolveDiscrepancySchema = z.object({
  resolutionNote: z
    .string()
    .trim()
    .min(10, "Describe how the discrepancy was resolved in at least 10 characters.")
    .max(500),
});
export type ResolveDiscrepancyInput = z.infer<typeof resolveDiscrepancySchema>;

export const requestPsnReturnSchema = z.object({
  reason: z.string().trim().min(10, "Explain the return reason in at least 10 characters.").max(500),
  // Estimated return shipping. Admin enters this from their carrier quote
  // (or 0 if the vendor's storefront agreement waives it). Wallet debits
  // this amount immediately so the package isn't shipped before the vendor
  // is on the hook.
  returnShippingCents: z
    .number()
    .int()
    .min(0, "Return shipping cannot be negative.")
    .max(10_000_000, "Return shipping cannot exceed $100,000."),
});
export type RequestPsnReturnInput = z.infer<typeof requestPsnReturnSchema>;
