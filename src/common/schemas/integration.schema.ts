/**
 * Zod schemas for the storefront integration API (Migration 0038).
 *
 * This is the public contract a vendor's website POSTs against. It is
 * intentionally platform-neutral and uses friendly field names (`name`,
 * `line1`) rather than the internal `recipientName` / `shipAddressLine1`
 * column names — the service maps them. Address deliverability is validated
 * downstream by Smarty, so the format checks here mirror the manual order
 * form's rules (a real street has a number + name; US 2-letter state) without
 * duplicating its full strictness.
 *
 * Crucially, a line's `sku` is the vendor's USA Errands **product code**
 * (e.g. "TSH-BLK-M"), NOT an internal SKU id — the vendor sets their store
 * product's SKU field to this code, and the ingestion service resolves it.
 */

import { z } from "zod";

const usState = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, "Use a 2-letter state code, e.g. CA.");

const iso2 = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, "Use a 2-letter ISO country code, e.g. US.");

const optionalString = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .or(z.literal("").transform(() => undefined));

export const integrationRecipientSchema = z.object({
  name: z.string().trim().min(2, "Recipient name is too short.").max(120),
  phone: optionalString(40),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email()
    .max(254)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  line1: z
    .string()
    .trim()
    .min(4, "Street is too short.")
    .max(120)
    .refine((s) => /\s/.test(s), "Street must include a number and a street name."),
  line2: optionalString(120),
  city: z
    .string()
    .trim()
    .min(2, "City is too short.")
    .max(80)
    .regex(/[A-Za-z]/, "City must contain letters."),
  state: usState,
  postalCode: z.string().trim().toUpperCase().min(3).max(12),
  country: iso2.default("US"),
});
export type IntegrationRecipient = z.infer<typeof integrationRecipientSchema>;

export const integrationOrderLineSchema = z.object({
  // The vendor's USA Errands product code — resolved to an active SKU at ingest.
  sku: z.string().trim().min(1).max(80),
  quantity: z.number().int().positive().max(10_000),
});
export type IntegrationOrderLine = z.infer<typeof integrationOrderLineSchema>;

/**
 * Allowed MIME types for a passed-through shipping label document. Same
 * safe set as other uploads (no HTML/SVG). Amazon "Buy Shipping" returns
 * base64 PDF/PNG; Shopify/WooCommerce plugins usually give a URL.
 */
export const INTEGRATION_LABEL_MIME = [
  "application/pdf",
  "image/png",
  "image/jpeg",
] as const;

/** ~15 MB of binary → ~20 MB base64. Labels are far smaller in practice. */
export const INTEGRATION_LABEL_MAX_BASE64_LEN = 20_000_000;

/**
 * Vendor-carrier pass-through (migration 0038 + v2). When the merchant
 * bought the label on their own platform (Shopify Shipping, Amazon Buy
 * Shipping, a WooCommerce plugin), they send it here and USA Errands just
 * fulfills + hands off — no platform label is bought and no shipping is
 * charged. The label may be a hosted URL (Shopify/Woo) OR base64 bytes
 * (Amazon); exactly one must be provided.
 */
export const integrationVendorCarrierSchema = z.object({
  carrier: z.string().trim().min(2, "Carrier name is too short.").max(60),
  tracking: z.string().trim().min(1, "Tracking number is required.").max(128),
  labelUrl: z.string().url().max(2048).optional(),
  labelBase64: z.string().min(1).max(INTEGRATION_LABEL_MAX_BASE64_LEN).optional(),
  labelContentType: z.enum(INTEGRATION_LABEL_MIME).optional(),
});
export type IntegrationVendorCarrier = z.infer<typeof integrationVendorCarrierSchema>;

export const integrationOrderSchema = z
  .object({
    // The store's own order id. REQUIRED here (unlike the manual flow) because
    // it is the idempotency anchor — re-sends of the same order must not create
    // duplicates (DB-enforced by the unique [vendorId, externalReference]).
    externalReference: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z0-9_\-./#]+$/, "Reference can include letters, digits, and -_./#."),
    recipient: integrationRecipientSchema,
    lines: z.array(integrationOrderLineSchema).min(1).max(50),
    // How the parcel ships:
    //   PLATFORM_SHIP  — USA Errands ships it. Only the fulfillment fee is
    //                    charged at ingest; the admin buys the carrier label
    //                    later (and the wallet is charged for shipping then).
    //   VENDOR_CARRIER — the merchant's own pre-bought label is passed through
    //                    (see vendorCarrier); we pick/pack and hand off.
    fulfillmentMode: z.enum(["PLATFORM_SHIP", "VENDOR_CARRIER"]).default("PLATFORM_SHIP"),
    shipping: z
      .object({
        // PLATFORM_SHIP only. Preferred carrier service the admin sees when
        // picking a rate later; omit for the vendor's default / cheapest.
        carrierService: z.string().trim().min(2).max(60).optional(),
        insurance: z.boolean().optional(),
      })
      .optional(),
    vendorCarrier: integrationVendorCarrierSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.fulfillmentMode === "VENDOR_CARRIER") {
      if (!data.vendorCarrier) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "vendorCarrier (carrier, tracking, and a label) is required for VENDOR_CARRIER.",
          path: ["vendorCarrier"],
        });
        return;
      }
      const { labelUrl, labelBase64, labelContentType } = data.vendorCarrier;
      if (!labelUrl && !labelBase64) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Provide the label as either labelUrl or labelBase64.",
          path: ["vendorCarrier", "labelUrl"],
        });
      }
      if (labelUrl && labelBase64) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Provide only one of labelUrl or labelBase64, not both.",
          path: ["vendorCarrier", "labelBase64"],
        });
      }
      if (labelBase64 && !labelContentType) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "labelContentType is required when sending labelBase64.",
          path: ["vendorCarrier", "labelContentType"],
        });
      }
    }
  });
export type IntegrationOrderInput = z.infer<typeof integrationOrderSchema>;

// ---------------------------------------------------------------------------
// Portal-side management (JWT-authed): API keys + integration defaults.
// ---------------------------------------------------------------------------

export const createApiKeySchema = z.object({
  name: z.string().trim().min(1, "Give the key a name.").max(60),
});
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;

export const updateIntegrationSettingsSchema = z
  .object({
    // A concrete carrier service label ("USPS Priority"), the literal
    // "CHEAPEST", or null to clear (treated as cheapest). Empty string clears.
    defaultCarrierService: z
      .string()
      .trim()
      .max(60)
      .nullable()
      .optional()
      .or(z.literal("").transform(() => null)),
    defaultInsurance: z.boolean().optional(),
  })
  .refine((d) => d.defaultCarrierService !== undefined || d.defaultInsurance !== undefined, {
    message: "Provide at least one setting to update.",
  });
export type UpdateIntegrationSettingsInput = z.infer<typeof updateIntegrationSettingsSchema>;
