/**
 * Monthly storage billing — runs at 02:00 UTC on the 1st of each month.
 *
 * Per vendor:
 *   1. Find ACTIVE SKUs with stock whose `nextBillingDate` is on or before
 *      today (eligible for this cycle). Migration 0034 — SKUs received in
 *      the immediately-prior month carry a future nextBillingDate because
 *      their first cron cycle was prepaid via the intake fee.
 *   2. Compute storage liability from the seeded fee_schedule.
 *   3. Inside a single transaction: debit the wallet + bump every billed
 *      SKU's nextBillingDate forward one month. Either both succeed or
 *      both roll back so a partial billing run never leaves the SKU
 *      dates ahead of the ledger.
 *   4. Audit-log the outcome.
 *
 * Insufficient funds → vendor flips to STORAGE_OVERDUE and SKU dates do
 * NOT advance (so the next successful debit covers the missed month).
 *
 * Implementation Plan §5.5, §6.3.2, §14.5.
 */

import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import type { Prisma, StorageTier } from "@prisma/client";

import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../audit/audit.service";
import { advanceBillingDate } from "../sku/sku.service";
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
    const today = new Date();
    const vendors = await this.prisma.vendor.findMany({
      where: { status: { in: ["ACTIVE", "PENDING_KYC"] } },
      select: { id: true },
    });

    let billed = 0;
    let overdue = 0;
    let skipped = 0;

    for (const v of vendors) {
      const { totalCents, eligibleSkuIds } = await this.computeVendorLiability(
        v.id,
        schedule,
        today,
      );
      if (totalCents === 0 || eligibleSkuIds.length === 0) {
        skipped++;
        continue;
      }
      try {
        // Atomic: debit wallet + bump nextBillingDate together. If either
        // fails, both roll back. This prevents the "skipped on retry"
        // failure mode where the ledger has the charge but the SKU dates
        // weren't advanced (or vice versa).
        const nextDate = advanceBillingDate(this.firstOfMonth(today));
        await this.prisma.$transaction(async (tx) => {
          await this.wallet.debit(
            {
              vendorId: v.id,
              amountCents: totalCents,
              type: "STORAGE",
              description: `Monthly storage — ${today.toISOString().slice(0, 7)}`,
            },
            tx as unknown as Parameters<typeof this.wallet.debit>[1],
          );
          await tx.sku.updateMany({
            where: { id: { in: eligibleSkuIds } },
            data: { nextBillingDate: nextDate },
          });
        });
        billed++;
      } catch (err) {
        // Insufficient funds → flip to STORAGE_OVERDUE; do NOT debit
        // (no negatives), do NOT advance SKU dates (so the missed
        // cycle gets caught up on the next successful run).
        if ((err as { response?: { code?: string } }).response?.code === "insufficient_funds") {
          await this.prisma.wallet.update({
            where: { vendorId: v.id },
            data: { status: "STORAGE_OVERDUE" },
          });
          await this.audit.log({
            action: "wallet.storage_overdue",
            resourceType: "wallet",
            resourceId: v.id,
            afterState: { liabilityCents: totalCents },
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

  /**
   * Compute a vendor's storage liability for `today`'s cron run AND
   * collect the SKU ids that contributed, so the caller can atomically
   * advance their `nextBillingDate` after a successful debit.
   *
   * Eligibility filter: ACTIVE status, positive stock, AND
   * `nextBillingDate <= today`. The last clause is what makes Model B
   * work — SKUs whose first cron cycle was prepaid at intake carry a
   * future date and are excluded from this run.
   */
  private async computeVendorLiability(
    vendorId: string,
    schedule: FeeSchedule,
    today: Date,
  ): Promise<{ totalCents: number; eligibleSkuIds: string[] }> {
    const where: Prisma.SkuWhereInput = {
      vendorId,
      status: "ACTIVE",
      quantityAvailable: { gt: 0 },
      nextBillingDate: { lte: today },
    };
    const eligible = await this.prisma.sku.findMany({
      where,
      select: { id: true, storageTier: true },
    });
    let totalCents = 0;
    const eligibleSkuIds: string[] = [];
    for (const sku of eligible) {
      const per = schedule.monthlyStorage[sku.storageTier];
      if (per === null || per === undefined) continue; // pallets are negotiated
      totalCents += per;
      eligibleSkuIds.push(sku.id);
    }
    return { totalCents, eligibleSkuIds };
  }

  /** UTC first-of-current-month, used as the anchor when advancing dates. */
  private firstOfMonth(d: Date): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  }

  private async loadSchedule(): Promise<FeeSchedule> {
    const row = await this.prisma.configuration.findUnique({ where: { key: "fee_schedule" } });
    if (!row) throw new Error("fee_schedule configuration is missing — run prisma:seed.");
    return row.value as unknown as FeeSchedule;
  }
}
