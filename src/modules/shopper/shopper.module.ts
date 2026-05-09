/**
 * ShopperModule — Personal Shopper feature.
 *
 * Wires the three services that handle the public buyer flow:
 *   - ShopperRequestService  (the orchestrator: create/list/transition/reconcile)
 *   - ShopperMessageService  (chat thread between buyer + admin)
 *   - ShopperTokenService    (magic-link auth so buyers don't need User rows)
 *
 * Controllers + Stripe Checkout integration land in Phase 3 — this module
 * intentionally exports the services so the upcoming controller module can
 * import them without depending on internals.
 */

import { forwardRef, Module } from "@nestjs/common";

import { CryptoModule } from "../../common/crypto.module";
import { AuditModule } from "../audit/audit.module";
import { StripeModule } from "../integrations/stripe/stripe.module";

import { AdminShopperController } from "./admin-shopper.controller";
import { ShopperController } from "./shopper.controller";
import { ShopperMessageService } from "./shopper-message.service";
import { ShopperRequestService } from "./shopper-request.service";
import { ShopperTokenService } from "./shopper-token.service";

@Module({
  // EmailModule is @Global so EmailService is available without explicit import.
  // forwardRef on StripeModule — see the matching note in stripe.module.ts.
  imports: [AuditModule, CryptoModule, forwardRef(() => StripeModule)],
  controllers: [ShopperController, AdminShopperController],
  providers: [ShopperRequestService, ShopperMessageService, ShopperTokenService],
  exports: [ShopperRequestService, ShopperMessageService, ShopperTokenService],
})
export class ShopperModule {}
