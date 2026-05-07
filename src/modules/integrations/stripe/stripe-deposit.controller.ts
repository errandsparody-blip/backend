/**
 * Vendor-facing endpoint: create a Stripe Payment Intent for a wallet deposit.
 *
 * The wallet credit happens in the WEBHOOK handler — never here. This call
 * just reserves an intent on Stripe's side and returns the client_secret for
 * Stripe Elements to confirm the card. Implementation Plan §14.2.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Role } from "@prisma/client";

import { CurrentUser } from "../../../common/decorators/current-user.decorator";
import { Roles } from "../../../common/decorators/roles.decorator";
import { TenantGuard } from "../../../common/guards/tenant.guard";
import type { AuthenticatedUser } from "../../../common/guards/jwt-auth.guard";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { fundStripeSchema, type FundStripeInput } from "../../../common/schemas/deposit.schema";

import { StripeService } from "./stripe.service";

@Controller({ path: "wallet/fund/stripe", version: "1" })
@Roles(Role.VENDOR, Role.VENDOR_SUB_USER)
@UseGuards(TenantGuard)
export class StripeDepositController {
  constructor(private readonly stripe: StripeService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async createDeposit(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(fundStripeSchema)) body: FundStripeInput,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
  ) {
    if (!idempotencyKey || idempotencyKey.length < 8) {
      // Stripe REQUIRES idempotency on PaymentIntent creation; we enforce it
      // at the gateway too so a missing header surfaces immediately.
      throw new BadRequestException({
        message: "Idempotency-Key header is required for wallet funding.",
        code: "idempotency_key_required",
      });
    }
    return this.stripe.createPaymentIntent({
      vendorId: user.vendorId!,
      netAmountCents: body.netAmountCents,
      idempotencyKey: `${user.vendorId}:${idempotencyKey}`,
    });
  }
}
