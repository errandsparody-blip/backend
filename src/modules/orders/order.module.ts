import { forwardRef, Module } from "@nestjs/common";

import { IdempotencyModule } from "../../common/idempotency.module";
import { AuditModule } from "../audit/audit.module";
import { ShippoModule } from "../integrations/shippo/shippo.module";
import { SmartyModule } from "../integrations/smarty/smarty.module";
import { ReturnModule } from "../returns/return.module";
import { WalletModule } from "../wallet/wallet.module";

import { AdminOrderController } from "./admin-order.controller";
import { AdminOrderService } from "./admin-order.service";
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
    forwardRef(() => ReturnModule),
  ],
  controllers: [OrderController, AdminOrderController],
  providers: [OrderService, AdminOrderService],
  exports: [OrderService, AdminOrderService],
})
export class OrderModule {}
