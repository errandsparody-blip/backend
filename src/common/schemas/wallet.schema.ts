import { z } from "zod";

export const ledgerEntryTypes = [
  "DEPOSIT",
  "ONBOARDING",
  "STORAGE",
  "FULFILLMENT",
  "SHIPPING",
  "RETURN",
  "MANUAL_CREDIT",
  "MANUAL_DEBIT",
  "REVERSAL",
] as const;

export const listLedgerSchema = z.object({
  type: z.enum(ledgerEntryTypes).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});
export type ListLedgerInput = z.infer<typeof listLedgerSchema>;

export const updateWalletSettingsSchema = z.object({
  lowBalanceThresholdCents: z.coerce.number().int().nonnegative().max(1_000_000),
});
export type UpdateWalletSettingsInput = z.infer<typeof updateWalletSettingsSchema>;
