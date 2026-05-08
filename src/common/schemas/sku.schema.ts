import { z } from "zod";

export const listSkusSchema = z.object({
  status: z.enum(["ACTIVE", "RESERVED", "DAMAGED", "QUARANTINED", "OUT_OF_STOCK"]).optional(),
  productId: z.string().uuid().optional(),
  search: z.string().min(1).max(120).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});
export type ListSkusInput = z.infer<typeof listSkusSchema>;

// ---------------------------------------------------------------------------
// Admin-only — cross-vendor list, plus the manual adjust write.
// ---------------------------------------------------------------------------

export const adminListSkusSchema = listSkusSchema.extend({
  vendorId: z.string().uuid().optional(),
  storageTier: z.enum(["SMALL", "MEDIUM", "LARGE", "X_LARGE", "PALLET"]).optional(),
  /** When true, only return rows where quantityAvailable + quantityReserved is 0. */
  zeroOnly: z.coerce.boolean().optional(),
});
export type AdminListSkusInput = z.infer<typeof adminListSkusSchema>;

/**
 * Manual stock adjustment. Reason is a stable enum so the audit log and
 * downstream reporting can categorise corrections; `note` carries the
 * operator's free-text explanation. Delta is signed: positive = found
 * extra units, negative = removing units (cycle-count loss, write-off).
 */
export const adminAdjustSkuSchema = z.object({
  delta: z.coerce
    .number()
    .int("Whole units only.")
    .refine((v) => v !== 0, "Adjustment must be non-zero.")
    .refine((v) => Math.abs(v) <= 100_000, "Adjust at most 100k units in one go."),
  reason: z.enum([
    "CYCLE_COUNT",
    "FOUND",
    "LOST",
    "DAMAGE_WRITE_OFF",
    "RECONCILIATION",
    "OTHER",
  ]),
  note: z.string().trim().min(1).max(500).optional(),
});
export type AdminAdjustSkuInput = z.infer<typeof adminAdjustSkuSchema>;

export const adminListMovementsSchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});
export type AdminListMovementsInput = z.infer<typeof adminListMovementsSchema>;
