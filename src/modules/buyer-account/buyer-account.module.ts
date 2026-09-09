import { Module } from "@nestjs/common";

import { EmailModule } from "../email/email.module";
import { StorefrontModule } from "../storefront/storefront.module";

import { BuyerAccountController } from "./buyer-account.controller";
import { BuyerAccountService } from "./buyer-account.service";

// PrismaModule is @Global. EmailModule powers the magic-link email;
// StorefrontModule provides the return service for buyer return requests.
@Module({
  imports: [EmailModule, StorefrontModule],
  controllers: [BuyerAccountController],
  providers: [BuyerAccountService],
  exports: [BuyerAccountService],
})
export class BuyerAccountModule {}
