import { Module } from "@nestjs/common";

import { IdempotencyModule } from "../../common/idempotency.module";
import { AuditModule } from "../audit/audit.module";
import { EasyPostModule } from "../integrations/easypost/easypost.module";
import { SmartyModule } from "../integrations/smarty/smarty.module";
import { WalletModule } from "../wallet/wallet.module";

import { AdminOrderController } from "./admin-order.controller";
import { AdminOrderService } from "./admin-order.service";
import { OrderController } from "./order.controller";
import { OrderService } from "./order.service";

@Module({
  imports: [AuditModule, WalletModule, SmartyModule, EasyPostModule, IdempotencyModule],
  controllers: [OrderController, AdminOrderController],
  providers: [OrderService, AdminOrderService],
  exports: [OrderService, AdminOrderService],
})
export class OrderModule {}
