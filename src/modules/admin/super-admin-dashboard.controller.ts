/**
 * SUPER_ADMIN dashboard endpoint (Phase H).
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

import { Controller, Get, HttpCode, HttpStatus } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Role } from "@prisma/client";

import { Roles } from "../../common/decorators/roles.decorator";

import { SuperAdminDashboardService } from "./super-admin-dashboard.service";

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
}
