import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
// IntegrationModule exports IntegrationOrderService so creating/mapping a
// product can instantly release storefront orders held for UNMAPPED_SKU.
// No DI cycle: IntegrationModule does not import ProductModule.
import { IntegrationModule } from "../integration/integration.module";

// barcode service is exported so AdminModule's
// AdminBarcodeController and OrderPackController can depend on it
// without needing to import Prisma directly.
import { BarcodeService } from "./barcode.service";
import { ProductController } from "./product.controller";
import { ProductService } from "./product.service";

@Module({
  imports: [AuditModule, IntegrationModule],
  controllers: [ProductController],
  providers: [ProductService, BarcodeService],
  exports: [ProductService, BarcodeService],
})
export class ProductModule {}
