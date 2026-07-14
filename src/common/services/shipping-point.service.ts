/**
 * ShippingPointService — resolves per-product shipping points into a
 * vendor-facing estimate range (Phase A of Fulfillment Workflow v2).
 *
 * Single responsibility: turn (line items) → (estimated $ range).
 * Does NOT compute wallet debits, does NOT trigger any downstream
 * side effects. Callers (order create, wizard preview, wallet
 * validator) read from this service and decide what to do with the
 * output.
 *
 * Cache semantics: the range-table config row is read at most once
 * every 30 seconds per API process. Config edits from
 * AdminShippingPointRangesController bust the cache on write so a
 * super admin editing the table sees the effect immediately without
 * a 30-second lag. Cache misses fall through to a fresh Postgres
 * read; cache hits are in-memory.
 *
 * Defence in depth: if the config row is absent OR fails the
 * shape validator, we fall back to DEFAULT_SHIPPING_POINT_RANGES.
 * Never fail-open with an empty table — an empty table would
 * silently produce a $0 estimate and blow through the wallet-cover
 * check downstream in Phase B.
 */

import { Injectable, Logger } from "@nestjs/common";

import { PrismaService } from "../prisma.service";
import {
  DEFAULT_SHIPPING_POINT_RANGES,
  isValidRangeTable,
  SHIPPING_POINT_RANGES_CONFIG_KEY,
  type ShippingPointRangeTable,
} from "../schemas/shipping-points";

/**
 * Range shown to the vendor at submit. Both bounds are in cents; the
 * render layer formats them as $X.XX. When a summed points value
 * doesn't hit any bucket (e.g., the vendor's order exceeds the top
 * bucket's ceiling), the resolver clamps to the top bucket rather
 * than returning null. Reason: an unrepresented sum is more likely a
 * config gap than a "we don't ship this" signal — clamping keeps the
 * order eligible for submit while still surfacing the (approximate)
 * upper bound to the vendor and to wallet validation.
 */
export interface EstimatedShippingRange {
  dollarsMin: number;
  dollarsMax: number;
}

/** Per-product shipping-point resolution outcome, used by the
 *  order create path in Phase B. Callers block submit when ANY line
 *  reports `assigned: false`. */
export interface LinePointResolution {
  productId: string;
  points: number | null;
  assigned: boolean;
}

@Injectable()
export class ShippingPointService {
  private readonly logger = new Logger(ShippingPointService.name);
  private cache: { fetchedAt: number; table: ShippingPointRangeTable } | null =
    null;
  private readonly CACHE_TTL_MS = 30_000;

  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // Product-level reads
  // -------------------------------------------------------------------------

  /**
   * Fetch a single product's shipping points. Returns null when the
   * product exists but has no points assigned yet (super admin must
   * set them on the receiving flow); returns null too when the
   * product doesn't exist (caller decides how to surface).
   */
  async getPoints(productId: string): Promise<number | null> {
    // Fetch the whole product row (no `select`) and cast on the way
    // out — the local Prisma client may not include the migration
    // 0040 columns until `prisma generate` runs on the deploy
    // machine. This shape works whether the client is stale or
    // fresh because we treat the shippingPoints field as unknown
    // and normalise defensively.
    const product = (await this.prisma.product.findUnique({
      where: { id: productId },
    })) as unknown as { shippingPoints?: unknown } | null;
    if (!product) return null;
    return this.decimalToNumber(product.shippingPoints);
  }

  /**
   * Sum shipping points across a set of order lines. Returns:
   *   - `totalPoints` — the sum (0 if every line is unassigned)
   *   - `resolutions` — per-line detail so the caller can surface
   *     which SKUs are blocking submit
   *   - `allAssigned` — convenience boolean; true iff every line
   *     has a non-null shippingPoints value
   *
   * Multiplied by quantity — five units of a 0.5-point SKU count as
   * 2.5 points, not 0.5. That mirrors how weight rolls up.
   */
  async sumForLines(
    lines: ReadonlyArray<{ productId: string; quantity: number }>,
  ): Promise<{
    totalPoints: number;
    resolutions: LinePointResolution[];
    allAssigned: boolean;
  }> {
    if (lines.length === 0) {
      return { totalPoints: 0, resolutions: [], allAssigned: true };
    }
    const uniqueProductIds = Array.from(new Set(lines.map((l) => l.productId)));
    // Same rationale as getPoints(): fetch whole rows so we don't
    // trip the stale-Prisma-client select check. The shape cast on
    // the way out treats shippingPoints as unknown; decimalToNumber
    // normalises every representation Prisma can return.
    const rows = (await this.prisma.product.findMany({
      where: { id: { in: uniqueProductIds } },
    })) as unknown as Array<{ id: string; shippingPoints?: unknown }>;
    const pointsById = new Map<string, number | null>();
    for (const row of rows) {
      pointsById.set(row.id, this.decimalToNumber(row.shippingPoints));
    }

    let totalPoints = 0;
    let allAssigned = true;
    const resolutions: LinePointResolution[] = [];
    for (const line of lines) {
      const points = pointsById.get(line.productId) ?? null;
      const assigned = typeof points === "number" && Number.isFinite(points);
      if (!assigned) allAssigned = false;
      if (assigned) totalPoints += (points as number) * line.quantity;
      resolutions.push({
        productId: line.productId,
        points: assigned ? (points as number) : null,
        assigned,
      });
    }
    return { totalPoints, resolutions, allAssigned };
  }

  // -------------------------------------------------------------------------
  // Range resolution
  // -------------------------------------------------------------------------

  /**
   * Map a summed points value to an estimated dollar range. Walks
   * the config buckets low → high and returns the first match.
   * Boundary rule: pointsMin <= totalPoints < pointsMax, except the
   * LAST bucket which is inclusive on the right so the top of the
   * table doesn't fall through. Anything above the top bucket
   * clamps to that bucket — a superset check on config gaps.
   */
  async resolveRange(totalPoints: number): Promise<EstimatedShippingRange> {
    const table = await this.loadTable();
    const buckets = table.buckets;
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i]!;
      const isLast = i === buckets.length - 1;
      const inRange = isLast
        ? totalPoints >= b.pointsMin && totalPoints <= b.pointsMax
        : totalPoints >= b.pointsMin && totalPoints < b.pointsMax;
      if (inRange) {
        return { dollarsMin: b.dollarsMin, dollarsMax: b.dollarsMax };
      }
    }
    // Fell off the top of the table — clamp to the highest bucket.
    // Better than returning $0 (which would sail through wallet
    // validation and leave USA Errands holding the shipping bill).
    const top = buckets[buckets.length - 1]!;
    return { dollarsMin: top.dollarsMin, dollarsMax: top.dollarsMax };
  }

  // -------------------------------------------------------------------------
  // Config editor helpers — used by the admin ranges controller.
  // -------------------------------------------------------------------------

  /** Fresh (uncached) read of the range table. Used by the config
   *  editor so a super admin refreshing the page sees the actual
   *  persisted state, not a stale 30s cache. */
  async readTableFresh(): Promise<ShippingPointRangeTable> {
    const fresh = await this.fetchTableFromDb();
    this.cache = { fetchedAt: Date.now(), table: fresh };
    return fresh;
  }

  /** Persist a new range table. Validated before write; bad shapes
   *  reject with an error the controller surfaces as 400. Cache is
   *  invalidated so the next resolve call sees the new table. */
  async writeTable(next: unknown): Promise<ShippingPointRangeTable> {
    if (!isValidRangeTable(next)) {
      throw new Error("shipping_point_range_table_invalid");
    }
    // Store cents as integers — enforced by validator, restated
    // here as documentation of the wire contract.
    const payload = next satisfies ShippingPointRangeTable;
    await this.prisma.configuration.upsert({
      where: { key: SHIPPING_POINT_RANGES_CONFIG_KEY },
      create: {
        key: SHIPPING_POINT_RANGES_CONFIG_KEY,
        value: payload as unknown as object,
        description:
          "Fulfillment v2 — maps summed shipping points to an estimated $ range shown to the vendor at order submit. Editable by super admin. Cents at rest.",
      },
      update: { value: payload as unknown as object },
    });
    this.cache = { fetchedAt: Date.now(), table: payload };
    return payload;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async loadTable(): Promise<ShippingPointRangeTable> {
    const now = Date.now();
    if (this.cache && now - this.cache.fetchedAt < this.CACHE_TTL_MS) {
      return this.cache.table;
    }
    const fresh = await this.fetchTableFromDb();
    this.cache = { fetchedAt: now, table: fresh };
    return fresh;
  }

  private async fetchTableFromDb(): Promise<ShippingPointRangeTable> {
    try {
      const row = await this.prisma.configuration.findUnique({
        where: { key: SHIPPING_POINT_RANGES_CONFIG_KEY },
      });
      if (!row) return DEFAULT_SHIPPING_POINT_RANGES;
      if (isValidRangeTable(row.value)) return row.value;
      this.logger.warn(
        { key: SHIPPING_POINT_RANGES_CONFIG_KEY },
        "shipping_point_estimate_ranges config row failed shape validation; falling back to defaults",
      );
      return DEFAULT_SHIPPING_POINT_RANGES;
    } catch (err) {
      // A DB failure here would 500 every order submit that touches
      // shipping-point resolution. Degrade to defaults instead —
      // conservative estimates are much better than a totally
      // broken order path.
      this.logger.error(
        { err },
        "shipping-point config load failed; falling back to defaults",
      );
      return DEFAULT_SHIPPING_POINT_RANGES;
    }
  }

  /**
   * Prisma returns Decimal as an object with a `.toNumber()` method,
   * or as a string when the client is stale, or as null when unset.
   * Normalise every shape into `number | null` so callers get a
   * plain value. NaN / Infinity are rejected as null — a bogus
   * value that got past validation shouldn't propagate through the
   * sum.
   */
  private decimalToNumber(v: unknown): number | null {
    if (v === null || v === undefined) return null;
    if (typeof v === "number") {
      return Number.isFinite(v) ? v : null;
    }
    if (typeof v === "string") {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    if (typeof v === "object" && typeof (v as { toNumber?: unknown }).toNumber === "function") {
      const n = (v as { toNumber: () => number }).toNumber();
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }
}
