import { Module } from "@nestjs/common";

import { EasyPostWebhookController } from "./easypost-webhook.controller";
import { EasyPostService } from "./easypost.service";

@Module({
  controllers: [EasyPostWebhookController],
  providers: [EasyPostService],
  exports: [EasyPostService],
})
export class EasyPostModule {}
