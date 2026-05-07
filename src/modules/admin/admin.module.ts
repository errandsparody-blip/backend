import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";

import { AdminAuditController } from "./admin-audit.controller";
import { AdminConfigController } from "./admin-config.controller";
import { AdminDashboardController } from "./admin-dashboard.controller";
import { AdminFinanceController } from "./admin-finance.controller";

@Module({
  imports: [AuditModule],
  controllers: [
    AdminDashboardController,
    AdminFinanceController,
    AdminAuditController,
    AdminConfigController,
  ],
})
export class AdminModule {}
