import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";

// Migration 0044 — barcode service is exported so AdminModule's
// AdminBarcodeController and OrderPackController can depend on it
// without needing to import Prisma directly.
import { BarcodeService } from "./barcode.service";
import { ProductController } from "./product.controller";
import { ProductService } from "./product.service";

@Module({
  imports: [AuditModule],
  controllers: [ProductController],
  providers: [ProductService, BarcodeService],
  exports: [ProductService, BarcodeService],
})
export class ProductModule {}
