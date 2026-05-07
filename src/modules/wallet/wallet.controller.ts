import { BadRequestException, Body, Controller, Get, Param, Patch, Query, UseGuards } from "@nestjs/common";
import { Role } from "@prisma/client";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { TenantGuard } from "../../common/guards/tenant.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { PrismaService } from "../../common/prisma.service";
import {
  listLedgerSchema,
  updateWalletSettingsSchema,
  type ListLedgerInput,
  type UpdateWalletSettingsInput,
} from "../../common/schemas/wallet.schema";
import { AuditService } from "../audit/audit.service";

import { LedgerService } from "./ledger.service";
import { WalletService } from "./wallet.service";

const MONTH_RE = /^\d{4}-\d{2}$/;

@Controller({ path: "wallet", version: "1" })
@Roles(Role.VENDOR, Role.VENDOR_SUB_USER)
@UseGuards(TenantGuard)
export class WalletController {
  constructor(
    private readonly wallet: WalletService,
    private readonly ledger: LedgerService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.wallet.get(user.vendorId!);
  }

  @Get("ledger")
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(listLedgerSchema)) q: ListLedgerInput,
  ) {
    return this.ledger.list(user.vendorId!, q);
  }

  @Get("statements/:month")
  async statement(
    @CurrentUser() user: AuthenticatedUser,
    @Param("month") month: string,
  ) {
    if (!MONTH_RE.test(month)) {
      throw new BadRequestException({ message: "month must be YYYY-MM", code: "month_invalid" });
    }
    return this.ledger.statement(user.vendorId!, month);
  }

  @Patch()
  async updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(updateWalletSettingsSchema)) body: UpdateWalletSettingsInput,
  ) {
    const before = await this.prisma.wallet.findUnique({ where: { vendorId: user.vendorId! } });
    const updated = await this.prisma.wallet.update({
      where: { vendorId: user.vendorId! },
      data: { lowBalanceThresholdCents: body.lowBalanceThresholdCents },
    });
    await this.audit.log({
      actorId: user.sub,
      action: "wallet.settings_updated",
      resourceType: "wallet",
      resourceId: updated.id,
      beforeState: { lowBalanceThresholdCents: before?.lowBalanceThresholdCents ?? null },
      afterState: { lowBalanceThresholdCents: updated.lowBalanceThresholdCents },
    });
    return this.wallet.get(user.vendorId!);
  }
}
