import { Module } from "@nestjs/common";

import { AuditModule } from "../../audit/audit.module";
import { WalletModule } from "../../wallet/wallet.module";

import { StripeDepositController } from "./stripe-deposit.controller";
import { StripeWebhookController } from "./stripe-webhook.controller";
import { StripeService } from "./stripe.service";

@Module({
  imports: [WalletModule, AuditModule],
  controllers: [StripeDepositController, StripeWebhookController],
  providers: [StripeService],
  exports: [StripeService],
})
export class StripeModule {}
