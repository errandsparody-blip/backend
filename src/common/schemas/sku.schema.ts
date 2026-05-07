import { z } from "zod";

export const listSkusSchema = z.object({
  status: z.enum(["ACTIVE", "RESERVED", "DAMAGED", "QUARANTINED", "OUT_OF_STOCK"]).optional(),
  productId: z.string().uuid().optional(),
  search: z.string().min(1).max(120).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});
export type ListSkusInput = z.infer<typeof listSkusSchema>;
