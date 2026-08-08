/**
 * Returns API Zod schemas.
 *
 * Implementation Plan §6.7.
 */

import { z } from "zod";

export const RETURN_REASON = [
  "NOT_AS_DESCRIBED",
  "DEFECTIVE",
  "WRONG_ITEM",
  "CHANGED_MIND",
  "ARRIVED_DAMAGED",
  "NEVER_DELIVERED",
  "OTHER",
] as const;
export type ReturnReason = (typeof RETURN_REASON)[number];

export const RETURN_STATUS = [
  "REQUESTED",
  "AUTHORIZED",
  "IN_TRANSIT",
  "RECEIVED",
  "INSPECTED",
  "INSTRUCTED",
  "RESTOCKED",
  "DISPOSED",
  "DONATED",
  "REJECTED",
  "CANCELLED",
] as const;
export type ReturnStatus = (typeof RETURN_STATUS)[number];

// ---------------------------------------------------------------------------
// Vendor — create + cancel
// ---------------------------------------------------------------------------

export const createReturnLineSchema = z.object({
  orderLineId: z.string().uuid(),
  requestedQty: z.number().int().positive().max(10_000),
});
export type CreateReturnLineInput = z.infer<typeof createReturnLineSchema>;

export const createReturnSchema = z.object({
  orderId: z.string().uuid(),
  reason: z.enum(RETURN_REASON),
  lines: z.array(createReturnLineSchema).min(1).max(50),
  // Returns v2 — the customer ships the return on their own dime, so
  // the vendor supplies the inbound TRACKING and an EXPECTED DELIVERY
  // DATE at creation. USA Errands does not buy an inbound label.
  inboundCarrier: z.string().trim().min(1).max(60).optional(),
  inboundTracking: z
    .string()
    .trim()
    .min(1, "Return tracking number is required.")
    .max(128),
  expectedDeliveryDate: z.coerce.date({
    errorMap: () => ({ message: "Provide the expected delivery date." }),
  }),
  // Migration 0018 — optional photo / screenshot evidence the vendor
  // attaches at RMA-creation time. Capped at 5 to keep R2 + the
  // inspector UI sane. Each URL is a public R2 link returned by the
  // presigned-PUT flow exposed at POST /returns/uploads.
  attachmentUrls: z
    .array(z.string().url().max(2048))
    .max(5, "Up to 5 attachments per RMA.")
    .optional()
    .default([]),
});
export type CreateReturnInput = z.infer<typeof createReturnSchema>;

// ---------------------------------------------------------------------------
// Vendor — disposition instructions (Returns v2)
// ---------------------------------------------------------------------------
//
// After USA Errands inspects and shares photos, the vendor tells us how
// to handle each received line: restock / dispose / donate. The three
// quantities must sum to the received quantity for that line (validated
// against the DB in the service).

export const instructReturnLineSchema = z.object({
  returnLineId: z.string().uuid(),
  restockQty: z.number().int().nonnegative().max(10_000).default(0),
  disposeQty: z.number().int().nonnegative().max(10_000).default(0),
  donateQty: z.number().int().nonnegative().max(10_000).default(0),
});
export type InstructReturnLineInput = z.infer<typeof instructReturnLineSchema>;

export const instructReturnSchema = z.object({
  lines: z.array(instructReturnLineSchema).min(1),
});
export type InstructReturnInput = z.infer<typeof instructReturnSchema>;

export const listReturnsSchema = z.object({
  status: z.enum(RETURN_STATUS).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
});
export type ListReturnsInput = z.infer<typeof listReturnsSchema>;

// ---------------------------------------------------------------------------
// Vendor — presign attachment upload (photo evidence at RMA creation)
// ---------------------------------------------------------------------------
//
// Same MIME allow-list + 25 MB cap as the shopper attachments. Excluding
// HTML / SVG so an attacker can't get an XSS-capable file hosted on the
// same origin as the buyer-facing pages.

export const RETURN_UPLOAD_ALLOWED_MIME = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "application/pdf",
] as const;

export const RETURN_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

export const presignReturnUploadSchema = z.object({
  filename: z
    .string()
    .trim()
    .min(1, "Filename required.")
    .max(200, "Filename too long.")
    // Disallow path separators / control chars / shell metas.
    .regex(/^[^\\/<>:"|?*]+$/, "Filename contains invalid characters."),
  contentType: z.enum(RETURN_UPLOAD_ALLOWED_MIME),
  contentLengthBytes: z
    .number()
    .int()
    .positive()
    .max(
      RETURN_UPLOAD_MAX_BYTES,
      `File too large — max ${RETURN_UPLOAD_MAX_BYTES / (1024 * 1024)} MB.`,
    ),
});
export type PresignReturnUploadInput = z.infer<typeof presignReturnUploadSchema>;

// ---------------------------------------------------------------------------
// Admin — receive + inspect
// ---------------------------------------------------------------------------

export const receiveReturnLineSchema = z.object({
  returnLineId: z.string().uuid(),
  receivedQty: z.number().int().nonnegative().max(10_000),
});
export type ReceiveReturnLineInput = z.infer<typeof receiveReturnLineSchema>;

export const receiveReturnSchema = z.object({
  lines: z.array(receiveReturnLineSchema).min(1),
});
export type ReceiveReturnInput = z.infer<typeof receiveReturnSchema>;

// Returns v2 — inspection records CONDITION + PHOTOS and shares them
// with the vendor. It no longer sets disposition or any refund; the
// vendor decides disposition next (instructReturnSchema), and money is
// settled at finalize (finalizeReturnSchema).
export const inspectReturnSchema = z.object({
  // Photos USA Errands took of the received items (R2 URLs from the
  // admin presign flow). At least one keeps us honest to the policy
  // ("take and share pictures").
  receivedPhotoUrls: z
    .array(z.string().url().max(2048))
    .min(1, "Attach at least one photo of the received items.")
    .max(20, "Up to 20 photos per return."),
  // Free-text condition summary shared with the vendor.
  conditionNotes: z.string().trim().min(1, "Describe the condition.").max(2000),
});
export type InspectReturnInput = z.infer<typeof inspectReturnSchema>;

// ---------------------------------------------------------------------------
// Admin — finalize (apply the vendor's disposition + charge the fee)
// ---------------------------------------------------------------------------

export const finalizeReturnSchema = z.object({
  // Optional additional shipping/handling cost to charge alongside the
  // flat processing fee. The $2.50 processing fee itself comes from the
  // returns_processing_fee_cents config row, not the client.
  handlingCostCents: z.number().int().nonnegative().max(50_000_000).default(0),
  // Legal/safety override — allows finalizing as DISPOSED WITHOUT vendor
  // instructions when disposal is required by law/carrier/safety. A
  // reason is mandatory when this is set.
  disposalOverrideReason: z.string().trim().min(1).max(500).optional(),
});
export type FinalizeReturnInput = z.infer<typeof finalizeReturnSchema>;
