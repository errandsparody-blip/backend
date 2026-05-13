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
  // Migration 0023a — wire-transfer / ID-verification track. Statuses are
  // listed in lifecycle order so a glance at the enum tells the story.
  "AWAITING_ID_VERIFICATION",
  "ID_UNDER_REVIEW",
  "QUOTE_SENT",
  "AWAITING_WIRE_PAYMENT",
  "WIRE_PROOF_UPLOADED",
  "WIRE_UNDER_REVIEW",
  "WIRE_CONFIRMED",
  "PURCHASE_APPROVED",
] as const;
export type ShopperRequestStatus = (typeof ShopperRequestStatusValues)[number];

// Migration 0023 — payment rail. Server-derived; never accept from client.
export const ShopperPaymentMethodValues = ["STRIPE", "WIRE"] as const;
export type ShopperPaymentMethod = (typeof ShopperPaymentMethodValues)[number];

// Migration 0023 — ID-verification lifecycle. Only meaningful on WIRE
// requests; STRIPE requests stay at NONE forever.
export const ShopperIdVerificationStatusValues = [
  "NONE",
  "PENDING_UPLOAD",
  "UNDER_REVIEW",
  "APPROVED",
  "REJECTED",
] as const;
export type ShopperIdVerificationStatus =
  (typeof ShopperIdVerificationStatusValues)[number];

export const ShopperShippingMethodValues = [
  "PLATFORM_FREIGHT",
  // Migration 0025a — buyer's own carrier label.
  "BUYER_FREIGHT",
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

// Email field for buyer intake. Zod's `.email()` is permissive (it accepts
// things like `a@b` and `foo@-bar.com`); we tighten with a regex that
// requires at least one dot in the domain and rejects consecutive dots.
// This is NOT a complete RFC 5322 implementation — it's a "this almost
// certainly was a typo" filter that catches the common mistakes before
// the buyer pays and finds out the receipt email bounced.
const STRICT_EMAIL_RE =
  /^[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .email("Invalid email.")
  .max(254)
  .refine((v) => !v.includes(".."), "Email cannot contain consecutive dots.")
  .refine((v) => STRICT_EMAIL_RE.test(v), "Looks like a typo — double-check the email.");

// Migration 0023 — buyer phone, required at intake. Loose digit/`+` check;
// we don't enforce E.164 because international numbers vary too much and a
// hard parse would lock out legitimate buyers. Operators eyeball the
// number anyway during the ID-review step for high-value (wire) requests.
const phoneField = z
  .string()
  .trim()
  // Strip common formatting so the stored value is canonical-ish without
  // forcing a strict format on the buyer's keyboard.
  .transform((v) => v.replace(/[\s().-]/g, ""))
  .pipe(
    z
      .string()
      .min(7, "Phone too short.")
      .max(20, "Phone too long.")
      .regex(/^\+?[0-9]+$/, "Digits only (optional leading +)."),
  );

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
  // Migration 0023 — name + phone are required for new intake. They were
  // optional in v1; the wire-transfer / ID-verification track tightened
  // the contract because we need a real identity attached to every
  // request that might end up on the WIRE rail.
  buyerName: z.string().trim().min(1, "Required.").max(120, "Up to 120 characters."),
  buyerPhone: phoneField,
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
  // Phase 2 redesign — admin types the per-lb rate directly on the
  // shopper detail page for this request rather than picking from a
  // pre-configured rate map. We persist it as the freightRateCentsPerLb
  // snapshot so the receipt and recalc all use the same number. Capped
  // at $1,000/lb (100,000 cents) to catch typos that turn $4.50 into $450.
  shippingRateCentsPerLb: z
    .number()
    .int("Rate must be whole cents.")
    .nonnegative("Rate cannot be negative.")
    .max(100_000, "Rate is too large (max $1,000/lb).")
    .optional(),
  // Migration 0025 — buyer-supplied shipping label (R2 URL) when the
  // shipping method is BUYER_FREIGHT. We don't price freight in that
  // mode; the buyer's label is the label we slap on the box.
  buyerLabelUrl: z
    .string()
    .url("Must be a URL.")
    .max(2048, "URL too long.")
    .nullable()
    .optional(),
  // Migration 0025 — pickup window when shippingMethod = PICKUP. We
  // capture the person who will pick up (name only; no ID per product
  // decision) plus the scheduled date/time so the warehouse can have
  // it ready.
  pickupName: z
    .string()
    .trim()
    .min(2, "Pickup person's name required.")
    .max(120, "Name too long.")
    .nullable()
    .optional(),
  pickupScheduledAt: z.coerce.date().nullable().optional(),
})
  .refine(
    (v) => {
      // For PLATFORM_FREIGHT and BUYER_FORWARDER the existing constraint
      // applies: we either compute from weight × rate or trust the
      // override. For BUYER_FREIGHT and PICKUP we don't charge freight,
      // so `shippingCostCents` is optional and the constraint relaxes.
      const m = v.shippingMethod;
      if (m === "BUYER_FREIGHT" || m === "PICKUP") return true;
      return v.useCalculated === true || typeof v.shippingCostCents === "number";
    },
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
// Migration 0025 — release with buyer-supplied label (BUYER_FREIGHT mode)
// ---------------------------------------------------------------------------
// Admin clicks "Release with buyer label" once the package is ready and
// the buyer's label is on it. Tracking + carrier come from the buyer's
// label scan rather than our integrated carrier API, hence the same
// shape as adminShipShopperSchema — the difference is in the service,
// which doesn't call Shippo for this method.

export const adminReleaseWithBuyerLabelSchema = z.object({
  carrier: z.string().trim().min(1).max(40),
  trackingNumber: z.string().trim().min(1).max(80),
});
export type AdminReleaseWithBuyerLabelInput = z.infer<typeof adminReleaseWithBuyerLabelSchema>;

// ---------------------------------------------------------------------------
// Migration 0025 — mark picked up (PICKUP mode)
// ---------------------------------------------------------------------------
// Admin clicks "Mark picked up" after the buyer has physically collected
// the package from the warehouse. Records the timestamp and transitions
// the request to DELIVERED.

export const adminMarkPickedUpSchema = z.object({
  // Optional note attached to the chat thread when the handoff completes.
  // Mostly here for "delivered to authorized rep" or similar deviation.
  note: z.string().trim().max(500).optional(),
});
export type AdminMarkPickedUpInput = z.infer<typeof adminMarkPickedUpSchema>;

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

// ---------------------------------------------------------------------------
// Migration 0023 — buyer ID + wire upload schemas (buyer-side)
// ---------------------------------------------------------------------------
//
// Buyer uploads happen in two stages: first call the presign endpoint
// (same schema as the existing chat presign), then POST the resulting
// public URL back so the server can persist it on the request row.

// Tight URL allow-list: must be https and live under our own R2 host (or
// the configured public-uploads origin). Application-level check; the
// service layer verifies the URL belongs to this request before saving.
const uploadedUrlField = z
  .string()
  .trim()
  .url("Must be a full URL.")
  .max(2048, "URL is too long.")
  .refine((u) => /^https:\/\//i.test(u), "Only https URLs are accepted.");

export const submitShopperIdUploadsSchema = z.object({
  // Front of the government-issued ID (passport, driver's licence, …).
  idDocumentUrl: uploadedUrlField,
  // A selfie holding the ID — guard against stolen-document attempts.
  idSelfieUrl: uploadedUrlField,
});
export type SubmitShopperIdUploadsInput = z.infer<typeof submitShopperIdUploadsSchema>;

export const submitShopperWireProofSchema = z.object({
  // Bank receipt / transfer screenshot. PDF, image — same allow-list as
  // chat attachments. The server doesn't OCR; the admin eyeballs it.
  wireProofUrl: uploadedUrlField,
});
export type SubmitShopperWireProofInput = z.infer<typeof submitShopperWireProofSchema>;

// ---------------------------------------------------------------------------
// Migration 0023 — admin wire / ID review schemas
// ---------------------------------------------------------------------------

// Migration 0026 — per-request bank instructions. Admin can attach a
// specific account to wire to at approval time (mirrors the shape of
// the global `shopper_bank_instructions` config row so the buyer-side
// renderer can stay one component). Only `accountNumber` is required;
// every other field is optional so a domestic-only USD account, an
// IBAN-only foreign account, or anything in between is representable.
//
// All fields are trimmed and length-capped to fit comfortably in an
// email and on a chat receipt without spilling into multi-line wraps.
export const shopperWireBankInstructionsSchema = z.object({
  beneficiaryName: z.string().trim().max(120, "Beneficiary name too long.").optional(),
  bankName: z.string().trim().max(120, "Bank name too long.").optional(),
  accountNumber: z
    .string()
    .trim()
    .min(4, "Account number is required.")
    .max(80, "Account number too long."),
  routingNumber: z.string().trim().max(40, "Routing number too long.").optional(),
  swift: z.string().trim().max(40, "SWIFT/BIC too long.").optional(),
  iban: z.string().trim().max(60, "IBAN too long.").optional(),
  memo: z.string().trim().max(120, "Memo too long.").optional(),
});
export type ShopperWireBankInstructions = z.infer<typeof shopperWireBankInstructionsSchema>;

export const adminApproveShopperIdSchema = z.object({
  // Optional admin note appended to the chat thread when approving.
  note: z.string().trim().max(2000).optional(),
  // Migration 0026 — admin sends the buyer-facing account number(s)
  // alongside the approval. Optional: when omitted, the buyer sees
  // whatever's in the global `shopper_bank_instructions` config row.
  bankInstructions: shopperWireBankInstructionsSchema.optional(),
});
export type AdminApproveShopperIdInput = z.infer<typeof adminApproveShopperIdSchema>;

export const adminRejectShopperIdSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, "Reason is required.")
    .max(2000, "Reason is too long."),
});
export type AdminRejectShopperIdInput = z.infer<typeof adminRejectShopperIdSchema>;

export const adminSendShopperQuoteSchema = z.object({
  // Optional admin message added to the buyer-facing chat when the quote
  // is published. The buyer always sees the canonical bank-instructions
  // panel rendered from configuration; this is supplementary copy.
  message: z.string().trim().max(5000).optional(),
});
export type AdminSendShopperQuoteInput = z.infer<typeof adminSendShopperQuoteSchema>;

export const adminConfirmShopperWireSchema = z.object({
  // Optional admin note appended to the chat thread when confirming.
  note: z.string().trim().max(2000).optional(),
});
export type AdminConfirmShopperWireInput = z.infer<typeof adminConfirmShopperWireSchema>;

export const adminRejectShopperWireSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, "Reason is required.")
    .max(2000, "Reason is too long."),
});
export type AdminRejectShopperWireInput = z.infer<typeof adminRejectShopperWireSchema>;
