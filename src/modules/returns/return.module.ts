import { Module } from "@nestjs/common";

import { AdminScopeService } from "../../common/services/admin-scope.service";
import { AuditModule } from "../audit/audit.module";
import { WalletModule } from "../wallet/wallet.module";

import { AdminReturnController } from "./admin-return.controller";
import { ReturnController } from "./return.controller";
import { ReturnService } from "./return.service";

// Returns v2 no longer buys inbound labels (customers pay their own
// return shipping), so ShippoModule is no longer needed here.
@Module({
  imports: [AuditModule, WalletModule],
  controllers: [ReturnController, AdminReturnController],
  providers: [ReturnService, AdminScopeService],
  exports: [ReturnService],
})
export class ReturnModule {}
