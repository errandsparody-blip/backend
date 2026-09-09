/**
 * Payout-account connection schemas (Migration 0059).
 */
import { z } from "zod";

export const processorParamSchema = z.enum(["STRIPE", "PAYSTACK"]);
export type ProcessorParam = z.infer<typeof processorParamSchema>;

// Stripe onboarding needs no body — the server builds the return/refresh URLs.
// Paystack needs the vendor's bank details to create a subaccount.
export const connectPaystackSchema = z.object({
  businessName: z.string().trim().min(1, "Required.").max(120),
  settlementBank: z
    .string()
    .trim()
    .min(1, "Bank code required.")
    .max(20),
  accountNumber: z
    .string()
    .trim()
    .regex(/^[0-9]{6,20}$/, "Enter a valid account number (digits only)."),
});
export type ConnectPaystackInput = z.infer<typeof connectPaystackSchema>;
