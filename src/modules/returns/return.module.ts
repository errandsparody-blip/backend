import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { ShippoModule } from "../integrations/shippo/shippo.module";
import { WalletModule } from "../wallet/wallet.module";

import { AdminReturnController } from "./admin-return.controller";
import { ReturnController } from "./return.controller";
import { ReturnService } from "./return.service";

@Module({
  imports: [AuditModule, WalletModule, ShippoModule],
  controllers: [ReturnController, AdminReturnController],
  providers: [ReturnService],
  exports: [ReturnService],
})
export class ReturnModule {}
