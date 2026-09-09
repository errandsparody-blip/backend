/**
 * Optional buyer accounts (Migration 0060) — public, passwordless.
 *
 *   POST /v1/public/account/save           — save own details (no auth)
 *   POST /v1/public/account/request-link   — email a magic sign-in link
 *   POST /v1/public/account/verify         — exchange link token → session
 *   GET  /v1/public/account/me             — profile + order history (session)
 *   PUT  /v1/public/account/profile        — update profile (session)
 *
 * The session token is passed in the `x-buyer-session` header.
 */
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";

import { loadConfig } from "../../common/config";
import { Public } from "../../common/decorators/public.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  requestBuyerLinkSchema,
  requestReturnSchema,
  saveBuyerAccountSchema,
  updateBuyerProfileSchema,
  verifyBuyerLinkSchema,
  type RequestBuyerLinkInput,
  type RequestReturnInput,
  type SaveBuyerAccountInput,
  type UpdateBuyerProfileInput,
  type VerifyBuyerLinkInput,
} from "../../common/schemas/buyer-account.schema";
import { StorefrontReturnService } from "../storefront/storefront-return.service";

import { BuyerAccountService } from "./buyer-account.service";

@Controller({ path: "public/account", version: "1" })
export class BuyerAccountController {
  constructor(
    private readonly buyer: BuyerAccountService,
    private readonly returns: StorefrontReturnService,
  ) {}

  @Public()
  @Post("save")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  save(@Body(new ZodValidationPipe(saveBuyerAccountSchema)) body: SaveBuyerAccountInput) {
    return this.buyer.save(body);
  }

  @Public()
  @Post("request-link")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  requestLink(@Body(new ZodValidationPipe(requestBuyerLinkSchema)) body: RequestBuyerLinkInput) {
    const web = loadConfig().WEB_PUBLIC_URL;
    const linkBase = `${web}${body.redirectPath ?? "/account"}`;
    return this.buyer.requestLink(body.email, linkBase);
  }

  @Public()
  @Post("verify")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  verify(@Body(new ZodValidationPipe(verifyBuyerLinkSchema)) body: VerifyBuyerLinkInput) {
    return this.buyer.verify(body.token);
  }

  @Public()
  @Get("me")
  async me(@Headers("x-buyer-session") session: string | undefined) {
    const accountId = await this.buyer.resolveSession(session);
    return this.buyer.getMe(accountId);
  }

  @Public()
  @Put("profile")
  async updateProfile(
    @Headers("x-buyer-session") session: string | undefined,
    @Body(new ZodValidationPipe(updateBuyerProfileSchema)) body: UpdateBuyerProfileInput,
  ) {
    const accountId = await this.buyer.resolveSession(session);
    return this.buyer.updateProfile(accountId, body);
  }

  // Buyer requests a return on one of their own orders (session required).
  @Public()
  @Post("orders/:reference/return-request")
  @HttpCode(HttpStatus.OK)
  async requestReturn(
    @Headers("x-buyer-session") session: string | undefined,
    @Param("reference") reference: string,
    @Body(new ZodValidationPipe(requestReturnSchema)) body: RequestReturnInput,
  ) {
    const accountId = await this.buyer.resolveSession(session);
    const profile = await this.buyer.getProfile(accountId);
    return this.returns.requestReturn(profile.email, reference, body.reason);
  }
}
