/**
 * Vendor-facing payout-account connection (Migration 0059).
 *
 *   GET  /v1/payments/accounts               — connected payout accounts + status
 *   POST /v1/payments/stripe/connect         — start Stripe Express onboarding
 *   POST /v1/payments/paystack/connect       — create a Paystack subaccount
 *   POST /v1/payments/:processor/refresh     — re-pull status from the processor
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { Role } from "@prisma/client";

import { loadConfig } from "../../common/config";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { TenantGuard } from "../../common/guards/tenant.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  connectPaystackSchema,
  processorParamSchema,
  type ConnectPaystackInput,
} from "../../common/schemas/payout.schema";

import { PayoutAccountService } from "./payout-account.service";

@Controller({ path: "payments", version: "1" })
@Roles(Role.VENDOR, Role.VENDOR_SUB_USER)
@UseGuards(TenantGuard)
export class PayoutAccountController {
  constructor(private readonly payouts: PayoutAccountService) {}

  @Get("accounts")
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.payouts.list(user.vendorId!);
  }

  @Get("paystack/banks")
  listPaystackBanks() {
    return this.payouts.listPaystackBanks();
  }

  @Post("stripe/connect")
  @HttpCode(HttpStatus.OK)
  connectStripe(@CurrentUser() user: AuthenticatedUser) {
    const web = loadConfig().WEB_PUBLIC_URL;
    return this.payouts.connectStripe(user.vendorId!, {
      // The payouts UI lives on the storefront settings page (app/(portal)/
      // storefront → /storefront), not /settings/payouts, which doesn't exist
      // and 404s on return from Stripe onboarding.
      returnUrl: `${web}/storefront?connected=stripe`,
      refreshUrl: `${web}/storefront?refresh=stripe`,
    });
  }

  @Post("paystack/connect")
  @HttpCode(HttpStatus.OK)
  connectPaystack(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(connectPaystackSchema)) body: ConnectPaystackInput,
  ) {
    return this.payouts.connectPaystack(user.vendorId!, body);
  }

  @Post(":processor/refresh")
  @HttpCode(HttpStatus.OK)
  refresh(
    @CurrentUser() user: AuthenticatedUser,
    @Param("processor") processor: string,
  ) {
    const key = processorParamSchema.parse(processor.toUpperCase());
    return this.payouts.refresh(user.vendorId!, key);
  }
}
