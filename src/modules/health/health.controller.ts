/**
 * Health endpoints — three probes, each with a distinct contract.
 *
 *   GET /v1/health/live   Liveness — process is alive. NO dependency checks.
 *                         Used by Railway / Kubernetes liveness probes. Must
 *                         remain fast and deterministic; a DB blip should NOT
 *                         restart the pod.
 *
 *   GET /v1/health/ready  Readiness — dependencies are reachable. Used by
 *                         orchestrators to decide whether to route traffic.
 *                         Returns 503 with body when a dep is down.
 *
 *   GET /v1/health        Aggregate — back-compat alias of /ready, also used
 *                         by status pages and the admin dashboard.
 *
 * All three are @Public() — health probes never carry auth.
 */

import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  ServiceUnavailableException,
} from "@nestjs/common";

import { Public } from "../../common/decorators/public.decorator";
import { PrismaService } from "../../common/prisma.service";

@Controller({ path: "health", version: "1" })
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get("live")
  @HttpCode(HttpStatus.OK)
  live(): { status: "ok" } {
    return { status: "ok" };
  }

  @Public()
  @Get("ready")
  async ready(): Promise<{ status: "ok"; deps: { db: "ok" } }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException({ status: "error", deps: { db: "error" } });
    }
    return { status: "ok", deps: { db: "ok" } };
  }

  @Public()
  @Get()
  async health(): Promise<{ status: "ok"; deps: { db: "ok" | "error" } }> {
    let db: "ok" | "error" = "ok";
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      db = "error";
    }
    return { status: "ok", deps: { db } };
  }
}
