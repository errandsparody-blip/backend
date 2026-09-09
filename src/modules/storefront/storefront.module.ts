import { Module } from "@nestjs/common";

import { DiscountsModule } from "../discounts/discount.module";
import { EmailModule } from "../email/email.module";
import { ShippoModule } from "../integrations/shippo/shippo.module";
import { PaymentsModule } from "../payments/payments.module";
import { WalletModule } from "../wallet/wallet.module";

import { AdminMarketplaceConfigController } from "./admin-marketplace-config.controller";
import { AdminStorefrontOrderController } from "./admin-storefront-order.controller";
import { AdminStorefrontReturnController } from "./admin-storefront-return.controller";
import { MarketplacePublicController } from "./marketplace-public.controller";
import { StorefrontController } from "./storefront.controller";
import { StorefrontCheckoutService } from "./storefront-checkout.service";
import { StorefrontFulfillmentService } from "./storefront-fulfillment.service";
import { StorefrontOrderService } from "./storefront-order.service";
import { StorefrontPublicController } from "./storefront-public.controller";
import { StorefrontPublicService } from "./storefront-public.service";
import { StorefrontReturnService } from "./storefront-return.service";
import { StorefrontTaxService } from "./storefront-tax.service";
import { StorefrontWebhookController } from "./storefront-webhook.controller";
import { StorefrontService } from "./storefront.service";
import { VendorDomainService } from "./vendor-domain.service";

// PrismaModule is @Global. WalletModule → storefront setup fee; ShippoModule →
// live shipping estimate; PaymentsModule → split checkout + webhook verify.
@Module({
  imports: [WalletModule, ShippoModule, PaymentsModule, DiscountsModule, EmailModule],
  controllers: [
    StorefrontController,
    StorefrontPublicController,
    StorefrontWebhookController,
    AdminStorefrontOrderController,
    AdminStorefrontReturnController,
    AdminMarketplaceConfigController,
    MarketplacePublicController,
  ],
  providers: [
    StorefrontService,
    StorefrontPublicService,
    StorefrontCheckoutService,
    StorefrontFulfillmentService,
    StorefrontOrderService,
    StorefrontReturnService,
    StorefrontTaxService,
    VendorDomainService,
  ],
  exports: [
    StorefrontService,
    StorefrontPublicService,
    StorefrontCheckoutService,
    StorefrontFulfillmentService,
    StorefrontOrderService,
    StorefrontReturnService,
    StorefrontTaxService,
  ],
})
export class StorefrontModule {}
