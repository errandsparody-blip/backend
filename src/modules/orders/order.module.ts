import { forwardRef, Module } from "@nestjs/common";

import { IdempotencyModule } from "../../common/idempotency.module";
import { AuditModule } from "../audit/audit.module";
import { IntegrationModule } from "../integration/integration.module";
import { ShippoModule } from "../integrations/shippo/shippo.module";
import { SmartyModule } from "../integrations/smarty/smarty.module";
import { NotificationModule } from "../notifications/notification.module";
import { ReturnModule } from "../returns/return.module";
import { WalletModule } from "../wallet/wallet.module";

import { AdminOrderController } from "./admin-order.controller";
import { AdminOrderService } from "./admin-order.service";
// Migration 0042 — Fulfillment v2 pack-step transition machine.
// Kept in its own file (SRP) but wired through OrderModule so it
// shares Prisma/Wallet/Shippo/Audit dependencies.
import { AdminOrderPackController } from "./admin-order-pack.controller";
// Migration 0046 — vendor CSV bulk-import service. Same module because
// it composes with OrderService (per-row create) and shares Prisma
// / audit dependencies.
import { OrderImportService } from "./order-import.service";
import { OrderPackService } from "./order-pack.service";
import { OrderController } from "./order.controller";
import { OrderService } from "./order.service";

@Module({
  // forwardRef on ReturnModule because the return service queries
  // orders via Prisma; mirroring forwardRef here keeps the dep
  // graph safe even if a future return service grows an OrderService
  // dependency.
  imports: [
    AuditModule,
    WalletModule,
    SmartyModule,
    ShippoModule,
    IdempotencyModule,
    // NotificationModule exposes OpsAlertService so the OrderService
    // can fan a "new order from vendor" notification to ops staff
    // (email + in-app) at create-time. Without this, admin had no
    // signal a vendor had placed an order — they had to refresh the
    // admin orders list to discover work.
    NotificationModule,
    IntegrationModule,
    forwardRef(() => ReturnModule),
  ],
  controllers: [OrderController, AdminOrderController, AdminOrderPackController],
  providers: [OrderService, AdminOrderService, OrderPackService, OrderImportService],
  exports: [OrderService, AdminOrderService, OrderPackService, OrderImportService],
})
export class OrderModule {}
