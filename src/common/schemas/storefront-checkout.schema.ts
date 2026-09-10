/**
 * Public storefront checkout schemas (Migration 0059).
 */
import { z } from "zod";

export const storefrontShipAddressSchema = z.object({
  recipientName: z.string().trim().min(1, "Required.").max(120),
  line1: z.string().trim().min(1, "Required.").max(120),
  line2: z.string().trim().max(120).optional(),
  city: z.string().trim().min(1, "Required.").max(80),
  state: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "2-letter state."),
  postalCode: z.string().trim().min(3).max(12),
  country: z.string().trim().toUpperCase().length(2).default("US"),
  phone: z.string().trim().min(7).max(30).optional(),
});
export type StorefrontShipAddress = z.infer<typeof storefrontShipAddressSchema>;

const itemsSchema = z
  .array(
    z.object({
      productId: z.string().uuid(),
      quantity: z.number().int().positive().max(999),
    }),
  )
  .min(1, "Add at least one item.")
  .max(50);

export const quoteSchema = z.object({
  items: itemsSchema,
  shipAddress: storefrontShipAddressSchema,
});
export type QuoteInput = z.infer<typeof quoteSchema>;

export const checkoutSchema = z.object({
  items: itemsSchema,
  shipAddress: storefrontShipAddressSchema,
  buyerEmail: z.string().trim().toLowerCase().email("Enter a valid email.").max(254),
  buyerName: z.string().trim().min(1).max(120).optional(),
  buyerPhone: z.string().trim().min(7).max(30).optional(),
  shippingSpeed: z.enum(["STANDARD", "EXPRESS"]),
  processor: z.enum(["STRIPE", "FLUTTERWAVE"]),
  discountCode: z.string().trim().min(1).max(40).optional(),
});
export type CheckoutInput = z.infer<typeof checkoutSchema>;

// Cross-vendor cart (Phase 2): shared buyer + address, one group per store.
export const crossVendorCheckoutSchema = z.object({
  shipAddress: storefrontShipAddressSchema,
  buyerEmail: z.string().trim().toLowerCase().email("Enter a valid email.").max(254),
  buyerName: z.string().trim().min(1).max(120).optional(),
  buyerPhone: z.string().trim().min(7).max(30).optional(),
  groups: z
    .array(
      z.object({
        slug: z.string().trim().min(1).max(60),
        items: itemsSchema,
        shippingSpeed: z.enum(["STANDARD", "EXPRESS"]),
        processor: z.enum(["STRIPE", "FLUTTERWAVE"]),
        discountCode: z.string().trim().min(1).max(40).optional(),
      }),
    )
    .min(1, "Your cart is empty.")
    .max(20),
});
export type CrossVendorCheckoutInput = z.infer<typeof crossVendorCheckoutSchema>;
