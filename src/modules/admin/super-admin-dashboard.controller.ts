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
}
