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
  "RESTOCKED",
  "DISPOSED",
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

export const inspectReturnLineSchema = z
  .object({
    returnLineId: z.string().uuid(),
    restockedQty: z.number().int().nonnegative().max(10_000).default(0),
    damagedQty: z.number().int().nonnegative().max(10_000).default(0),
    disposedQty: z.number().int().nonnegative().max(10_000).default(0),
    notes: z.string().max(500).optional(),
  });
export type InspectReturnLineInput = z.infer<typeof inspectReturnLineSchema>;

export const inspectReturnSchema = z.object({
  lines: z.array(inspectReturnLineSchema).min(1),
  refundAmountCents: z.number().int().nonnegative().max(50_000_000).default(0),
  restockFeeCents: z.number().int().nonnegative().max(50_000_000).default(0),
  inspectorNotes: z.string().max(2000).optional(),
});
export type InspectReturnInput = z.infer<typeof inspectReturnSchema>;
