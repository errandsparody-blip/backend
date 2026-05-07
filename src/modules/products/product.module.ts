import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";

import { ProductController } from "./product.controller";
import { ProductService } from "./product.service";

@Module({
  imports: [AuditModule],
  controllers: [ProductController],
  providers: [ProductService],
  exports: [ProductService],
})
export class ProductModule {}
