import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";

import { ExportController } from "./export.controller";

@Module({
  imports: [AuditModule],
  controllers: [ExportController],
})
export class ExportModule {}
