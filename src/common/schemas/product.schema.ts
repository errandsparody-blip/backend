/**
 * Product Zod schemas. Mirror file in usa-errands-web/src/lib/schemas/products.ts.
 */

import { z } from "zod";

const productCodeSchema = z
  .string()
  .min(2)
  .max(40)
  .regex(/^[A-Z0-9-]+$/, "Use uppercase letters, digits, or hyphens.");

const isoCountrySchema = z.string().length(2).toUpperCase();

const dimensionSchema = z.number().positive().max(120, "Max 120 inches.");
const weightSchema = z.number().positive().max(2400, "Max 2400 oz (~150 lb).");

// Dimensions are optional — explicit null and undefined both clear the
// column. Empty-string is normalised by callers; the JSON wire form
// expects either a number or null. Order-fees handles nulls gracefully.
const optionalDimension = dimensionSchema.nullable().optional();

// Storage tier defaults to SMALL — the SKU bucket the vendor's product
// lives in for monthly storage billing. Different from PSN box mix.
const storageTierSchema = z.enum(["SMALL", "MEDIUM", "LARGE", "X_LARGE", "PALLET"]);

// Strict http(s) URL — capped at 2048 chars (de-facto browser URL
// limit). Shared by both schemas below.
const imageUrlString = z
  .string()
  .trim()
  .url("Must be a fully-qualified URL.")
  .max(2048, "URL is too long.")
  .refine((u) => /^https?:\/\//i.test(u), "Only http/https URLs are accepted.");

// Image is REQUIRED on create. Vendors must upload a product photo
// before they can save — the image is what the admin receiver uses to
// visually match incoming stock against the declaration, and what
// buyers see in customs and order views. The schema rejects null,
// undefined, and empty string outright.
const imageUrlRequired = imageUrlString;

// Image is OPTIONAL on update. Existing products created before the
// requirement landed have no image and must still be patchable
// (vendors can backfill the photo by uploading later). `null` clears
// the field, empty string normalises to `null`, an http(s) URL sets it.
const imageUrlOptional = z
  .union([imageUrlString, z.literal("").transform(() => null), z.null()])
  .optional();

export const createProductSchema = z.object({
  code: productCodeSchema,
  // Migration 0054 — the vendor's own store SKU (Shopify/Amazon/Woo), used
  // to map storefront-integration orders to this product. Optional; empty
  // string normalises to undefined (no mapping).
  storeSku: z
    .string()
    .trim()
    .max(80)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  name: z.string().min(2).max(120),
  variant: z.string().min(1).max(40).default("STD"),
  hsCode: z.string().min(4).max(12).optional(),
  countryOfOrigin: isoCountrySchema,
  declaredValueCents: z.number().int().nonnegative(),
  weightOz: weightSchema,
  lengthIn: optionalDimension,
  widthIn: optionalDimension,
  heightIn: optionalDimension,
  storageTier: storageTierSchema.default("SMALL"),
  imageUrl: imageUrlRequired,
});
export type CreateProductInput = z.infer<typeof createProductSchema>;

// Update reuses the create shape but loosens `imageUrl` back to
// optional/nullable so PATCH bodies can omit it (keep existing) or
// clear it via null. `code` is also dropped — product codes are
// immutable post-create.
export const updateProductSchema = createProductSchema
  .omit({ code: true, imageUrl: true })
  .partial()
  .extend({
    imageUrl: imageUrlOptional,
    status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
  });
export type UpdateProductInput = z.infer<typeof updateProductSchema>;

/**
 * Admin-side override for product details. Used by the warehouse
 * after physically weighing / measuring incoming inventory when the
 * vendor's declared values are wrong.
 *
 * Intentionally NARROWER than `updateProductSchema`:
 *   - `code`, `name`, `variant`, `imageUrl`, `status` are NOT accepted.
 *     Editing them would break the SKU id format, the warehouse pick
 *     list, the photographic audit trail, or the archive lifecycle.
 *   - All remaining fields are optional so a partial edit (e.g.
 *     weightOz only) leaves the rest untouched.
 *   - `reason` is a free-text note (up to 280 chars) recorded on the
 *     audit row — "warehouse re-weighed", "customs correction", etc.
 */
export const adminEditProductSchema = z
  .object({
    hsCode: z.string().min(4).max(12).optional(),
    countryOfOrigin: isoCountrySchema.optional(),
    declaredValueCents: z.number().int().nonnegative().optional(),
    weightOz: weightSchema.optional(),
    lengthIn: optionalDimension,
    widthIn: optionalDimension,
    heightIn: optionalDimension,
    storageTier: storageTierSchema.optional(),
    reason: z.string().trim().min(1).max(280).optional(),
  })
  .strict()
  // At least one substantive field must be present — a reason without
  // any edit is a no-op that just clutters the audit log.
  .refine(
    (v) =>
      v.weightOz !== undefined ||
      v.lengthIn !== undefined ||
      v.widthIn !== undefined ||
      v.heightIn !== undefined ||
      v.declaredValueCents !== undefined ||
      v.hsCode !== undefined ||
      v.countryOfOrigin !== undefined ||
      v.storageTier !== undefined,
    { message: "At least one field must be set." },
  );
export type AdminEditProductInput = z.infer<typeof adminEditProductSchema>;

export const listProductsSchema = z.object({
  status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
  search: z.string().min(1).max(120).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
});
export type ListProductsInput = z.infer<typeof listProductsSchema>;
