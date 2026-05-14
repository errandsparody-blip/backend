/**
 * Public marketing endpoint Zod schemas.
 *
 * These are anonymous, unauthenticated routes (no JWT) used by the
 * marketing site — the validation surface needs to be tight because
 * the input is fully attacker-controlled.
 */

import { z } from "zod";

export const requestPricingGuideSchema = z.object({
  businessName: z
    .string()
    .trim()
    .min(2, "Business name is required.")
    .max(120, "Business name too long."),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Enter a valid email address.")
    .max(200, "Email too long."),
  // ISO 3166-1 alpha-2 country code, uppercase. The frontend picker emits
  // this value; the regex defends against direct API calls with anything
  // other than a two-letter code.
  country: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, "Country must be a 2-letter ISO code."),
});

export type RequestPricingGuideInput = z.infer<typeof requestPricingGuideSchema>;
