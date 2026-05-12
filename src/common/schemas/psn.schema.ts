import { z } from "zod";

const tierSchema = z.enum(["SMALL", "MEDIUM", "LARGE", "X_LARGE", "PALLET"]);

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
  declaredBoxCounts: declaredBoxCountsSchema,
  notes: z.string().max(1000).optional(),
  lines: z.array(psnLineInputSchema).min(1, "At least one line is required."),
});
export type CreatePsnInput = z.infer<typeof createPsnSchema>;

export const updatePsnDraftSchema = createPsnSchema.partial();
export type UpdatePsnDraftInput = z.infer<typeof updatePsnDraftSchema>;

export const listPsnsSchema = z.object({
  status: z.enum(["DRAFT", "SUBMITTED", "AWAITING_RECEIPT", "PARTIALLY_RECEIVED", "RECEIVED", "DISCREPANCY", "CANCELLED"]).optional(),
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
