import { Module } from "@nestjs/common";

import { AdminDiscountController } from "./admin-discount.controller";
import { DiscountController } from "./discount.controller";
import { DiscountService } from "./discount.service";

// PrismaModule is @Global. Exported so the storefront checkout can apply codes.
@Module({
  controllers: [DiscountController, AdminDiscountController],
  providers: [DiscountService],
  exports: [DiscountService],
})
export class DiscountsModule {}
