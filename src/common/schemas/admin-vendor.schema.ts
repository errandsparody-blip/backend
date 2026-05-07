/**
 * Zod schemas for the admin vendor management endpoints. Mirror file in
 * usa-errands-web/src/lib/schemas/admin-vendor.ts — keep in sync.
 */

import { z } from "zod";

// Reasons must be substantive but not so long they become an essay. The DB
// column is plain TEXT so we cap at 1000 to prevent abuse.
const reasonSchema = z
  .string()
  .trim()
  .min(10, "Give the vendor at least one full sentence so they know what to fix.")
  .max(1000, "Keep it under 1000 characters.");

export const approveKycSchema = z.object({
  // Optional internal note; stored on audit, never emailed.
  notes: z.string().trim().max(500).optional().or(z.literal("").transform(() => undefined)),
});
export type ApproveKycInput = z.infer<typeof approveKycSchema>;

export const rejectKycSchema = z.object({
  reason: reasonSchema,
});
export type RejectKycInput = z.infer<typeof rejectKycSchema>;

export const requestResubmissionSchema = z.object({
  reason: reasonSchema,
});
export type RequestResubmissionInput = z.infer<typeof requestResubmissionSchema>;

export const verifySocialSchema = z.object({
  // Optional admin notes; visible only on the audit trail.
  notes: z.string().trim().max(500).optional().or(z.literal("").transform(() => undefined)),
});
export type VerifySocialInput = z.infer<typeof verifySocialSchema>;
