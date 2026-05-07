/**
 * Finance-admin endpoint for manual wallet credits — reconciling Wise /
 * Payoneer deposits, supporting refunds, and adjusting balances under
 * documented circumstances.
 *
 * Implementation Plan §6.5.2, §6.5.3, §11.2 (Admin — Finance).
 *
 * Every call is audit-logged with the actor, the reason, and the provider
 * reference (Wise transfer id, etc.). Two-reviewer policy applies on the code
 * path (Implementation Plan §17.1).
 */

import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from "@nestjs/common";
import { Role } from "@prisma/client";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { IdempotencyService } from "../../common/idempotency.service";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { adminCreditSchema, type AdminCreditInput } from "../../common/schemas/deposit.schema";

import { WalletService } from "./wallet.service";

@Controller({ path: "admin/wallets", version: "1" })
@Roles(Role.FINANCE_ADMIN, Role.SUPER_ADMIN)
export class AdminWalletController {
  constructor(
    private readonly wallet: WalletService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post(":vendorId/credit")
  @HttpCode(HttpStatus.OK)
  async creditVendor(
    @CurrentUser() actor: AuthenticatedUser,
    @Param("vendorId", new ParseUUIDPipe()) vendorId: string,
    @Body(new ZodValidationPipe(adminCreditSchema)) body: AdminCreditInput,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
  ) {
    if (!idempotencyKey || idempotencyKey.length < 8) {
      throw new BadRequestException({
        message: "Idempotency-Key header is required for finance operations.",
        code: "idempotency_key_required",
      });
    }

    const cached = await this.idempotency.lookup({
      key: idempotencyKey,
      endpoint: "POST /admin/wallets/:vendorId/credit",
      vendorId,
      body,
    });
    if (cached) return cached.body;

    const description = body.reference
      ? `${body.reason} · ${body.reference}`
      : body.reason;

    const result = await this.wallet.credit({
      vendorId,
      amountCents: body.amountCents,
      type: "MANUAL_CREDIT",
      description,
      referenceType: "manual",
      ...(body.reference ? { referenceId: body.reference } : {}),
      idempotencyKey,
      actorId: actor.sub,
    });

    const responseBody = {
      ledgerEntryId: result.entry.id,
      balanceAfterCents: result.balanceAfterCents,
      amountCents: body.amountCents,
    };

    await this.idempotency.commit({
      key: idempotencyKey,
      endpoint: "POST /admin/wallets/:vendorId/credit",
      vendorId,
      body,
      responseStatus: 200,
      responseBody,
    });

    return responseBody;
  }
}
