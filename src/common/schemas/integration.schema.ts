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

export const integrationOrderSchema = z.object({
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
  shipping: z
    .object({
      // Overrides the vendor's default. Omit to use the configured default
      // (or cheapest available when no default is set).
      carrierService: z.string().trim().min(2).max(60).optional(),
      insurance: z.boolean().optional(),
    })
    .optional(),
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
