import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";

import { VendorController } from "./vendor.controller";
import { VendorService } from "./vendor.service";

@Module({
  imports: [AuditModule],
  controllers: [VendorController],
  providers: [VendorService],
  exports: [VendorService],
})
export class VendorModule {}
