/**
 * Storage billing — runs daily at 02:00 UTC.
 *
 * 30-day rolling cycle model: every SKU is billed once every 30 days,
 * anchored to the day it was received. The receiving fee paid at intake
 * covers the first 30 days, so SKUs received less than 30 days ago are
 * skipped on every daily run until their grace period ends.
 *
 * Per vendor:
 *   1. Find ACTIVE SKUs with stock whose `nextBillingDate` is on or
 *      before today (any SKU whose 30-day cycle has come due — may be
 *      zero, one, or many SKUs on any given day).
 *   2. Compute storage liability from the seeded fee_schedule.
 *   3. Inside a single transaction: debit the wallet AND advance each
 *      billed SKU's nextBillingDate forward by 30 days. Either both
 *      succeed or both roll back so a partial billing run never leaves
 *      the SKU dates ahead of the ledger.
 *   4. Audit-log the outcome.
 *
 * Insufficient funds → vendor is marked STORAGE_OVERDUE and SKU dates
 * do NOT advance, so the next successful debit covers the missed cycle.
 *
 * IMPORTANT: advancing on a per-SKU basis means each SKU's
 * nextBillingDate must be computed individually before the debit (each
 * SKU adds 30 days to its OWN current date, not to today). Otherwise a
 * SKU that missed yesterday's run and is now caught up today would
 * have its date set to today + 30 rather than its-prior-date + 30,
 * which would silently skip a cycle.
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

interface EligibleSku {
  id: string;
  storageTier: StorageTier;
  nextBillingDate: Date;
}

@Injectable()
export class StorageBillingJob {
  private readonly logger = new Logger(StorageBillingJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly audit: AuditService,
  ) {}

  /** 02:00 UTC every day. Each run only bills SKUs whose 30-day cycle has come due. */
  @Cron("0 2 * * *", { name: "storage-billing", timeZone: "UTC" })
  async run(): Promise<void> {
    this.logger.log("Daily storage billing starting");
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
      const { totalCents, eligibleSkus } = await this.computeVendorLiability(
        v.id,
        schedule,
        today,
      );
      if (totalCents === 0 || eligibleSkus.length === 0) {
        skipped++;
        continue;
      }
      try {
        // Atomic: debit wallet + advance each SKU's nextBillingDate
        // together. If either fails, both roll back. This prevents the
        // "skipped on retry" failure mode where the ledger has the
        // charge but the SKU dates weren't advanced (or vice versa).
        //
        // Each SKU is advanced from its OWN current date (not today),
        // so a SKU whose cycle was missed once and is now being caught
        // up still stays on its anchor; advance(prior_date) = prior + 30,
        // which is what we want.
        await this.prisma.$transaction(async (tx) => {
          await this.wallet.debit(
            {
              vendorId: v.id,
              amountCents: totalCents,
              type: "STORAGE",
              description: `Storage — ${today.toISOString().slice(0, 10)}`,
            },
            tx as unknown as Parameters<typeof this.wallet.debit>[1],
          );
          // Per-SKU update so each one advances from its own anchor.
          // updateMany with a single date would collapse them all to
          // the same future date — incorrect for any vendor whose SKUs
          // are on different cycles.
          for (const sku of eligibleSkus) {
            await tx.sku.update({
              where: { id: sku.id },
              data: { nextBillingDate: advanceBillingDate(sku.nextBillingDate) },
            });
          }
        });
        billed++;
      } catch (err) {
        // Insufficient funds → mark STORAGE_OVERDUE; do NOT debit
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

    this.logger.log({ billed, overdue, skipped, total: vendors.length }, "Daily storage billing complete");
  }

  // ---------------------------------------------------------------------------

  /**
   * Compute a vendor's storage liability for today's run AND collect
   * the SKUs that contributed, so the caller can atomically advance
   * their `nextBillingDate` after a successful debit.
   *
   * Eligibility filter: ACTIVE status, positive stock, AND
   * `nextBillingDate <= today`. The last clause is what makes the
   * 30-day cycle work — SKUs whose first 30-day cycle was prepaid at
   * intake carry a future date and are excluded until their grace
   * period ends.
   */
  private async computeVendorLiability(
    vendorId: string,
    schedule: FeeSchedule,
    today: Date,
  ): Promise<{ totalCents: number; eligibleSkus: EligibleSku[] }> {
    const where: Prisma.SkuWhereInput = {
      vendorId,
      status: "ACTIVE",
      quantityAvailable: { gt: 0 },
      nextBillingDate: { lte: today },
    };
    const eligible = await this.prisma.sku.findMany({
      where,
      select: { id: true, storageTier: true, nextBillingDate: true },
    });
    let totalCents = 0;
    const eligibleSkus: EligibleSku[] = [];
    for (const sku of eligible) {
      const per = schedule.monthlyStorage[sku.storageTier];
      if (per === null || per === undefined) continue; // pallets are negotiated
      totalCents += per;
      eligibleSkus.push(sku);
    }
    return { totalCents, eligibleSkus };
  }

  private async loadSchedule(): Promise<FeeSchedule> {
    const row = await this.prisma.configuration.findUnique({ where: { key: "fee_schedule" } });
    if (!row) throw new Error("fee_schedule configuration is missing — run prisma:seed.");
    return row.value as unknown as FeeSchedule;
  }
}
