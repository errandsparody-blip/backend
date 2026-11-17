/**
 * TelemetryModule — vendor-facing client error logging. Exposes the authed
 * ingest endpoint (POST /v1/telemetry/client-error) and the SUPER_ADMIN read
 * endpoint (GET /v1/admin/client-errors). PrismaModule is global, so no extra
 * imports are needed.
 */

import { Module } from "@nestjs/common";

import { AdminClientErrorController } from "./admin-client-error.controller";
import { ClientErrorController } from "./client-error.controller";
import { ClientErrorService } from "./client-error.service";

@Module({
  controllers: [ClientErrorController, AdminClientErrorController],
  providers: [ClientErrorService],
  exports: [ClientErrorService],
})
export class TelemetryModule {}
