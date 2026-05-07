import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";

import { AdminWalletController } from "./admin-wallet.controller";
import { LedgerService } from "./ledger.service";
import { WalletController } from "./wallet.controller";
import { WalletService } from "./wallet.service";

@Module({
  imports: [AuditModule],
  controllers: [WalletController, AdminWalletController],
  providers: [WalletService, LedgerService],
  exports: [WalletService, LedgerService],
})
export class WalletModule {}
