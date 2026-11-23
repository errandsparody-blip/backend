/**
 * SUPER_ADMIN dashboard endpoint.
 *
 * Route:
 *   GET /v1/admin/super-dashboard — SUPER_ADMIN only.
 *
 * The response is `SuperAdminSnapshot`. Every field is present with
 * a safe zero default; no field is ever `null` on the wire.
 *
 * Rate-limited (30 req/min) to prevent a dashboard tab left open on
 * a laptop from hammering the DB with heavy aggregate queries.
 */

import { Controller, Get, HttpCode, HttpStatus, Query } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Role } from "@prisma/client";

import { Roles } from "../../common/decorators/roles.decorator";

import {
  SuperAdminDashboardService,
  type FeeGranularity,
} from "./super-admin-dashboard.service";

@Controller({ path: "admin/super-dashboard", version: "1" })
@Roles(Role.SUPER_ADMIN)
export class SuperAdminDashboardController {
  constructor(private readonly service: SuperAdminDashboardService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async snapshot() {
    return this.service.snapshot();
  }

  /**
   * Fulfillment-fee + shipping spend over a date window, bucketed daily /
   * weekly / monthly. Query params (all optional):
   *   granularity = day | week | month   (default: day)
   *   from, to    = ISO date/datetime     (default: last 30 days)
   * `to` is exclusive. Bad/garbage params fall back to safe defaults rather
   * than 400-ing a dashboard widget.
   */
  @Get("fees")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async fees(
    @Query("granularity") granularity?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    const g: FeeGranularity =
      granularity === "week" || granularity === "month" ? granularity : "day";

    const now = new Date();
    const parse = (s: string | undefined): Date | null => {
      if (!s) return null;
      const d = new Date(s);
      return Number.isNaN(d.getTime()) ? null : d;
    };
    const toDate = parse(to) ?? now;
    // Default window is the 30 days before `to`.
    const fromDate =
      parse(from) ?? new Date(toDate.getTime() - 30 * 24 * 60 * 60 * 1000);
    // Guard against an inverted range (from after to) — swap so the query is
    // always well-formed.
    const [lo, hi] =
      fromDate.getTime() <= toDate.getTime()
        ? [fromDate, toDate]
        : [toDate, fromDate];

    return this.service.feeBreakdown({ from: lo, to: hi, granularity: g });
  }

  /**
   * Per-order fulfillment activity — fulfillment price, the admin who packed
   * (processed) the order, and the date, with filters by admin, date and
   * country. Keyset-paginated via `before` (ISO packed_at of the last row).
   * Garbage params fall back to "no filter" rather than 400-ing.
   */
  @Get("fulfillment-activity")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async fulfillmentActivity(
    @Query("adminId") adminId?: string,
    @Query("country") country?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("before") before?: string,
    @Query("limit") limit?: string,
  ) {
    const parse = (s: string | undefined): Date | null => {
      if (!s) return null;
      const d = new Date(s);
      return Number.isNaN(d.getTime()) ? null : d;
    };
    const uuidRe =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const n = Number(limit);
    const lim = Number.isFinite(n) && n > 0 && n <= 100 ? Math.floor(n) : 50;

    return this.service.fulfillmentActivity({
      adminId: adminId && uuidRe.test(adminId) ? adminId : null,
      country: country === "US" || country === "CA" ? country : null,
      from: parse(from),
      to: parse(to),
      before: parse(before),
      limit: lim,
    });
  }
}
