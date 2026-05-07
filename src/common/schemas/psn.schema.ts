import { z } from "zod";

const tierSchema = z.enum(["SMALL", "MEDIUM", "LARGE", "X_LARGE", "PALLET"]);

export const psnLineInputSchema = z.object({
  productId: z.string().uuid(),
  declaredQty: z.number().int().positive().max(100_000),
  notes: z.string().max(500).optional(),
});
export type PsnLineInput = z.infer<typeof psnLineInputSchema>;

export const declaredBoxCountsSchema = z
  .record(tierSchema, z.number().int().nonnegative().max(1000))
  .refine((obj) => Object.values(obj).some((v) => (v ?? 0) > 0), {
    message: "Declare at least one box.",
  });

export const createPsnSchema = z.object({
  expectedArrivalDate: z.coerce.date().optional(),
  carrier: z.string().min(2).max(60).optional(),
  masterTracking: z.string().min(3).max(80).optional(),
  declaredBoxCounts: declaredBoxCountsSchema,
  notes: z.string().max(1000).optional(),
  lines: z.array(psnLineInputSchema).min(1, "At least one line is required."),
});
export type CreatePsnInput = z.infer<typeof createPsnSchema>;

export const updatePsnDraftSchema = createPsnSchema.partial();
export type UpdatePsnDraftInput = z.infer<typeof updatePsnDraftSchema>;

export const listPsnsSchema = z.object({
  status: z.enum(["DRAFT", "SUBMITTED", "AWAITING_RECEIPT", "PARTIALLY_RECEIVED", "RECEIVED", "DISCREPANCY", "CANCELLED"]).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
});
export type ListPsnsInput = z.infer<typeof listPsnsSchema>;

// ---- admin (operator) receiving ----
export const receiveLineSchema = z.object({
  lineId: z.string().uuid(),
  acceptedQty: z.number().int().nonnegative(),
  damagedQty: z.number().int().nonnegative().default(0),
  notes: z.string().max(500).optional(),
});
export type ReceiveLineInput = z.infer<typeof receiveLineSchema>;

export const completeReceivingSchema = z.object({
  lines: z.array(receiveLineSchema).min(1),
});
export type CompleteReceivingInput = z.infer<typeof completeReceivingSchema>;
