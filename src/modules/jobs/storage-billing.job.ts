/**
 * Storage billing — runs daily at 02:00 UTC.
 *
 * Per-box 30-day rolling cycle. The billing unit is
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
import { Prisma, type StorageTier } from "@prisma/client";

import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../audit/audit.service";
import { NotificationService } from "../notifications/notification.service";
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
    private readonly notifications: NotificationService,
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
      // USA + Canada (0081): one entry per country with due boxes. Each is
      // debited and advanced on its own ledger line, so USA and Canada storage
      // are collected separately (brief §5). All-USA vendors behave exactly as
      // before — a single USA line.
      const buckets = await this.computeVendorLiability(v.id, schedule, today);
      if (buckets.length === 0) {
        skipped++;
        continue;
      }
      for (const { country, totalCents, billableBoxes } of buckets) {
      if (totalCents === 0 || billableBoxes.length === 0) {
        skipped++;
        continue;
      }
      const countryLabel = country === "CA" ? "Canada" : "USA";
      const monthLabel = today.toISOString().slice(0, 7); // YYYY-MM
      try {
        await this.prisma.$transaction(async (tx) => {
          await this.wallet.debit(
            {
              vendorId: v.id,
              amountCents: totalCents,
              type: "STORAGE",
              // Identifies country + billing month per brief §10.
              description: `${countryLabel} Storage — ${monthLabel}`,
              country,
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
          // The storage charge went through, so the vendor is current again.
          // Clear a prior STORAGE_OVERDUE flag (scoped to that status so we
          // never reactivate a SUSPENDED/CLOSED wallet).
          await tx.wallet.updateMany({
            where: { vendorId: v.id, status: "STORAGE_OVERDUE" },
            data: { status: "ACTIVE" },
          });
        });
        billed++;
      } catch (err) {
        if ((err as { response?: { code?: string } }).response?.code === "insufficient_funds") {
          // Flag overdue only from ACTIVE → never clobber SUSPENDED/CLOSED.
          // updateMany's count tells us whether this is a NEW overdue episode
          // (ACTIVE → STORAGE_OVERDUE just now) versus one that was already
          // flagged on a prior run — so we email the vendor exactly once per
          // episode instead of every night until they pay.
          const flipped = await this.prisma.wallet.updateMany({
            where: { vendorId: v.id, status: "ACTIVE" },
            data: { status: "STORAGE_OVERDUE" },
          });
          await this.audit.log({
            action: "wallet.storage_overdue",
            resourceType: "wallet",
            resourceId: v.id,
            afterState: { liabilityCents: totalCents, firstNotice: flipped.count > 0 },
          });
          if (flipped.count > 0) {
            const dollars = `$${(totalCents / 100).toFixed(2)}`;
            // Best-effort — a mail hiccup must never break the billing run.
            await this.notifications
              .emit({
                vendorId: v.id,
                type: "wallet.storage_overdue",
                severity: "WARNING",
                title: "Storage fee couldn't be charged",
                body: `We tried to charge your ${dollars} storage fee but your wallet balance was too low. Add funds and we'll collect it automatically on the next daily run — no need to do anything else.`,
                href: "/wallet",
                email: {
                  subject: `Action needed: your ${dollars} storage fee couldn't be charged`,
                  html:
                    `<p>Hi,</p>` +
                    `<p>We tried to charge your storage fee of <strong>${dollars}</strong>, but your USA Errands wallet balance was too low to cover it.</p>` +
                    `<p>Please add funds to your wallet. Once your balance can cover it, we'll charge the outstanding storage automatically on the next daily run — your billing cycle stays on schedule and nothing is skipped.</p>` +
                    `<p>Until then, your account will show as <strong>storage overdue</strong>.</p>` +
                    `<p><a href="https://www.myusaerrands.com/wallet">Add funds to your wallet →</a></p>`,
                  text:
                    `We tried to charge your storage fee of ${dollars}, but your USA Errands wallet balance was too low.\n\n` +
                    `Please add funds. Once your balance can cover it, we'll charge the outstanding storage automatically on the next daily run — your cycle stays on schedule.\n\n` +
                    `Until then, your account shows as storage overdue.\n\n` +
                    `Add funds: https://www.myusaerrands.com/wallet`,
                },
              })
              .catch(() => undefined);
          }
          overdue++;
        } else {
          this.logger.error({ err, vendorId: v.id }, "Storage billing threw — investigate");
        }
      }
      } // end per-country bucket loop
    }

    this.logger.log({ billed, overdue, skipped, total: vendors.length }, "Daily storage billing complete");
  }

  // ---------------------------------------------------------------------------

  /**
   * Compute a vendor's storage liability for today's run AND collect
   * the boxes that contributed, so the caller can atomically advance
   * their `nextBillingDate` after a successful debit.
   *
   * Filter: status = ACTIVE AND nextBillingDate IS NOT NULL AND
   * nextBillingDate <= today. EMPTY and REMOVED boxes are excluded;
   * so are ADD_TO_PALLET boxes (migration 0036 marks them with a null
   * nextBillingDate because the parent pallet bills for them).
   *
   * Pallets (rate = null) are skipped — they're priced per quote and
   * billed manually outside this cron path.
   */
  private async computeVendorLiability(
    vendorId: string,
    schedule: FeeSchedule,
    today: Date,
  ): Promise<{ totalCents: number; billableBoxes: BillableBox[]; country: string }[]> {
    // Prisma's `lte` operator never matches NULL values (SQL standard
    // NULL semantics — any comparison with NULL is UNKNOWN, never true).
    // That means bundled boxes (nextBillingDate = NULL after migration
    // 0036) are automatically excluded from this query without an extra
    // predicate, and the post-query null-guard in the loop below is a
    // belt-and-braces defence rather than the primary filter.
    const where: Prisma.StorageBoxWhereInput = {
      vendorId,
      status: "ACTIVE",
      nextBillingDate: { lte: today },
    };
    const eligible = await this.prisma.storageBox.findMany({
      where,
      // country added in 0081; select via cast-friendly plain select.
      select: { id: true, tier: true, nextBillingDate: true },
    });
    // Read country alongside — one extra lightweight raw query keyed by the
    // same ids avoids depending on the stale generated client's `country`.
    const ids = eligible.map((b) => b.id);
    const countryById = new Map<string, string>();
    if (ids.length > 0) {
      const crows = await this.prisma.$queryRaw<Array<{ id: string; country: string }>>(
        Prisma.sql`SELECT id, country FROM storage_boxes WHERE id IN (${Prisma.join(
          ids.map((id) => Prisma.sql`${id}::uuid`),
        )})`,
      );
      for (const r of crows) countryById.set(r.id, (r.country ?? "US").toUpperCase());
    }

    // USA + Canada (0081): group liability by country so each country is
    // billed on its own ledger line. Canada currently uses the same rate
    // schedule as USA until a Super Admin configures separate Canada rates.
    const byCountry = new Map<string, { totalCents: number; billableBoxes: BillableBox[] }>();
    for (const box of eligible) {
      // The query already excludes null dates, but the column type is
      // now Date | null after migration 0036, so we narrow explicitly.
      if (box.nextBillingDate === null) continue;
      const per = schedule.monthlyStorage[box.tier];
      if (per === null || per === undefined) continue; // pallets are negotiated
      const country = countryById.get(box.id) === "CA" ? "CA" : "US";
      const bucket = byCountry.get(country) ?? { totalCents: 0, billableBoxes: [] };
      bucket.totalCents += per;
      bucket.billableBoxes.push({
        id: box.id,
        tier: box.tier,
        nextBillingDate: box.nextBillingDate,
      });
      byCountry.set(country, bucket);
    }
    return Array.from(byCountry.entries()).map(([country, b]) => ({
      country,
      totalCents: b.totalCents,
      billableBoxes: b.billableBoxes,
    }));
  }

  private async loadSchedule(): Promise<FeeSchedule> {
    const row = await this.prisma.configuration.findUnique({ where: { key: "fee_schedule" } });
    if (!row) throw new Error("fee_schedule configuration is missing — run prisma:seed.");
    return row.value as unknown as FeeSchedule;
  }
}
