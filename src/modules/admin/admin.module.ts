import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { EmailModule } from "../email/email.module";
import { NotificationModule } from "../notifications/notification.module";

import { AdminAuditController } from "./admin-audit.controller";
import { AdminConfigController } from "./admin-config.controller";
import { AdminDashboardController } from "./admin-dashboard.controller";
import { AdminFinanceController } from "./admin-finance.controller";
import { AdminVendorController } from "./admin-vendor.controller";
import { AdminVendorService } from "./admin-vendor.service";

@Module({
  imports: [AuditModule, EmailModule, NotificationModule],
  controllers: [
    AdminDashboardController,
    AdminFinanceController,
    AdminVendorController,
    AdminAuditController,
    AdminConfigController,
  ],
  providers: [AdminVendorService],
})
export class AdminModule {}
