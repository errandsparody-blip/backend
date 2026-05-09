import { Module } from "@nestjs/common";

import { NotificationModule } from "../../notifications/notification.module";

import { EasyPostWebhookController } from "./easypost-webhook.controller";
import { EasyPostService } from "./easypost.service";

@Module({
  imports: [NotificationModule],
  controllers: [EasyPostWebhookController],
  providers: [EasyPostService],
  exports: [EasyPostService],
})
export class EasyPostModule {}
