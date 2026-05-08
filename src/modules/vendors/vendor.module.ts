import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";

import { AgreementService } from "./agreement.service";
import { VendorController } from "./vendor.controller";
import { VendorService } from "./vendor.service";

@Module({
  imports: [AuditModule],
  controllers: [VendorController],
  providers: [VendorService, AgreementService],
  exports: [VendorService, AgreementService],
})
export class VendorModule {}
