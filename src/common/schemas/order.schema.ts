/**
 * Zod schemas for the Orders / Returns API.
 *
 * Implementation Plan §6.6, §6.7.
 *
 * The schemas are intentionally strict — no unknown keys (`whitelist: true`
 * in the global ValidationPipe strips them anyway, but Zod also catches them).
 * Postal codes are normalized to uppercase + trimmed; emails to lowercase.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// US state — 2 letters, uppercased. Domestic-only check is enforced inside the
// service when shipCountry === "US".
const usStateLike = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, "Use a 2-letter state code, e.g. CA.");

// Postal code: trimmed; uppercase; minimal shape. Smarty handles full validation.
const postalCode = z.string().trim().toUpperCase().min(3).max(12);

const iso2 = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, "Use a 2-letter ISO country code, e.g. US.");

const emailNullable = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(254)
  .optional()
  .or(z.literal("").transform(() => undefined));

// ---------------------------------------------------------------------------
// Address (recipient) — used by quote + create
// ---------------------------------------------------------------------------

// Stricter line1 — at least 4 characters AND contain a space, so single-token
// garbage like "ADE" / "airport" can't slip through the format layer. A real
// street address always has a number + name, separated by a space.
const streetLine = z
  .string()
  .trim()
  .min(4, "Street is too short.")
  .max(120)
  .refine((s) => /\s/.test(s), "Street must include a number and a street name.");

// Stricter phone — require exactly 10 US digits (optionally with +1 prefix or
// formatting noise like dashes/parens/spaces). Rejects sequential-digit
// placeholders like "1234567890" via a separate refine because some users
// genuinely have nice round phone numbers; we filter the obvious garbage.
const phoneUS10 = z
  .string()
  .trim()
  .transform((s) => s.replace(/[^\d+]/g, "")) // strip formatting
  .pipe(
    z.string().regex(/^(\+?1)?\d{10}$/, "US phone must be 10 digits."),
  )
  .refine((s) => {
    const digits = s.replace(/[^\d]/g, "").slice(-10);
    // Reject 5 or more consecutive identical digits, and the classic
    // ascending/descending sequences. Anything past that is a vendor
    // typing real garbage.
    if (/(\d)\1{4,}/.test(digits)) return false;
    if (/01234567|12345678|23456789|98765432|87654321/.test(digits)) return false;
    return true;
  }, "Phone number looks like a placeholder.")
  .optional()
  .or(z.literal("").transform(() => undefined));

export const recipientAddressSchema = z.object({
  recipientName: z
    .string()
    .trim()
    .min(2, "Recipient name is too short.")
    .max(120)
    .refine((s) => /\s|[A-Za-z]{3,}/.test(s), "Use a real name (first + last)."),
  recipientPhone: phoneUS10,
  recipientEmail: emailNullable,
  shipAddressLine1: streetLine,
  shipAddressLine2: z.string().trim().max(120).optional().or(z.literal("").transform(() => undefined)),
  shipCity: z
    .string()
    .trim()
    .min(2, "City is too short.")
    .max(80)
    // Reject single-token nonsense like "airport" by requiring at least one
    // letter; the runtime carrier check would catch this too but a clean
    // client-side rejection beats a $0.50 wasted API call.
    .regex(/[A-Za-z]/, "City must contain letters."),
  shipState: usStateLike,
  shipPostalCode: postalCode,
  shipCountry: iso2.default("US"),
});
export type RecipientAddress = z.infer<typeof recipientAddressSchema>;

// ---------------------------------------------------------------------------
// Address-only validation — used by the order-new form to pre-check before
// the vendor finishes the order. No DB write, no idempotency. Same shape
// as the recipient address minus the name/phone/email (those don't change
// USPS deliverability).
// ---------------------------------------------------------------------------

export const validateAddressSchema = z.object({
  shipAddressLine1: streetLine,
  shipAddressLine2: z.string().trim().max(120).optional().or(z.literal("").transform(() => undefined)),
  shipCity: z.string().trim().min(2).max(80),
  shipState: usStateLike,
  shipPostalCode: postalCode,
  shipCountry: iso2.default("US"),
});
export type ValidateAddressInput = z.infer<typeof validateAddressSchema>;

// ---------------------------------------------------------------------------
// Order line input
// ---------------------------------------------------------------------------

export const orderLineInputSchema = z.object({
  skuId: z.string().min(4).max(80),       // UER-...-...
  quantity: z.number().int().positive().max(10_000),
});
export type OrderLineInput = z.infer<typeof orderLineInputSchema>;

// ---------------------------------------------------------------------------
// Quote — no DB write (or temporary). Returns rates + fee preview.
// ---------------------------------------------------------------------------

export const quoteOrderSchema = z.object({
  recipient: recipientAddressSchema,
  lines: z.array(orderLineInputSchema).min(1).max(50),
  // Optional: prefer one carrier service (e.g. "USPS Priority"). When omitted,
  // we return all available rates.
  preferredService: z.string().trim().max(60).optional(),
  insuranceRequested: z.boolean().default(false),
});
export type QuoteOrderInput = z.infer<typeof quoteOrderSchema>;

// ---------------------------------------------------------------------------
// Create — full order submit. Idempotency-Key required at the HTTP layer.
// ---------------------------------------------------------------------------

// Migration 0037 — vendor-carrier fulfillment-only details. Only relevant
// when fulfillmentMode = VENDOR_CARRIER. At submit time the service
// enforces that AT LEAST ONE of (vendorLabelUrl) OR (vendorCarrierName +
// vendorTrackingNumber) is present — the Zod schema accepts both forms
// without making either strictly required because we want the validation
// error to come back as a friendly "tell us how to ship this" message
// from the service, not as a generic Zod path complaint.
export const vendorCarrierDetailsSchema = z.object({
  vendorCarrierName: z
    .string()
    .trim()
    .min(2)
    .max(60)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  vendorTrackingNumber: z
    .string()
    .trim()
    .min(4)
    .max(80)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  vendorLabelUrl: z
    .string()
    .url()
    .max(2048)
    .optional()
    .or(z.literal("").transform(() => undefined)),
});
export type VendorCarrierDetails = z.infer<typeof vendorCarrierDetailsSchema>;

export const createOrderSchema = z.object({
  externalReference: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[A-Za-z0-9_\-./#]+$/, "Reference can include letters, digits, and -_./#.")
    .optional(),
  recipient: recipientAddressSchema,
  lines: z.array(orderLineInputSchema).min(1).max(50),
  // Migration 0037 — branches the order pipeline. Defaults to
  // PLATFORM_SHIP so existing API clients (older portal builds,
  // automation scripts) keep working unchanged. VENDOR_CARRIER opts the
  // request into the new fulfillment-only flow.
  fulfillmentMode: z.enum(["PLATFORM_SHIP", "VENDOR_CARRIER"]).default("PLATFORM_SHIP"),
  // Carrier service the vendor accepted from a prior quote. Free-text;
  // the service maps it to a Shippo rate. Required for PLATFORM_SHIP,
  // ignored for VENDOR_CARRIER (the vendor's own carrier replaces the
  // Shippo rate selection).
  carrierService: z
    .string()
    .trim()
    .min(2)
    .max(60)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  insuranceRequested: z.boolean().default(false),
  // Soft cap so a typo can't bankrupt a vendor in one click.
  maxAcceptableTotalCents: z.number().int().positive().max(50_000_000).optional(),
  // Vendor-carrier details — service requires at least one of label URL
  // or (carrier + tracking) when fulfillmentMode is VENDOR_CARRIER.
  vendorCarrier: vendorCarrierDetailsSchema.optional(),
}).superRefine((data, ctx) => {
  // Per-mode required-field check that Zod can express cleanly.
  if (data.fulfillmentMode === "PLATFORM_SHIP") {
    if (!data.carrierService) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "carrierService is required for platform-shipped orders.",
        path: ["carrierService"],
      });
    }
  } else if (data.fulfillmentMode === "VENDOR_CARRIER") {
    const vc = data.vendorCarrier ?? {};
    const hasLabel = !!vc.vendorLabelUrl;
    const hasManual = !!vc.vendorCarrierName && !!vc.vendorTrackingNumber;
    if (!hasLabel && !hasManual) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Upload a shipping label, or enter both a carrier name and tracking number.",
        path: ["vendorCarrier"],
      });
    }
  }
});
export type CreateOrderInput = z.infer<typeof createOrderSchema>;

// ---------------------------------------------------------------------------
// List / get
// ---------------------------------------------------------------------------

export const listOrdersSchema = z.object({
  status: z
    .enum([
      "DRAFT",
      "SUBMITTED",
      "ALLOCATED",
      "LABEL_PURCHASED",
      "PICKING",
      "PACKED",
      "SHIPPED",
      "IN_TRANSIT",
      "DELIVERED",
      "EXCEPTION",
      "CANCELLED",
      "RETURNED",
    ])
    .optional(),
  search: z.string().trim().max(120).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
});
export type ListOrdersInput = z.infer<typeof listOrdersSchema>;

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

export const cancelOrderSchema = z.object({
  reason: z.enum(["VENDOR_REQUEST", "OUT_OF_STOCK", "ADDRESS_INVALID", "CARRIER_REFUSED", "FRAUD_HOLD", "OTHER"]),
  note: z.string().trim().max(500).optional(),
});
export type CancelOrderInput = z.infer<typeof cancelOrderSchema>;

// ---------------------------------------------------------------------------
// Migration 0037 — vendor-supplied label uploads (VENDOR_CARRIER mode).
//
// Used by the order/new wizard's Fulfillment step so the vendor can
// upload a PDF or image of their pre-paid label straight to R2 instead
// of hosting it elsewhere first and pasting a URL. Mime allow-list
// mirrors the returns / shopper upload endpoints — image formats +
// PDF only, never HTML/SVG (those carry XSS risk on the same origin
// as the buyer-facing pages).
// ---------------------------------------------------------------------------

export const ORDER_LABEL_UPLOAD_ALLOWED_MIME = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "application/pdf",
] as const;

// 25 MB matches the returns + chat upload caps — the largest legitimate
// shipping label PDF we've seen is ~3 MB, so this is comfortably padded.
export const ORDER_LABEL_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

export const presignOrderLabelUploadSchema = z.object({
  filename: z
    .string()
    .trim()
    .min(1, "Filename required.")
    .max(200, "Filename too long.")
    // Disallow path separators / control chars / shell metas so a
    // malicious filename can't traverse outside the per-vendor R2
    // prefix. Same allow-list returns + shopper presign uses.
    .regex(/^[^\\/<>:"|?*]+$/, "Filename contains invalid characters."),
  contentType: z.enum(ORDER_LABEL_UPLOAD_ALLOWED_MIME),
  contentLengthBytes: z
    .number()
    .int()
    .positive()
    .max(
      ORDER_LABEL_UPLOAD_MAX_BYTES,
      `File too large — max ${ORDER_LABEL_UPLOAD_MAX_BYTES / (1024 * 1024)} MB.`,
    ),
});
export type PresignOrderLabelUploadInput = z.infer<
  typeof presignOrderLabelUploadSchema
>;
