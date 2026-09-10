/**
 * Payout-account connection schemas (Migration 0059).
 */
import { z } from "zod";

// PAYSTACK stays valid for historic rows but is no longer connectable; the
// active non-Stripe rail is FLUTTERWAVE.
export const processorParamSchema = z.enum(["STRIPE", "PAYSTACK", "FLUTTERWAVE"]);
export type ProcessorParam = z.infer<typeof processorParamSchema>;

// Stripe onboarding needs no body — the server builds the return/refresh URLs.
// Flutterwave needs the vendor's bank details to create a payout subaccount.
export const connectFlutterwaveSchema = z.object({
  businessName: z.string().trim().min(1, "Required.").max(120),
  /** Flutterwave bank code (from GET /payments/flutterwave/banks). */
  accountBank: z
    .string()
    .trim()
    .min(1, "Bank code required.")
    .max(20),
  accountNumber: z
    .string()
    .trim()
    .regex(/^[0-9]{6,20}$/, "Enter a valid account number (digits only)."),
  /** ISO country code of the bank account, e.g. "NG", "GH", "KE". */
  country: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, "Enter a 2-letter country code.")
    .transform((c) => c.toUpperCase()),
  businessMobile: z
    .string()
    .trim()
    .max(20)
    .optional(),
});
export type ConnectFlutterwaveInput = z.infer<typeof connectFlutterwaveSchema>;
