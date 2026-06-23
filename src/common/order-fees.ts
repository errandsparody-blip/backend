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

import {
  DEFAULT_FULFILLMENT_MAX_CENTS,
  DEFAULT_SHIPPING_MARKUP_BPS,
  type FeeSchedule,
} from "./fees";

/**
 * Markup applied on top of the carrier's quoted shipping cost. The live value
 * comes from the admin-editable fee schedule (`schedule.shippingMarkupBps`);
 * this constant is only the fallback when a schedule predates that field.
 */
export const SHIPPING_MARKUP_BPS = DEFAULT_SHIPPING_MARKUP_BPS; // 10.00%

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

  // Shipping fee: cost + markup. The markup rate is admin-configurable via the
  // fee schedule; fall back to the default for schedules that predate it.
  const markupBps =
    typeof args.schedule.shippingMarkupBps === "number" && args.schedule.shippingMarkupBps >= 0
      ? args.schedule.shippingMarkupBps
      : SHIPPING_MARKUP_BPS;
  // Round UP so we never under-bill ourselves.
  const markup = Math.ceil((args.carrierCostCents * markupBps) / 10_000);
  const shippingFeeCents = args.carrierCostCents + markup;

  // Fulfillment fee: base for the first unit + per-additional for the rest,
  // capped at the admin-configurable max so a large multi-item order to one
  // customer never exceeds it (e.g. 10 items → $10.99, not $11.90).
  const { baseCents, perAdditionalUnitCents } = args.schedule.fulfillment;
  const additional = Math.max(0, args.totalUnits - 1);
  const uncappedFulfillmentCents = baseCents + additional * perAdditionalUnitCents;
  const maxCents =
    typeof args.schedule.fulfillment.maxCents === "number" &&
    args.schedule.fulfillment.maxCents > 0
      ? args.schedule.fulfillment.maxCents
      : DEFAULT_FULFILLMENT_MAX_CENTS;
  const fulfillmentFeeCents = Math.min(uncappedFulfillmentCents, maxCents);

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
  // Optional — vendors may not have measured product dimensions yet.
  // Lines without dims contribute weight only; the parcel envelope
  // collapses to whatever the dimensioned lines say (or zeros, in which
  // case the carrier rates from weight alone — less precise but valid).
  lengthIn: number | null;
  widthIn: number | null;
  heightIn: number | null;
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
    // Nullable dims — treat unset as 0. Math.max with the running max
    // means a line without dims doesn't shrink the envelope; height
    // simply doesn't grow for those lines.
    lengthIn = Math.max(lengthIn, l.lengthIn ?? 0);
    widthIn = Math.max(widthIn, l.widthIn ?? 0);
    // Height stacks (rough heuristic: items stacked vertically).
    heightIn += (l.heightIn ?? 0) * l.qty;
  }
  return {
    weightOz: Math.ceil(weightOz),
    lengthIn: Math.ceil(lengthIn),
    widthIn: Math.ceil(widthIn),
    heightIn: Math.ceil(heightIn),
  };
}
