import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { EasyPostModule } from "../integrations/easypost/easypost.module";
import { WalletModule } from "../wallet/wallet.module";

import { AdminReturnController } from "./admin-return.controller";
import { ReturnController } from "./return.controller";
import { ReturnService } from "./return.service";

@Module({
  imports: [AuditModule, WalletModule, EasyPostModule],
  controllers: [ReturnController, AdminReturnController],
  providers: [ReturnService],
  exports: [ReturnService],
})
export class ReturnModule {}
