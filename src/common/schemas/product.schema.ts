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
});
export type CreateProductInput = z.infer<typeof createProductSchema>;

export const updateProductSchema = createProductSchema
  .omit({ code: true })
  .partial()
  .extend({
    status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
  });
export type UpdateProductInput = z.infer<typeof updateProductSchema>;

export const listProductsSchema = z.object({
  status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
  search: z.string().min(1).max(120).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
});
export type ListProductsInput = z.infer<typeof listProductsSchema>;
