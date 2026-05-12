/**
 * Personal Shopper Zod schemas.
 *
 * Mirrors `shopper_requests` / `shopper_request_lines` / `shopper_messages`
 * tables from migration 0011. Status / sender / shipping-method enums are
 * declared as TS const arrays here (rather than imported from `@prisma/client`)
 * so this file works against the stale generated Prisma client too — Railway's
 * `prisma generate` step on the next deploy aligns the two.
 *
 * KEEP IN SYNC with `usa-errands-web/src/lib/schemas/shopper.ts`.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Enum values — duplicated from prisma/schema.prisma intentionally.
// ---------------------------------------------------------------------------

export const ShopperRequestStatusValues = [
  "AWAITING_INTAKE_PAYMENT",
  "PAID",
  "PROCURING",
  // Migration 0021 — Phase 2 shopper redesign. Items have been purchased
  // and we're waiting for them to physically land at the warehouse before
  // shipping onward to the buyer.
  "AWAITING_DELIVERY",
  "AWAITING_RECONCILIATION",
  "READY_TO_SHIP",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
  "REFUNDED",
] as const;
export type ShopperRequestStatus = (typeof ShopperRequestStatusValues)[number];

export const ShopperShippingMethodValues = [
  "PLATFORM_FREIGHT",
  "BUYER_FORWARDER",
  "PICKUP",
] as const;
export type ShopperShippingMethod = (typeof ShopperShippingMethodValues)[number];

export const ShopperMessageSenderValues = ["BUYER", "ADMIN"] as const;
export type ShopperMessageSender = (typeof ShopperMessageSenderValues)[number];

export const ShopperLineProcurementStatusValues = [
  "pending",
  "purchased",
  "unavailable",
  "substituted",
] as const;
export type ShopperLineProcurementStatus =
  (typeof ShopperLineProcurementStatusValues)[number];

// ---------------------------------------------------------------------------
// Shared field schemas
// ---------------------------------------------------------------------------

const emailField = z.string().trim().toLowerCase().email("Invalid email.").max(254);

// Product URLs: enforce http/https + reasonable length. Unknown hosts allowed
// because this service explicitly accepts links from any retailer.
const productUrlField = z
  .string()
  .trim()
  .url("Must be a full URL (https://…).")
  .max(2048, "URL is too long.")
  .refine((u) => /^https?:\/\//i.test(u), "Only http/https URLs are accepted.");

const cents = (max: number, label: string) =>
  z
    .number()
    .int(`${label} must be a whole number of cents.`)
    .nonnegative(`${label} cannot be negative.`)
    .max(max, `${label} is too large.`);

// US-style address. Optional at intake; admin captures in chat if missing.
export const shopperShippingAddressSchema = z.object({
  recipientName: z.string().trim().min(1).max(120),
  recipientPhone: z.string().trim().min(7).max(30).optional(),
  line1: z.string().trim().min(1).max(120),
  line2: z.string().trim().max(120).optional(),
  city: z.string().trim().min(1).max(80),
  state: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "2-letter state."),
  postalCode: z.string().trim().min(3).max(12),
  country: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, "2-letter ISO country.")
    .default("US"),
});
export type ShopperShippingAddressInput = z.infer<typeof shopperShippingAddressSchema>;

// ---------------------------------------------------------------------------
// Public intake — buyer creates a request from /shopper
// ---------------------------------------------------------------------------

const lineInputSchema = z.object({
  productUrl: productUrlField,
  productNotes: z.string().trim().max(1000).optional(),
  quantity: z
    .number()
    .int("Quantity must be a whole number.")
    .min(1, "At least 1.")
    .max(100, "Up to 100 per line."),
  // Buyer's estimated unit price IN DOLLARS — converted to cents on the wire.
  // Capped at $25,000 per unit; way above any realistic single retail item.
  estimatedUnitPriceCents: cents(2_500_000, "Unit price"),
});

// Pattern for the human-readable reference. Stays loose enough to allow
// future formats (year-prefixed, alphanumeric) without breaking old links.
export const SHOPPER_REFERENCE_PATTERN = /^SHP-[A-Z0-9-]{3,32}$/;

export const createShopperRequestSchema = z.object({
  buyerEmail: emailField,
  buyerName: z.string().trim().min(1).max(120).optional(),
  shippingAddress: shopperShippingAddressSchema.optional(),
  lines: z
    .array(lineInputSchema)
    .min(1, "Add at least one item.")
    .max(50, "Up to 50 items per request."),
  // Free-text overall note from the buyer. Lands as the first chat message
  // when present so the admin sees it without having to scroll the form data.
  initialMessage: z.string().trim().max(5000).optional(),
  // Optional link to a previous order by the same buyer ("I forgot
  // something, here's an addition to SHP-000041"). Server validates that
  // the parent exists AND belongs to the same buyer email — otherwise
  // anyone could harvest references and link to a stranger's order.
  parentReference: z
    .string()
    .trim()
    .toUpperCase()
    .regex(SHOPPER_REFERENCE_PATTERN, "Reference looks like SHP-000042.")
    .optional()
    .or(z.literal("").transform(() => undefined)),
});
export type CreateShopperRequestInput = z.infer<typeof createShopperRequestSchema>;

// ---------------------------------------------------------------------------
// Attachment upload — presign request
// ---------------------------------------------------------------------------
//
// MIME allow-list: deliberately excludes types the browser would render
// inline as scripts (text/html, image/svg+xml). An attacker who can host
// HTML on the same origin as the buyer's thread URL has a free XSS.

export const ShopperUploadAllowedMimeTypes = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "application/pdf",
] as const;
export type ShopperUploadAllowedMimeType =
  (typeof ShopperUploadAllowedMimeTypes)[number];

// 25 MB caps a high-DPI screenshot or a multi-page PDF; more than that is
// almost always a mistake.
export const SHOPPER_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

export const presignShopperUploadSchema = z.object({
  filename: z
    .string()
    .trim()
    .min(1, "Filename required.")
    .max(200, "Filename too long.")
    // Disallow path separators / control chars / shell metas. The R2
    // service generates a fresh random key anyway; this is belt-and-braces
    // so a hostile client can't smuggle anything via the extension parse.
    .regex(/^[^\\/<>:"|?*]+$/, "Filename contains invalid characters."),
  contentType: z.enum(ShopperUploadAllowedMimeTypes),
  contentLengthBytes: z
    .number()
    .int()
    .positive()
    .max(
      SHOPPER_UPLOAD_MAX_BYTES,
      `File too large — max ${SHOPPER_UPLOAD_MAX_BYTES / (1024 * 1024)} MB.`,
    ),
});
export type PresignShopperUploadInput = z.infer<typeof presignShopperUploadSchema>;

// ---------------------------------------------------------------------------
// Buyer message post — from the public thread page
// ---------------------------------------------------------------------------

export const postShopperMessageSchema = z.object({
  body: z.string().trim().min(1, "Message can't be empty.").max(10000),
  attachmentUrls: z
    .array(z.string().url().max(2048))
    .max(10, "Up to 10 attachments per message.")
    .optional()
    .default([]),
});
export type PostShopperMessageInput = z.infer<typeof postShopperMessageSchema>;

// ---------------------------------------------------------------------------
// Admin: list / queue
// ---------------------------------------------------------------------------

export const adminListShopperRequestsSchema = z.object({
  status: z.enum(ShopperRequestStatusValues).optional(),
  view: z.enum(["queue", "all"]).optional(),
  search: z.string().trim().min(1).max(120).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
});
export type AdminListShopperRequestsInput = z.infer<
  typeof adminListShopperRequestsSchema
>;

// ---------------------------------------------------------------------------
// Admin: per-line reconciliation update
// ---------------------------------------------------------------------------

export const adminUpdateShopperLineSchema = z.object({
  actualUnitPriceCents: cents(2_500_000, "Unit price").nullable().optional(),
  procurementStatus: z.enum(ShopperLineProcurementStatusValues).optional(),
  procurementNotes: z.string().trim().max(2000).optional(),
  productTitle: z.string().trim().max(200).optional(),
  // Migration 0016 — actual per-line weight (oz). Capped at 5,000 lb
  // (80,000 oz) — way above any realistic single-line weight, but
  // protects against typos like "8000" being read as 8000 lb when the
  // user meant 80.
  actualWeightOz: z
    .number()
    .nonnegative("Weight cannot be negative.")
    .max(80_000, "Weight too large.")
    .nullable()
    .optional(),
});
export type AdminUpdateShopperLineInput = z.infer<typeof adminUpdateShopperLineSchema>;

// ---------------------------------------------------------------------------
// Admin: set shipping cost + method
// ---------------------------------------------------------------------------

// Parcel dimension cap (inches). 120" is the largest single dimension a
// standard international carrier accepts; we cap at 200 to be lenient
// while still rejecting obvious typos.
const dim = () =>
  z.number().nonnegative("Cannot be negative.").max(200, "Too large.");

export const adminSetShopperShippingSchema = z.object({
  // Migration 0017 — `shippingCostCents` is now derived by default from
  // (parcel weight × method's per-lb rate) but admin can override (real-
  // world surcharges, partner pricing, etc.). The `useCalculated` flag
  // controls which path the service takes:
  //   - true  → ignore shippingCostCents, compute from rate × weight.
  //             Required: shippingMethod set, parcelWeightOz > 0,
  //             freight rate row populated for that method.
  //   - false → trust shippingCostCents as the operator's override; the
  //             service still snapshots the system-calculated number into
  //             `shippingCalculatedCents` so the receipt can show both.
  shippingCostCents: cents(500_000, "Shipping cost").optional(),
  useCalculated: z.boolean().optional().default(false),
  shippingMethod: z.enum(ShopperShippingMethodValues).optional(),
  // Actual U.S. sales tax the platform paid at procurement (cents). Optional
  // — admin can set it before, after, or alongside shipping. Reconciled
  // against estimatedTaxCents to compute the buyer follow-up.
  actualTaxCents: cents(2_500_000, "Sales tax").nullable().optional(),
  // Migration 0016 — packed parcel dimensions and total weight. All
  // optional so admin can save shipping cost without them, then come
  // back once the box is sealed and weighed.
  parcelLengthIn: dim().nullable().optional(),
  parcelWidthIn: dim().nullable().optional(),
  parcelHeightIn: dim().nullable().optional(),
  parcelWeightOz: z
    .number()
    .nonnegative("Cannot be negative.")
    .max(80_000, "Weight too large.")
    .nullable()
    .optional(),
  // Migration 0021 — admin can update the destination address from the
  // shipping panel. We accept the same shape used at intake, plus a `null`
  // shortcut to clear (rarely needed; mostly here for symmetry).
  shippingAddress: shopperShippingAddressSchema.nullable().optional(),
}).refine(
  (v) => v.useCalculated === true || typeof v.shippingCostCents === "number",
  {
    message: "Either useCalculated must be true or shippingCostCents must be provided.",
    path: ["shippingCostCents"],
  },
);
export type AdminSetShopperShippingInput = z.infer<typeof adminSetShopperShippingSchema>;

// ---------------------------------------------------------------------------
// Admin: send the follow-up invoice (resolves reconciliation either way)
// ---------------------------------------------------------------------------

export const adminSendFollowupSchema = z.object({
  // Optional override note for the buyer (added as a chat message).
  message: z.string().trim().max(2000).optional(),
});
export type AdminSendFollowupInput = z.infer<typeof adminSendFollowupSchema>;

// ---------------------------------------------------------------------------
// Admin: mark shipped
// ---------------------------------------------------------------------------

export const adminShipShopperSchema = z.object({
  carrier: z.string().trim().min(1).max(40),
  trackingNumber: z.string().trim().min(1).max(80),
});
export type AdminShipShopperInput = z.infer<typeof adminShipShopperSchema>;

// ---------------------------------------------------------------------------
// Admin: cancel
// ---------------------------------------------------------------------------

export const adminCancelShopperSchema = z.object({
  reason: z.string().trim().min(1).max(500),
  // If true, also issue a refund of the intake payment (and any follow-up
  // already paid). Defaults to true for safety.
  issueRefund: z.boolean().default(true),
});
export type AdminCancelShopperInput = z.infer<typeof adminCancelShopperSchema>;
