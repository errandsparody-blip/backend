import { Module } from "@nestjs/common";

import { IdempotencyModule } from "../../common/idempotency.module";
import { AuditModule } from "../audit/audit.module";
import { EmailModule } from "../email/email.module";
import { NotificationModule } from "../notifications/notification.module";
import { VendorModule } from "../vendors/vendor.module";

import { AdminAuditController } from "./admin-audit.controller";
import { AdminConfigController } from "./admin-config.controller";
import { AdminDashboardController } from "./admin-dashboard.controller";
import { AdminFinanceController } from "./admin-finance.controller";
import { AdminSkuController } from "./admin-sku.controller";
import { AdminSkuService } from "./admin-sku.service";
import { AdminVendorController } from "./admin-vendor.controller";
import { AdminVendorService } from "./admin-vendor.service";

@Module({
  // VendorModule exports AgreementService, which AdminConfigController uses
  // to invalidate the cached agreement_version after a write.
  // IdempotencyModule is exported by the common module — needed because
  // SKU adjustments are idempotent.
  imports: [AuditModule, EmailModule, NotificationModule, VendorModule, IdempotencyModule],
  controllers: [
    AdminDashboardController,
    AdminFinanceController,
    AdminVendorController,
    AdminAuditController,
    AdminConfigController,
    AdminSkuController,
  ],
  providers: [AdminVendorService, AdminSkuService],
})
export class AdminModule {}
