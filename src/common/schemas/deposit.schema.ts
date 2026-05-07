import { z } from "zod";

export const fundStripeSchema = z.object({
  /** Net cents the vendor wants in the wallet after the deposit. */
  netAmountCents: z.coerce.number().int().positive().min(100).max(10_000_000),
});
export type FundStripeInput = z.infer<typeof fundStripeSchema>;

export const adminCreditSchema = z.object({
  amountCents: z.coerce.number().int().positive().min(100).max(50_000_000),
  /** "WISE" | "PAYONEER" | "SUPPORT" | "REVERSAL" — captured in the description. */
  reason: z.string().min(2).max(120),
  /** Provider-side reference number (Wise transfer id, Payoneer ref, etc.). */
  reference: z.string().min(2).max(120).optional(),
});
export type AdminCreditInput = z.infer<typeof adminCreditSchema>;
