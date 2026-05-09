import { Global, Module } from "@nestjs/common";

import { NotificationController } from "./notification.controller";
import { NotificationService } from "./notification.service";
import { OpsAlertService } from "./ops-alert.service";

@Global()
@Module({
  controllers: [NotificationController],
  providers: [NotificationService, OpsAlertService],
  exports: [NotificationService, OpsAlertService],
})
export class NotificationModule {}
