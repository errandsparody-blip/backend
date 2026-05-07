/**
 * Monthly storage billing — runs at 02:00 UTC on the 1st of each month.
 *
 * Per vendor:
 *   1. Aggregate active SKUs by storage tier.
 *   2. Compute storage liability from the seeded fee_schedule (PRD §6.3.2).
 *   3. Attempt atomic debit. Insufficient funds → vendor flips to STORAGE_OVERDUE.
 *   4. Audit-log the outcome.
 *
 * Implementation Plan §5.5, §6.3.2, §14.5.
 */

import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import type { StorageTier } from "@prisma/client";

import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../audit/audit.service";
import { WalletService } from "../wallet/wallet.service";

interface FeeSchedule {
  monthlyStorage: Record<StorageTier, number | null>;
}

@Injectable()
export class StorageBillingJob {
  private readonly logger = new Logger(StorageBillingJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly audit: AuditService,
  ) {}

  /** 02:00 UTC on the 1st of every month. */
  @Cron("0 2 1 * *", { name: "storage-billing", timeZone: "UTC" })
  async run(): Promise<void> {
    this.logger.log("Monthly storage billing starting");
    const schedule = await this.loadSchedule();
    const vendors = await this.prisma.vendor.findMany({
      where: { status: { in: ["ACTIVE", "PENDING_KYC"] } },
      select: { id: true },
    });

    let billed = 0;
    let overdue = 0;
    let skipped = 0;

    for (const v of vendors) {
      const liability = await this.computeVendorLiability(v.id, schedule);
      if (liability === 0) {
        skipped++;
        continue;
      }
      try {
        await this.wallet.debit({
          vendorId: v.id,
          amountCents: liability,
          type: "STORAGE",
          description: `Monthly storage — ${new Date().toISOString().slice(0, 7)}`,
        });
        billed++;
      } catch (err) {
        // Insufficient funds → flip to STORAGE_OVERDUE; do NOT debit (no negatives).
        if ((err as { response?: { code?: string } }).response?.code === "insufficient_funds") {
          await this.prisma.wallet.update({
            where: { vendorId: v.id },
            data: { status: "STORAGE_OVERDUE" },
          });
          await this.audit.log({
            action: "wallet.storage_overdue",
            resourceType: "wallet",
            resourceId: v.id,
            afterState: { liabilityCents: liability },
          });
          overdue++;
        } else {
          this.logger.error({ err, vendorId: v.id }, "Storage billing threw — investigate");
        }
      }
    }

    this.logger.log({ billed, overdue, skipped, total: vendors.length }, "Monthly storage billing complete");
  }

  // ---------------------------------------------------------------------------

  private async computeVendorLiability(vendorId: string, schedule: FeeSchedule): Promise<number> {
    const groups = await this.prisma.sku.groupBy({
      by: ["storageTier"],
      where: { vendorId, status: "ACTIVE", quantityAvailable: { gt: 0 } },
      _count: { _all: true },
    });
    let totalCents = 0;
    for (const g of groups) {
      const per = schedule.monthlyStorage[g.storageTier];
      if (per === null || per === undefined) continue; // pallets are negotiated
      totalCents += per * g._count._all;
    }
    return totalCents;
  }

  private async loadSchedule(): Promise<FeeSchedule> {
    const row = await this.prisma.configuration.findUnique({ where: { key: "fee_schedule" } });
    if (!row) throw new Error("fee_schedule configuration is missing — run prisma:seed.");
    return row.value as unknown as FeeSchedule;
  }
}
