import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";

import { AdminWalletController } from "./admin-wallet.controller";
import { LedgerService } from "./ledger.service";
import { ShopperLedgerService } from "./shopper-ledger.service";
import { WalletController } from "./wallet.controller";
import { WalletService } from "./wallet.service";

@Module({
  imports: [AuditModule],
  controllers: [WalletController, AdminWalletController],
  providers: [WalletService, LedgerService, ShopperLedgerService],
  exports: [WalletService, LedgerService, ShopperLedgerService],
})
export class WalletModule {}
