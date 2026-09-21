/**
 * Public self-service return schemas (Migration 0072).
 *
 * A buyer looks up their order by reference + email, then opens returns on one
 * or more sub-orders of that cart, supplying the tracking number of the parcel
 * they've shipped back to USA Errands.
 */
import { z } from "zod";

const email = z.string().trim().toLowerCase().email("Enter a valid email.");
const orderRef = z.string().trim().min(3, "Enter your order number.").max(40);

export const returnLookupSchema = z.object({
  reference: orderRef,
  email,
});
export type ReturnLookupInput = z.infer<typeof returnLookupSchema>;

export const returnRequestSchema = z.object({
  email,
  // One or more sub-order references from the same cart.
  references: z.array(orderRef).min(1, "Select at least one order to return.").max(50),
  reason: z.string().trim().min(3, "Tell us why you're returning it.").max(1000),
  trackingNumber: z.string().trim().min(3, "Enter the return tracking number.").max(80),
});
export type ReturnRequestInput = z.infer<typeof returnRequestSchema>;
