import { Module } from "@nestjs/common";

import { NotificationModule } from "../notifications/notification.module";
import { WalletModule } from "../wallet/wallet.module";

import { AdminReferralController } from "./admin-referral.controller";
import { ReferralController } from "./referral.controller";
import { ReferralService } from "./referral.service";

// PrismaModule is @Global, so PrismaService is available without importing.
// WalletModule + NotificationModule provide the services the reward flow uses.
@Module({
  imports: [WalletModule, NotificationModule],
  controllers: [ReferralController, AdminReferralController],
  providers: [ReferralService],
  exports: [ReferralService],
})
export class ReferralModule {}
