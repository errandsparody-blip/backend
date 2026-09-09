/**
 * Optional buyer-account schemas (Migration 0060).
 */
import { z } from "zod";

import { storefrontShipAddressSchema } from "./storefront-checkout.schema";

const emailField = z.string().trim().toLowerCase().email("Enter a valid email.").max(254);

// Save the buyer's own just-entered details (no auth — they supply their email).
export const saveBuyerAccountSchema = z.object({
  email: emailField,
  name: z.string().trim().min(1).max(120).optional(),
  phone: z.string().trim().min(7).max(30).optional(),
  shipAddress: storefrontShipAddressSchema.optional(),
});
export type SaveBuyerAccountInput = z.infer<typeof saveBuyerAccountSchema>;

// Request a magic sign-in link. redirectPath is a relative path on our web app
// (e.g. "/store/acme/account") the link returns to — validated relative to stop
// open redirects.
export const requestBuyerLinkSchema = z.object({
  email: emailField,
  redirectPath: z
    .string()
    .trim()
    .max(256)
    .regex(/^\/[A-Za-z0-9\-_/]*$/, "Invalid redirect path.")
    .optional(),
});
export type RequestBuyerLinkInput = z.infer<typeof requestBuyerLinkSchema>;

export const verifyBuyerLinkSchema = z.object({
  token: z.string().trim().min(10).max(200),
});
export type VerifyBuyerLinkInput = z.infer<typeof verifyBuyerLinkSchema>;

export const requestReturnSchema = z.object({
  reason: z.string().trim().min(3, "Tell us why you'd like to return this.").max(1000),
});
export type RequestReturnInput = z.infer<typeof requestReturnSchema>;

export const updateBuyerProfileSchema = z.object({
  name: z.string().trim().min(1).max(120).optional().nullable(),
  phone: z.string().trim().min(7).max(30).optional().nullable(),
  defaultShipAddress: storefrontShipAddressSchema.optional().nullable(),
});
export type UpdateBuyerProfileInput = z.infer<typeof updateBuyerProfileSchema>;
