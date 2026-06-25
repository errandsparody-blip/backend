import { forwardRef, Module } from "@nestjs/common";

import { AuditModule } from "../../audit/audit.module";
import { IntegrationModule } from "../../integration/integration.module";
import { NotificationModule } from "../../notifications/notification.module";
import { ShopperModule } from "../../shopper/shopper.module";
import { WalletModule } from "../../wallet/wallet.module";

import { StripeDepositController } from "./stripe-deposit.controller";
import { StripeWebhookController } from "./stripe-webhook.controller";
import { StripeService } from "./stripe.service";

@Module({
  // forwardRef breaks the circular import: ShopperModule imports StripeModule
  // (to issue Checkout sessions from controllers) and StripeModule needs
  // ShopperRequestService here (to fulfil webhook events).
  imports: [
    WalletModule,
    AuditModule,
    NotificationModule,
    IntegrationModule,
    forwardRef(() => ShopperModule),
  ],
  controllers: [StripeDepositController, StripeWebhookController],
  providers: [StripeService],
  exports: [StripeService],
})
export class StripeModule {}
