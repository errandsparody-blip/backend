/**
 * Public storefront reads + checkout (Migration 0059) — no auth.
 *
 *   GET  /v1/public/storefront/:slug                   — resolve store header
 *   GET  /v1/public/storefront/:slug/products          — listed, in-stock catalog
 *   GET  /v1/public/storefront/:slug/products/:id      — product detail
 *   GET  /v1/public/storefront/:slug/listing/:id       — listing + size×colour variants
 *   GET  /v1/public/storefront/:slug/categories        — category list
 *   POST /v1/public/storefront/:slug/quote             — price cart + shipping
 *   POST /v1/public/storefront/:slug/checkout          — create order + open payment
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";

import { Public } from "../../common/decorators/public.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  validateDiscountSchema,
  type ValidateDiscountInput,
} from "../../common/schemas/discount.schema";
import {
  checkoutSchema,
  quoteSchema,
  type CheckoutInput,
  type QuoteInput,
} from "../../common/schemas/storefront-checkout.schema";

import { DiscountService } from "../discounts/discount.service";
import { StorefrontCheckoutService } from "./storefront-checkout.service";
import { StorefrontPublicService } from "./storefront-public.service";

@Controller({ path: "public/storefront", version: "1" })
export class StorefrontPublicController {
  constructor(
    private readonly publicStore: StorefrontPublicService,
    private readonly checkout: StorefrontCheckoutService,
    private readonly discounts: DiscountService,
  ) {}

  @Public()
  @Get(":slug")
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  resolve(@Param("slug") slug: string) {
    return this.publicStore.resolveBySlug(slug);
  }

  // Custom-domain resolver (Phase 3): host → { slug } for the web middleware.
  @Public()
  @Get("by-host/:host")
  @Throttle({ default: { limit: 240, ttl: 60_000 } })
  async byHost(@Param("host") host: string) {
    const slug = await this.publicStore.resolveHostToSlug(host);
    return { slug };
  }

  @Public()
  @Get(":slug/products")
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async products(@Param("slug") slug: string, @Query("category") category?: string) {
    const store = await this.publicStore.resolveBySlug(slug);
    return this.publicStore.listProducts(store.vendorId, {
      category: category?.trim() || undefined,
    });
  }

  @Public()
  @Get(":slug/categories")
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async categories(@Param("slug") slug: string) {
    const store = await this.publicStore.resolveBySlug(slug);
    return this.publicStore.listCategories(store.vendorId);
  }

  @Public()
  @Get(":slug/products/:id")
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async product(
    @Param("slug") slug: string,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    const store = await this.publicStore.resolveBySlug(slug);
    return this.publicStore.getProduct(store.vendorId, id);
  }

  // Full listing with size×colour variants. `:id` may be a product id OR a
  // variant_group_id. The product page uses this to render selectors + gallery.
  @Public()
  @Get(":slug/listing/:id")
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async listing(
    @Param("slug") slug: string,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    const store = await this.publicStore.resolveBySlug(slug);
    return this.publicStore.getListing(store.vendorId, id);
  }

  @Public()
  @Post(":slug/quote")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  quote(
    @Param("slug") slug: string,
    @Body(new ZodValidationPipe(quoteSchema)) body: QuoteInput,
  ) {
    return this.checkout.quote(slug, body);
  }

  @Public()
  @Post(":slug/discount/validate")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async validateDiscount(
    @Param("slug") slug: string,
    @Body(new ZodValidationPipe(validateDiscountSchema)) body: ValidateDiscountInput,
  ) {
    const store = await this.publicStore.resolveBySlug(slug);
    const res = await this.discounts.resolve(store.vendorId, body.code, body.subtotalCents);
    return res.ok
      ? { valid: true, code: res.code, discountCents: res.discountCents }
      : { valid: false, reason: res.reason };
  }

  @Public()
  @Post(":slug/checkout")
  @HttpCode(HttpStatus.OK)
  // Stricter — each call reserves stock + opens a payment session.
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  createOrder(
    @Param("slug") slug: string,
    @Body(new ZodValidationPipe(checkoutSchema)) body: CheckoutInput,
  ) {
    return this.checkout.createOrder(slug, body);
  }
}
