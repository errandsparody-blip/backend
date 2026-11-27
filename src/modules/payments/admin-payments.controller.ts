/**
 * Admin payment diagnostics (SUPER_ADMIN).
 *
 *   GET /v1/admin/payments/flutterwave/health
 *
 * A read-only check that the Flutterwave credentials this environment holds are
 * wired up correctly: key present, LIVE vs TEST, actually authenticates, and
 * the webhook secret hash is set (without it, inbound webhooks are rejected and
 * live payments never confirm). Moves no money.
 */

import { Controller, Get, HttpCode, HttpStatus } from "@nestjs/common";
import { Role } from "@prisma/client";
import { Throttle } from "@nestjs/throttler";

import { Roles } from "../../common/decorators/roles.decorator";

import { FlutterwaveProcessor } from "./flutterwave.processor";

@Controller({ path: "admin/payments", version: "1" })
@Roles(Role.SUPER_ADMIN)
export class AdminPaymentsController {
  constructor(private readonly flutterwave: FlutterwaveProcessor) {}

  @Get("flutterwave/health")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  flutterwaveHealth() {
    return this.flutterwave.healthCheck();
  }
}
