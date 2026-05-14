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
  ForbiddenException,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
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
import { PrismaService } from "../../common/prisma.service";
import { adminCreditSchema, type AdminCreditInput } from "../../common/schemas/deposit.schema";

import { WalletService } from "./wallet.service";

/**
 * Aggregate daily ceiling per actor across all wallets. Insider-threat
 * mitigation (security audit H-2): the per-call cap on the schema is
 * generous ($500k) for routine ops, but unlimited daily volume is a
 * fraud risk. This cap forces a compromised or rogue admin to either
 * stay under the daily ceiling or trip an obvious audit signal.
 *
 * Tunable via the FINANCE_DAILY_CREDIT_CAP_CENTS env var if the
 * business legitimately needs a higher ceiling. Default $1,000,000 /
 * actor / 24 hours.
 */
const DEFAULT_DAILY_CAP_CENTS = 100_000_000;

@Controller({ path: "admin/wallets", version: "1" })
@Roles(Role.FINANCE_ADMIN, Role.SUPER_ADMIN)
export class AdminWalletController {
  private readonly logger = new Logger(AdminWalletController.name);

  constructor(
    private readonly wallet: WalletService,
    private readonly idempotency: IdempotencyService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Aggregate the actor's manual credits over the last 24 hours. Reads
   * the wallet_ledger table (the source of truth for what actually
   * moved) — not the audit log, so a compromised admin can't bypass
   * the cap by suppressing audit writes. Rolling window, not calendar
   * day, so the limit is consistent across timezones.
   */
  private async sumActorDailyCreditsCents(actorId: string): Promise<number> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    // `createdBy` is the actor column on ledger_entries (the original
    // wallet ledger model uses createdBy; the audit log uses actorId).
    const rows = await this.prisma.ledgerEntry.findMany({
      where: {
        createdBy: actorId,
        type: "MANUAL_CREDIT",
        createdAt: { gte: since },
      },
      select: { amountCents: true },
    });
    return rows.reduce((sum: number, r: { amountCents: number }) => sum + r.amountCents, 0);
  }

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

    // Security audit H-2 — enforce an aggregate daily ceiling per
    // actor. Per-call $500k is fine for routine ops; unlimited daily
    // volume is an insider-threat risk. Reading the ledger (not the
    // audit log) makes the check tamper-resistant. A SUPER_ADMIN
    // unblock path exists by adjusting the env var; alternatively a
    // second-approver workflow can be added later for amounts that
    // approach the cap.
    const capEnv = Number(process.env["FINANCE_DAILY_CREDIT_CAP_CENTS"]);
    const dailyCapCents = Number.isFinite(capEnv) && capEnv > 0
      ? Math.floor(capEnv)
      : DEFAULT_DAILY_CAP_CENTS;
    const todaySoFar = await this.sumActorDailyCreditsCents(actor.sub);
    if (todaySoFar + body.amountCents > dailyCapCents) {
      this.logger.warn(
        {
          actorId: actor.sub,
          vendorId,
          attemptedCents: body.amountCents,
          todaySoFarCents: todaySoFar,
          dailyCapCents,
        },
        "admin.wallet.credit_daily_cap_exceeded",
      );
      throw new ForbiddenException({
        message:
          "Daily credit ceiling reached. Wait 24 hours or have a SUPER_ADMIN raise the cap.",
        code: "finance_daily_limit_exceeded",
        attemptedCents: body.amountCents,
        todaySoFarCents: todaySoFar,
        dailyCapCents,
      });
    }

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
