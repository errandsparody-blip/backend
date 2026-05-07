/**
 * Order-side fee math, kept pure and unit-testable.
 *
 * Implementation Plan §6.3, §6.6.
 *
 * Inputs: the loaded fee schedule + the shipping cost from the carrier + the
 * line items + the declared total value.
 *
 * Output: a typed breakdown of every cents value we're going to write to the
 * `orders` row. The OrderService reads this and trusts it; the service does
 * not do its own math beyond passing values through.
 */

import type { FeeSchedule } from "./fees";

/** Markup applied on top of the carrier's quoted shipping cost. 10% v1. */
export const SHIPPING_MARKUP_BPS = 1000; // 10.00%

/** Insurance is 1.5% of declared value, when requested. */
export const INSURANCE_RATE_BPS = 150;

export interface ComputeOrderFeesArgs {
  schedule: FeeSchedule;
  /** Total quantity of units across all lines. */
  totalUnits: number;
  /** What the carrier charges us, in cents. */
  carrierCostCents: number;
  /** Sum of declared values across all order lines, in cents. */
  declaredValueCents: number;
  insuranceRequested: boolean;
}

export interface OrderFeeBreakdown {
  shippingCostCents: number;        // pass-through carrier cost
  shippingFeeCents: number;         // what we charge vendor (cost + markup, rounded up)
  fulfillmentFeeCents: number;
  insuranceFeeCents: number;
  totalChargedCents: number;        // shipping + fulfillment + insurance
}

export function computeOrderFees(args: ComputeOrderFeesArgs): OrderFeeBreakdown {
  if (!Number.isInteger(args.totalUnits) || args.totalUnits <= 0) {
    throw new Error("totalUnits must be a positive integer.");
  }
  if (!Number.isInteger(args.carrierCostCents) || args.carrierCostCents < 0) {
    throw new Error("carrierCostCents must be a non-negative integer.");
  }
  if (!Number.isInteger(args.declaredValueCents) || args.declaredValueCents < 0) {
    throw new Error("declaredValueCents must be a non-negative integer.");
  }

  // Shipping fee: cost + markup. Round UP so we never under-bill ourselves.
  const markup = Math.ceil((args.carrierCostCents * SHIPPING_MARKUP_BPS) / 10_000);
  const shippingFeeCents = args.carrierCostCents + markup;

  // Fulfillment fee: base for the first unit + per-additional for the rest.
  const { baseCents, perAdditionalUnitCents } = args.schedule.fulfillment;
  const additional = Math.max(0, args.totalUnits - 1);
  const fulfillmentFeeCents = baseCents + additional * perAdditionalUnitCents;

  // Insurance: 1.5% of declared value, only when requested.
  const insuranceFeeCents = args.insuranceRequested
    ? Math.ceil((args.declaredValueCents * INSURANCE_RATE_BPS) / 10_000)
    : 0;

  const totalChargedCents = shippingFeeCents + fulfillmentFeeCents + insuranceFeeCents;

  return {
    shippingCostCents: args.carrierCostCents,
    shippingFeeCents,
    fulfillmentFeeCents,
    insuranceFeeCents,
    totalChargedCents,
  };
}

/**
 * Aggregate parcel — naive sum of weights, max of each dimension. Real
 * dimensional weight is bin-packing; that's a P4 polish concern. v1 ships
 * a single parcel per order.
 */
export interface ParcelLineDims {
  qty: number;
  weightOz: number;
  lengthIn: number;
  widthIn: number;
  heightIn: number;
}

export function aggregateParcel(lines: ParcelLineDims[]): {
  weightOz: number;
  lengthIn: number;
  widthIn: number;
  heightIn: number;
} {
  if (lines.length === 0) {
    throw new Error("aggregateParcel requires at least one line.");
  }
  let weightOz = 0;
  let lengthIn = 0;
  let widthIn = 0;
  let heightIn = 0;
  for (const l of lines) {
    if (l.qty <= 0) continue;
    weightOz += l.weightOz * l.qty;
    lengthIn = Math.max(lengthIn, l.lengthIn);
    widthIn = Math.max(widthIn, l.widthIn);
    // Height stacks (rough heuristic: items stacked vertically).
    heightIn += l.heightIn * l.qty;
  }
  return {
    weightOz: Math.ceil(weightOz),
    lengthIn: Math.ceil(lengthIn),
    widthIn: Math.ceil(widthIn),
    heightIn: Math.ceil(heightIn),
  };
}
