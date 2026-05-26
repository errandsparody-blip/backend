/**
 * Storage billing — runs daily at 02:00 UTC.
 *
 * Per-box 30-day rolling cycle (migration 0035). The billing unit is
 * the physical box, not the SKU. Every active StorageBox runs its own
 * 30-day cycle anchored to the day its PSN was received; the receiving
 * fee paid at intake covers the first 30 days, so a box is invisible
 * to the cron until day 30. After each successful debit the box's
 * `nextBillingDate` advances by exactly 30 days from its own current
 * value (not from today), so a box that missed a daily run still stays
 * on its true anchor.
 *
 * Per vendor:
 *   1. Find ACTIVE boxes whose `nextBillingDate <= today`.
 *   2. Compute storage liability — sum of monthly rates for each box's
 *      tier. Pallets carry a null rate (negotiated per quote) and are
 *      excluded from the dollar total but kept in the box list for
 *      visibility on the recurring-storage page.
 *   3. In a single transaction: debit the wallet AND advance each
 *      billed box's nextBillingDate. Either both succeed or both roll
 *      back — never leave the ledger and the box dates out of sync.
 *   4. Audit-log the outcome.
 *
 * Insufficient funds → vendor wallet is marked STORAGE_OVERDUE and box
 * dates do NOT advance. The next successful run catches up the missed
 * cycle automatically because advance(prior_date) = prior + 30.
 *
 * EMPTY and REMOVED boxes are skipped — those are the operator-flagged
 * states for empty / consolidated boxes that should no longer accrue
 * storage charges.
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

interface BillableBox {
  id: string;
  tier: StorageTier;
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

  /** 02:00 UTC every day. Bills any box whose 30-day cycle has come due. */
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
      const { totalCents, billableBoxes } = await this.computeVendorLiability(
        v.id,
        schedule,
        today,
      );
      if (totalCents === 0 || billableBoxes.length === 0) {
        skipped++;
        continue;
      }
      try {
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
          // Per-box update so each one advances from its OWN anchor.
          // updateMany with a single date would collapse them all to
          // the same future date — incorrect for any vendor whose
          // boxes are on different cycles. The N-update overhead is
          // small because the typical vendor has well under 100
          // active boxes due on any given day.
          for (const box of billableBoxes) {
            await tx.storageBox.update({
              where: { id: box.id },
              data: { nextBillingDate: advanceBillingDate(box.nextBillingDate) },
            });
          }
        });
        billed++;
      } catch (err) {
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
   * the boxes that contributed, so the caller can atomically advance
   * their `nextBillingDate` after a successful debit.
   *
   * Filter: status = ACTIVE AND nextBillingDate <= today. EMPTY and
   * REMOVED boxes are excluded.
   *
   * Pallets (rate = null) are skipped — they're priced per quote and
   * billed manually outside this cron path.
   */
  private async computeVendorLiability(
    vendorId: string,
    schedule: FeeSchedule,
    today: Date,
  ): Promise<{ totalCents: number; billableBoxes: BillableBox[] }> {
    const where: Prisma.StorageBoxWhereInput = {
      vendorId,
      status: "ACTIVE",
      nextBillingDate: { lte: today },
    };
    const eligible = await this.prisma.storageBox.findMany({
      where,
      select: { id: true, tier: true, nextBillingDate: true },
    });
    let totalCents = 0;
    const billableBoxes: BillableBox[] = [];
    for (const box of eligible) {
      const per = schedule.monthlyStorage[box.tier];
      if (per === null || per === undefined) continue; // pallets are negotiated
      totalCents += per;
      billableBoxes.push(box);
    }
    return { totalCents, billableBoxes };
  }

  private async loadSchedule(): Promise<FeeSchedule> {
    const row = await this.prisma.configuration.findUnique({ where: { key: "fee_schedule" } });
    if (!row) throw new Error("fee_schedule configuration is missing — run prisma:seed.");
    return row.value as unknown as FeeSchedule;
  }
}
