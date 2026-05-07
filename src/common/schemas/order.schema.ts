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

const trimmed = (max: number) =>
  z.string().trim().min(1).max(max);

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

// Phone: E.164-ish (digits + optional leading +). Ten to fifteen chars.
const phoneE164 = z
  .string()
  .trim()
  .regex(/^\+?[0-9]{10,15}$/, "Phone must be 10–15 digits, optional leading +.")
  .optional()
  .or(z.literal("").transform(() => undefined));

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

export const recipientAddressSchema = z.object({
  recipientName: trimmed(120),
  recipientPhone: phoneE164,
  recipientEmail: emailNullable,
  shipAddressLine1: trimmed(120),
  shipAddressLine2: z.string().trim().max(120).optional().or(z.literal("").transform(() => undefined)),
  shipCity: trimmed(80),
  shipState: usStateLike,
  shipPostalCode: postalCode,
  shipCountry: iso2.default("US"),
});
export type RecipientAddress = z.infer<typeof recipientAddressSchema>;

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
  // Carrier service the vendor accepted from a prior quote. Free-text; the
  // service maps it to an EasyPost rate.
  carrierService: z.string().trim().min(2).max(60),
  insuranceRequested: z.boolean().default(false),
  // Soft cap so a typo can't bankrupt a vendor in one click.
  maxAcceptableTotalCents: z.number().int().positive().max(50_000_000).optional(),
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
