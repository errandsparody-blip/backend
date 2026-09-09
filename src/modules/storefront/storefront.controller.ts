/**
 * Vendor-facing storefront management (Migration 0059).
 *
 *   GET   /v1/storefront/settings                  — current storefront config
 *   PUT   /v1/storefront/settings                  — upsert presentation
 *   PUT   /v1/storefront/slug                       — set the store address (slug)
 *   POST  /v1/storefront/enable                     — go live (charges $50 once)
 *   POST  /v1/storefront/disable                    — take the store offline
 *   PUT   /v1/storefront/featured                   — toggle marketplace feature (free)
 *   PATCH /v1/storefront/products/:id/listing       — list/unlist + retail price
 *
 * Tenant-scoped: every action operates on the caller's own vendor.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import { Role } from "@prisma/client";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { TenantGuard } from "../../common/guards/tenant.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  addDomainSchema,
  setFeaturedSchema,
  setProductListingSchema,
  setSlugSchema,
  upsertStorefrontSettingsSchema,
  type AddDomainInput,
  type SetFeaturedInput,
  type SetProductListingInput,
  type SetSlugInput,
  type UpsertStorefrontSettingsInput,
} from "../../common/schemas/storefront.schema";

import { StorefrontOrderService } from "./storefront-order.service";
import { StorefrontService } from "./storefront.service";
import { VendorDomainService } from "./vendor-domain.service";

@Controller({ path: "storefront", version: "1" })
@Roles(Role.VENDOR, Role.VENDOR_SUB_USER)
@UseGuards(TenantGuard)
export class StorefrontController {
  constructor(
    private readonly storefront: StorefrontService,
    private readonly orders: StorefrontOrderService,
    private readonly domains: VendorDomainService,
  ) {}

  // -------- Custom domains (Phase 3) --------

  @Get("domains")
  listDomains(@CurrentUser() user: AuthenticatedUser) {
    return this.domains.listDomains(user.vendorId!);
  }

  @Post("domains")
  @HttpCode(HttpStatus.CREATED)
  addDomain(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(addDomainSchema)) body: AddDomainInput,
  ) {
    return this.domains.addDomain(user.vendorId!, body.host);
  }

  @Post("domains/:id/verify")
  @HttpCode(HttpStatus.OK)
  verifyDomain(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    return this.domains.verify(user.vendorId!, id);
  }

  @Delete("domains/:id")
  @HttpCode(HttpStatus.OK)
  async removeDomain(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    await this.domains.removeDomain(user.vendorId!, id);
    return { ok: true };
  }

  // -------- Orders (records kept in the vendor account) --------

  @Get("orders")
  listOrders(@CurrentUser() user: AuthenticatedUser) {
    return this.orders.listForVendor(user.vendorId!);
  }

  @Get("orders/:reference")
  getOrder(
    @CurrentUser() user: AuthenticatedUser,
    @Param("reference") reference: string,
  ) {
    return this.orders.getForVendor(user.vendorId!, reference);
  }

  @Get("settings")
  getSettings(@CurrentUser() user: AuthenticatedUser) {
    return this.storefront.getSettings(user.vendorId!);
  }

  @Get("products")
  listProducts(@CurrentUser() user: AuthenticatedUser) {
    return this.storefront.listVendorProducts(user.vendorId!);
  }

  @Put("settings")
  upsertSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(upsertStorefrontSettingsSchema))
    body: UpsertStorefrontSettingsInput,
  ) {
    return this.storefront.upsertSettings(user.vendorId!, body);
  }

  @Put("slug")
  setSlug(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(setSlugSchema)) body: SetSlugInput,
  ) {
    return this.storefront.setSlug(user.vendorId!, body.slug);
  }

  @Post("enable")
  @HttpCode(HttpStatus.OK)
  enable(@CurrentUser() user: AuthenticatedUser) {
    return this.storefront.enableStorefront(user.vendorId!, user.sub);
  }

  @Post("disable")
  @HttpCode(HttpStatus.OK)
  disable(@CurrentUser() user: AuthenticatedUser) {
    return this.storefront.disableStorefront(user.vendorId!);
  }

  @Put("featured")
  setFeatured(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(setFeaturedSchema)) body: SetFeaturedInput,
  ) {
    return this.storefront.setMarketplaceFeatured(user.vendorId!, body.featured);
  }

  @Patch("products/:id/listing")
  setProductListing(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(setProductListingSchema)) body: SetProductListingInput,
  ) {
    return this.storefront.setProductListing(user.vendorId!, id, body);
  }
}
