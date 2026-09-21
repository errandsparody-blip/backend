/**
 * Public multi-vendor marketplace feed (Phase 2) — no auth.
 *
 *   GET  /v1/public/marketplace/products?category=   — mixed feed across stores
 *   GET  /v1/public/marketplace/categories           — categories across stores
 *   GET  /v1/public/marketplace/stores               — featured stores strip
 *   POST /v1/public/marketplace/returns/lookup        — find a cart's returnable orders
 *   POST /v1/public/marketplace/returns               — open returns + tracking
 */
import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";

import { Public } from "../../common/decorators/public.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  crossVendorCheckoutSchema,
  crossVendorQuoteSchema,
  type CrossVendorCheckoutInput,
  type CrossVendorQuoteInput,
} from "../../common/schemas/storefront-checkout.schema";
import {
  returnLookupSchema,
  returnRequestSchema,
  type ReturnLookupInput,
  type ReturnRequestInput,
} from "../../common/schemas/storefront-return.schema";

import { StorefrontCheckoutService } from "./storefront-checkout.service";
import { StorefrontPublicService } from "./storefront-public.service";
import { StorefrontReturnService } from "./storefront-return.service";

@Controller({ path: "public/marketplace", version: "1" })
export class MarketplacePublicController {
  constructor(
    private readonly publicStore: StorefrontPublicService,
    private readonly checkout: StorefrontCheckoutService,
    private readonly returns: StorefrontReturnService,
  ) {}

  @Public()
  @Get("products")
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  products(@Query("category") category?: string) {
    return this.publicStore.listMarketplaceProducts({ category: category?.trim() || undefined });
  }

  @Public()
  @Get("categories")
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  categories() {
    return this.publicStore.listMarketplaceCategories();
  }

  @Public()
  @Get("stores")
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  stores() {
    return this.publicStore.listFeaturedStores();
  }

  // Cross-vendor cart → ONE consolidated shipping quote for the whole cart.
  @Public()
  @Post("quote")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  quoteCart(
    @Body(new ZodValidationPipe(crossVendorQuoteSchema)) body: CrossVendorQuoteInput,
  ) {
    return this.checkout.quoteCrossVendor(body);
  }

  // Cross-vendor cart → one sub-order + payment per store, but shipping is
  // charged once for the whole cart (one shipment).
  @Public()
  @Post("checkout")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  checkoutCart(
    @Body(new ZodValidationPipe(crossVendorCheckoutSchema)) body: CrossVendorCheckoutInput,
  ) {
    return this.checkout.createCrossVendorOrder(body);
  }

  // Self-service returns: look up a cart's returnable orders by order # + email.
  @Public()
  @Post("returns/lookup")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  lookupReturn(@Body(new ZodValidationPipe(returnLookupSchema)) body: ReturnLookupInput) {
    return this.returns.lookupForBuyer(body.reference, body.email);
  }

  // Open returns on the selected sub-orders with the return tracking number.
  @Public()
  @Post("returns")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  requestReturn(@Body(new ZodValidationPipe(returnRequestSchema)) body: ReturnRequestInput) {
    return this.returns.requestCartReturn(body.email, body.references, body.reason, body.trackingNumber);
  }
}
