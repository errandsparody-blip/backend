import { Module } from "@nestjs/common";

import { IdempotencyModule } from "../../common/idempotency.module";
import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { EmailModule } from "../email/email.module";
import { NotificationModule } from "../notifications/notification.module";
import { ProductModule } from "../products/product.module";
import { VendorModule } from "../vendors/vendor.module";

import { AdminAuditController } from "./admin-audit.controller";
// Migration 0044 — barcode CRUD + lookup. BarcodeService is exported
// from ProductModule (already imported), so no additional imports.
import { AdminBarcodeController } from "./admin-barcode.controller";
// Migration 0045 — inventory-location CRUD + SKU assignment.
// InventoryLocationService is provided by the @Global()
// InventoryLocationModule wired at the app level, so no import here.
import { AdminInventoryLocationController } from "./admin-inventory-location.controller";
// Phase H — SUPER_ADMIN-only platform dashboard.
import { SuperAdminDashboardController } from "./super-admin-dashboard.controller";
import { SuperAdminDashboardService } from "./super-admin-dashboard.service";
import { AdminConfigController } from "./admin-config.controller";
// Migration 0043 — packaging library. Controller lives in the admin
// module; PackagingLibraryService is provided by the @Global()
// PackagingLibraryModule wired at the app level, so no explicit
// import here is needed.
import { AdminPackagingController } from "./admin-packaging.controller";
import { AdminDashboardController } from "./admin-dashboard.controller";
import { AdminFinanceController } from "./admin-finance.controller";
import { AdminProductController } from "./admin-product.controller";
import { AdminRolePermissionsController } from "./admin-role-permissions.controller";
import { AdminShippingPointRangesController } from "./admin-shipping-point-ranges.controller";
import { AdminSkuController } from "./admin-sku.controller";
import { AdminUsersController } from "./admin-users.controller";
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
    // Migration 0039 — AdminUsersController needs TokenService to
    // revoke a target user's active sessions when their role
    // changes. AuthModule exports TokenService, so importing the
    // module here brings it into DI scope.
    AuthModule,
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
    // Migration 0039 — SUPER_ADMIN reads / writes the ADMIN role's
    // page-permission overrides. PagePermissionService itself is
    // provided by the @Global() PagePermissionModule wired at the
    // app level, so no explicit import here is needed.
    AdminRolePermissionsController,
    // Migration 0039 — SUPER_ADMIN promotes/demotes admin users
    // (including granting the new ADMIN role to an existing
    // operator). Depends on TokenService via the AuthModule import
    // above to revoke sessions on role change.
    AdminUsersController,
    // Migration 0040 — SUPER_ADMIN edits the shipping-point range
    // table. ShippingPointService is @Global(), no import needed.
    AdminShippingPointRangesController,
    // Migration 0043 — packaging library CRUD (SUPER_ADMIN) plus a
    // pack-modal read endpoint (any admin who can read orders).
    AdminPackagingController,
    // Migration 0044 — product-barcode CRUD (SUPER_ADMIN) + a
    // lookup endpoint any admin can call (drives the pack scanner).
    AdminBarcodeController,
    // Migration 0045 — inventory-location catalog (SUPER_ADMIN
    // writes) + SKU assignment (any admin who writes orders).
    AdminInventoryLocationController,
    // Phase H — platform-wide SUPER_ADMIN dashboard (finance-sensitive
    // aggregates: revenue, wallet totals, warehouse KPIs).
    SuperAdminDashboardController,
  ],
  providers: [
    AdminVendorService,
    AdminSkuService,
    SuperAdminDashboardService,
  ],
})
export class AdminModule {}
