import { z } from "zod";

export const updateVendorSchema = z.object({
  businessName: z.string().min(2).max(120).optional(),
});
export type UpdateVendorInput = z.infer<typeof updateVendorSchema>;

export const acceptAgreementSchema = z.object({
  version: z.string().min(1),
});
export type AcceptAgreementInput = z.infer<typeof acceptAgreementSchema>;
