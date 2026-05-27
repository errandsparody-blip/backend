import { Module } from "@nestjs/common";

import { IdempotencyModule } from "../../common/idempotency.module";
import { AuditModule } from "../audit/audit.module";
import { EmailModule } from "../email/email.module";
import { NotificationModule } from "../notifications/notification.module";
import { ProductModule } from "../products/product.module";
import { VendorModule } from "../vendors/vendor.module";

import { AdminAuditController } from "./admin-audit.controller";
import { AdminConfigController } from "./admin-config.controller";
import { AdminDashboardController } from "./admin-dashboard.controller";
import { AdminFinanceController } from "./admin-finance.controller";
import { AdminProductController } from "./admin-product.controller";
import { AdminSkuController } from "./admin-sku.controller";
import { AdminSkuService } from "./admin-sku.service";
import { AdminStorageBoxController } from "./admin-storage-box.controller";
import { AdminVendorController } from "./admin-vendor.controller";
import { AdminVendorService } from "./admin-vendor.service";

@Module({
  // VendorModule exports AgreementService (used by AdminConfigController to
  // invalidate the cached agreement_version after a write) AND VendorService
  // (used by AdminVendorController to expose the per-vendor recurring-storage
  // breakdown to staff). ProductModule exports ProductService so the new
  // AdminProductController can call editAsAdmin / getByIdAsAdmin without
  // duplicating the persistence logic. IdempotencyModule is exported by the
  // common module — needed because SKU adjustments are idempotent.
  imports: [
    AuditModule,
    EmailModule,
    NotificationModule,
    VendorModule,
    ProductModule,
    IdempotencyModule,
  ],
  controllers: [
    AdminDashboardController,
    AdminFinanceController,
    AdminVendorController,
    AdminAuditController,
    AdminConfigController,
    AdminSkuController,
    // Migration 0035 — per-box consolidation endpoints. Hosted in its
    // own controller so the SUPER_ADMIN scoping is obvious from the
    // route file and rate-limited independently of vendor-detail
    // traffic.
    AdminStorageBoxController,
    // Admin override path for product details (warehouse-measured
    // weights / dimensions overriding the vendor's declared values).
    AdminProductController,
  ],
  providers: [AdminVendorService, AdminSkuService],
})
export class AdminModule {}
