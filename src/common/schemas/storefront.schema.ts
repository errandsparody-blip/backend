/**
 * Storefront / marketplace request schemas (Migration 0059).
 *
 * Vendor-facing: manage which products are listed, storefront presentation,
 * the store slug, enabling the storefront, and the marketplace feature toggle.
 * Public buyer + payment schemas live in their own files (later layers).
 */
import { z } from "zod";

// A hex colour like #0F172A (3 or 6 hex digits). Optional accent for theming.
const hexColor = z
  .string()
  .trim()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "Use a hex colour like #0F172A.");

// URL-safe store handle: lowercase letters/digits/hyphens, 3–40 chars, no
// leading/trailing hyphen. Reserved words are rejected in the service (they
// need the full list + DB uniqueness, which a regex can't express).
export const storefrontSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "At least 3 characters.")
  .max(40, "At most 40 characters.")
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/,
    "Lowercase letters, numbers and hyphens only (no leading/trailing hyphen).",
  );

export const setSlugSchema = z.object({ slug: storefrontSlugSchema });
export type SetSlugInput = z.infer<typeof setSlugSchema>;

// Toggle a product's storefront listing + set its public retail price and
// categorisation. Retail price is REQUIRED (> 0) whenever listed is true —
// enforced by the refine so we never publish a $0 product.
export const setProductListingSchema = z
  .object({
    listed: z.boolean(),
    retailPriceCents: z
      .number()
      .int("Whole cents only.")
      .positive("Retail price must be greater than $0.")
      .max(100_000_000, "Retail price is too large.")
      .optional(),
    category: z.string().trim().min(1).max(60).optional().nullable(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  })
  .refine((v) => !v.listed || (v.retailPriceCents ?? 0) > 0, {
    message: "Set a retail price greater than $0 before listing this product.",
    path: ["retailPriceCents"],
  });
export type SetProductListingInput = z.infer<typeof setProductListingSchema>;

// Storefront presentation (upsert). displayName is the only required field —
// everything else is optional polish.
export const upsertStorefrontSettingsSchema = z.object({
  displayName: z.string().trim().min(1, "Required.").max(80, "Up to 80 characters."),
  logoUrl: z.string().url().max(2048).optional().nullable(),
  bannerUrl: z.string().url().max(2048).optional().nullable(),
  accentColor: hexColor.optional().nullable(),
  about: z.string().trim().max(2000).optional().nullable(),
});
export type UpsertStorefrontSettingsInput = z.infer<typeof upsertStorefrontSettingsSchema>;

export const setFeaturedSchema = z.object({ featured: z.boolean() });
export type SetFeaturedInput = z.infer<typeof setFeaturedSchema>;

// Custom domain registration (Phase 3).
export const addDomainSchema = z.object({
  host: z.string().trim().min(3).max(255),
});
export type AddDomainInput = z.infer<typeof addDomainSchema>;
