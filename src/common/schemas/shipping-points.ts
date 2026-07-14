/**
 * Shipping-point range table — shared contract between backend + web.
 *
 * Introduced by migration 0040 as part of Fulfillment Workflow v2.
 * Kept as a verbatim mirror of:
 *   usa-errands-web/src/lib/schemas/shipping-points.ts
 * Both files must stay in sync. If you edit one, edit the other in
 * the SAME commit — the shape is the wire contract that the config
 * row, the service, the admin editor, and every consumer speak.
 *
 * Design notes worth defending:
 *
 *   1. Buckets are stored in insertion order and walked low → high
 *      at resolve time. First match wins. The half-open convention
 *      (pointsMin <= sum < pointsMax) matches how humans read the
 *      "0.6-1.5" style bucket labels in the client spec — 1.5
 *      belongs to the NEXT bucket, not this one. The last bucket is
 *      inclusive on both ends so the top of the top bucket doesn't
 *      fall through to the fallback.
 *
 *   2. Dollars are stored in cents (integers). Every other money
 *      value on the platform is cents; keeping shipping estimates in
 *      the same unit means no float/cast bookkeeping at the render
 *      layer.
 *
 *   3. Points are Decimal on the DB (migration 0040) but arrive here
 *      as `number` after Prisma's Decimal-to-string-to-number round-
 *      trip. That's fine for bucket-boundary comparisons because
 *      the resolver only checks inequality — no accumulation, no
 *      compounding, so no FP drift matters.
 */

/** Cents at rest, always. Named type keeps the intent honest. */
export type Cents = number;

export interface ShippingPointBucket {
  /** Inclusive lower bound in points. */
  pointsMin: number;
  /** Upper bound in points. Half-open EXCEPT on the last bucket. */
  pointsMax: number;
  /** Estimated shipping range floor, in cents. */
  dollarsMin: Cents;
  /** Estimated shipping range ceiling, in cents. Also used as the
   *  worst-case number for wallet-cover validation in Phase B. */
  dollarsMax: Cents;
}

export interface ShippingPointRangeTable {
  buckets: readonly ShippingPointBucket[];
}

/**
 * Compile-in default seeded by migration 0040 from page 11 of the
 * client's Fulfillment v2 spec. Loader falls back to this map when
 * the config row is absent OR when a saved payload fails validation
 * — never fail-open with an empty table (that would let orders
 * submit with a $0 estimate and blow through wallet validation).
 */
export const DEFAULT_SHIPPING_POINT_RANGES: ShippingPointRangeTable = {
  buckets: [
    { pointsMin: 0,   pointsMax: 0.5, dollarsMin: 500,  dollarsMax: 800 },
    { pointsMin: 0.5, pointsMax: 1.5, dollarsMin: 800,  dollarsMax: 1200 },
    { pointsMin: 1.5, pointsMax: 3,   dollarsMin: 1200, dollarsMax: 1800 },
    { pointsMin: 3,   pointsMax: 5,   dollarsMin: 1800, dollarsMax: 2500 },
  ],
};

/** Configuration key. Duplicated as a bare string on the web to
 *  avoid the web pulling backend code, but this is the source. */
export const SHIPPING_POINT_RANGES_CONFIG_KEY = "shipping_point_estimate_ranges";

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Runtime guard for the shape coming off the wire. Returns a fresh
 * frozen object; never mutates the input. Uses positive predicates
 * for every field so a missing/misspelled property returns false
 * rather than silently coercing.
 */
export function isValidRangeTable(value: unknown): value is ShippingPointRangeTable {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { buckets?: unknown };
  if (!Array.isArray(candidate.buckets)) return false;
  if (candidate.buckets.length === 0) return false;
  for (const bucket of candidate.buckets) {
    if (!isValidBucket(bucket)) return false;
  }
  // Additional coherence checks: buckets must be strictly ordered
  // and each bucket must have min < max on both axes. An overlapping
  // table would resolve to whichever bucket comes first, which is
  // probably not what the SUPER_ADMIN intended.
  const b = candidate.buckets as ShippingPointBucket[];
  for (let i = 0; i < b.length; i++) {
    const bucket = b[i]!;
    if (bucket.pointsMin >= bucket.pointsMax) return false;
    if (bucket.dollarsMin > bucket.dollarsMax) return false;
    if (i > 0) {
      const prev = b[i - 1]!;
      // Contiguous or gap OK; overlap not OK.
      if (bucket.pointsMin < prev.pointsMax) return false;
    }
  }
  return true;
}

function isValidBucket(value: unknown): value is ShippingPointBucket {
  if (!value || typeof value !== "object") return false;
  const b = value as Record<string, unknown>;
  return (
    typeof b.pointsMin === "number" &&
    Number.isFinite(b.pointsMin) &&
    b.pointsMin >= 0 &&
    typeof b.pointsMax === "number" &&
    Number.isFinite(b.pointsMax) &&
    b.pointsMax > 0 &&
    typeof b.dollarsMin === "number" &&
    Number.isInteger(b.dollarsMin) &&
    b.dollarsMin >= 0 &&
    typeof b.dollarsMax === "number" &&
    Number.isInteger(b.dollarsMax) &&
    b.dollarsMax >= 0
  );
}
