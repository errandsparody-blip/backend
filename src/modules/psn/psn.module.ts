import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { SkuModule } from "../sku/sku.module";
import { WalletModule } from "../wallet/wallet.module";

import { AdminPsnController } from "./admin-psn.controller";
import { AdminPsnService } from "./admin-psn.service";
import { PsnController } from "./psn.controller";
import { PsnMessageService } from "./psn-message.service";
import { PsnService } from "./psn.service";

@Module({
  imports: [AuditModule, SkuModule, WalletModule],
  controllers: [PsnController, AdminPsnController],
  providers: [PsnService, AdminPsnService, PsnMessageService],
  exports: [PsnService, AdminPsnService, PsnMessageService],
})
export class PsnModule {}
