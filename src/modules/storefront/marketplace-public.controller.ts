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
  confirmPaymentSchema,
  crossVendorCheckoutSchema,
  crossVendorQuoteSchema,
  type ConfirmPaymentInput,
  type CrossVendorCheckoutInput,
  type CrossVendorQuoteInput,
} from "../../common/schemas/storefront-checkout.schema";
import {
  returnLookupSchema,
  returnRequestSchema,
  type ReturnLookupInput,
  type ReturnRequestInput,
} from "../../common/schemas/storefront-return.schema";

import { Logger } from "@nestjs/common";

import { PaymentProcessorRegistry } from "../payments/payment-processor.registry";

import { AddressAutocompleteService } from "./address-autocomplete.service";
import { StorefrontCheckoutService } from "./storefront-checkout.service";
import { StorefrontOrderService } from "./storefront-order.service";
import { StorefrontPublicService } from "./storefront-public.service";
import { StorefrontReturnService } from "./storefront-return.service";

@Controller({ path: "public/marketplace", version: "1" })
export class MarketplacePublicController {
  private readonly logger = new Logger(MarketplacePublicController.name);

  constructor(
    private readonly publicStore: StorefrontPublicService,
    private readonly checkout: StorefrontCheckoutService,
    private readonly returns: StorefrontReturnService,
    private readonly address: AddressAutocompleteService,
    private readonly registry: PaymentProcessorRegistry,
    private readonly orders: StorefrontOrderService,
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

  // Confirm payment from the return/redirect: verify the transaction directly
  // with the processor and mark the order paid (idempotent). This makes the
  // receipt email, vendor payout, and order status resilient to a delayed or
  // undelivered webhook — the webhook still wins if it arrives first, and this
  // path is a no-op ("already_processed") once the order is paid.
  @Public()
  @Post("confirm")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async confirm(
    @Body(new ZodValidationPipe(confirmPaymentSchema)) body: ConfirmPaymentInput,
  ): Promise<{ paid: boolean; reference: string | null }> {
    try {
      const event = await this.registry
        .get(body.processor)
        .verifyTransaction({ transactionId: body.transactionId, txRef: body.txRef });
      if (event.type !== "paid") return { paid: false, reference: null };
      const result = await this.orders.markPaidFromEvent(event);
      // handled === true (we flipped it) or already_processed (a prior webhook /
      // confirm did) both mean the order is paid.
      const paid = result.handled === true || result.reason === "already_processed";
      return { paid, reference: result.reference ?? event.reference ?? null };
    } catch (err) {
      this.logger.warn({ err: `${err}` }, "storefront.confirm.verify_failed");
      return { paid: false, reference: null };
    }
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

  // Address autocomplete (Google Places proxy — key stays server-side).
  @Public()
  @Get("address/autocomplete")
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async addressAutocomplete(
    @Query("q") q?: string,
    @Query("country") country?: string,
    @Query("session") session?: string,
  ) {
    const predictions = await this.address.suggest((q ?? "").trim(), (country ?? "US").trim(), session);
    return { predictions };
  }

  @Public()
  @Get("address/details")
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async addressDetails(@Query("placeId") placeId?: string, @Query("session") session?: string) {
    const address = await this.address.details((placeId ?? "").trim(), session);
    return { address };
  }
}
