import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";

import { SkuController } from "./sku.controller";
import { SkuService } from "./sku.service";

@Module({
  imports: [AuditModule],
  controllers: [SkuController],
  providers: [SkuService],
  exports: [SkuService],
})
export class SkuModule {}
