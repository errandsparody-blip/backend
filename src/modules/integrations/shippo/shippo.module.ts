import { Module } from "@nestjs/common";

import { NotificationModule } from "../../notifications/notification.module";

import { ShippoWebhookController } from "./shippo-webhook.controller";
import { ShippoService } from "./shippo.service";

@Module({
  imports: [NotificationModule],
  controllers: [ShippoWebhookController],
  providers: [ShippoService],
  exports: [ShippoService],
})
export class ShippoModule {}
