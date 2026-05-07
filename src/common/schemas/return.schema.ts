/**
 * Returns API Zod schemas.
 *
 * Implementation Plan §6.7.
 */

import { z } from "zod";

export const RETURN_REASON = [
  "NOT_AS_DESCRIBED",
  "DEFECTIVE",
  "WRONG_ITEM",
  "CHANGED_MIND",
  "ARRIVED_DAMAGED",
  "NEVER_DELIVERED",
  "OTHER",
] as const;
export type ReturnReason = (typeof RETURN_REASON)[number];

export const RETURN_STATUS = [
  "REQUESTED",
  "AUTHORIZED",
  "IN_TRANSIT",
  "RECEIVED",
  "INSPECTED",
  "RESTOCKED",
  "DISPOSED",
  "REJECTED",
  "CANCELLED",
] as const;
export type ReturnStatus = (typeof RETURN_STATUS)[number];

// ---------------------------------------------------------------------------
// Vendor — create + cancel
// ---------------------------------------------------------------------------

export const createReturnLineSchema = z.object({
  orderLineId: z.string().uuid(),
  requestedQty: z.number().int().positive().max(10_000),
});
export type CreateReturnLineInput = z.infer<typeof createReturnLineSchema>;

export const createReturnSchema = z.object({
  orderId: z.string().uuid(),
  reason: z.enum(RETURN_REASON),
  lines: z.array(createReturnLineSchema).min(1).max(50),
});
export type CreateReturnInput = z.infer<typeof createReturnSchema>;

export const listReturnsSchema = z.object({
  status: z.enum(RETURN_STATUS).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
});
export type ListReturnsInput = z.infer<typeof listReturnsSchema>;

// ---------------------------------------------------------------------------
// Admin — receive + inspect
// ---------------------------------------------------------------------------

export const receiveReturnLineSchema = z.object({
  returnLineId: z.string().uuid(),
  receivedQty: z.number().int().nonnegative().max(10_000),
});
export type ReceiveReturnLineInput = z.infer<typeof receiveReturnLineSchema>;

export const receiveReturnSchema = z.object({
  lines: z.array(receiveReturnLineSchema).min(1),
});
export type ReceiveReturnInput = z.infer<typeof receiveReturnSchema>;

export const inspectReturnLineSchema = z
  .object({
    returnLineId: z.string().uuid(),
    restockedQty: z.number().int().nonnegative().max(10_000).default(0),
    damagedQty: z.number().int().nonnegative().max(10_000).default(0),
    disposedQty: z.number().int().nonnegative().max(10_000).default(0),
    notes: z.string().max(500).optional(),
  });
export type InspectReturnLineInput = z.infer<typeof inspectReturnLineSchema>;

export const inspectReturnSchema = z.object({
  lines: z.array(inspectReturnLineSchema).min(1),
  refundAmountCents: z.number().int().nonnegative().max(50_000_000).default(0),
  restockFeeCents: z.number().int().nonnegative().max(50_000_000).default(0),
  inspectorNotes: z.string().max(2000).optional(),
});
export type InspectReturnInput = z.infer<typeof inspectReturnSchema>;
