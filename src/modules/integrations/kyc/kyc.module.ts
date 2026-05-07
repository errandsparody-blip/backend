import { Module } from "@nestjs/common";

import { AuditModule } from "../../audit/audit.module";
import { VendorModule } from "../../vendors/vendor.module";

import { KycController } from "./kyc.controller";
import { KycService } from "./kyc.service";

@Module({
  imports: [AuditModule, VendorModule],
  controllers: [KycController],
  providers: [KycService],
  exports: [KycService],
})
export class KycModule {}
