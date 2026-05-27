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

// Optional product image URL. Must be a fully-qualified http(s) URL — we
// don't accept raw paths so a typo can't poison the buyer-visible view.
// Capped at 2048 chars (de-facto browser URL limit). An empty string from
// the form normalises to `null`, which clears the image. `null` and
// `undefined` both round-trip as "no image set".
const imageUrlField = z
  .string()
  .trim()
  .url("Must be a fully-qualified URL.")
  .max(2048, "URL is too long.")
  .refine((u) => /^https?:\/\//i.test(u), "Only http/https URLs are accepted.")
  .nullable()
  .optional()
  .or(z.literal("").transform(() => null));

export const createProductSchema = z.object({
  code: productCodeSchema,
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
  imageUrl: imageUrlField,
});
export type CreateProductInput = z.infer<typeof createProductSchema>;

export const updateProductSchema = createProductSchema
  .omit({ code: true })
  .partial()
  .extend({
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
