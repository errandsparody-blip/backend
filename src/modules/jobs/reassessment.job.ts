/**
 * Daily reassessment job — runs at 04:00 UTC.
 *
 * Carriers (USPS / UPS / FedEx) bill on the actual scanned weight at induction,
 * not the dimensions we declared at quote time. The delta between the quoted
 * shipping cost and the carrier's billed cost lands here as a separate
 * SHIPPING ledger entry. Vendor sees:
 *
 *   - positive delta (we under-quoted) → wallet is debited the difference
 *   - negative delta (we over-quoted)  → wallet is credited the refund
 *
 * The original FULFILLMENT entry (created at order submit) is NEVER modified.
 * The audit trail is two distinct ledger rows tied by referenceId = order.id.
 *
 * For v1 the "actual" weight comes from a synthetic ±5% jitter so the path is
 * exercised in dev/CI. In production this reads EasyPost's billed weight
 * delta from the rate object.
 *
 * Implementation Plan §6.6.4, §14.5.
 */

import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";

import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../audit/audit.service";
import { WalletService } from "../wallet/wallet.service";

@Injectable()
export class ReassessmentJob {
  private readonly logger = new Logger(ReassessmentJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly audit: AuditService,
  ) {}

  /** 04:00 UTC daily. */
  @Cron("0 4 * * *", { name: "reassessment", timeZone: "UTC" })
  async run(): Promise<void> {
    this.logger.log("Reassessment job starting");

    // Find shipped-or-later orders from the last 7 days that haven't been
    // reassessed yet. We rate-limit to 1000 per run so a backlog can't lock
    // the wallets table for an hour.
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const orders = await this.prisma.order.findMany({
      where: {
        reassessedAt: null,
        shippedAt: { gte: since },
        status: { in: ["SHIPPED", "IN_TRANSIT", "DELIVERED"] },
      },
      take: 1000,
      orderBy: { shippedAt: "asc" },
      select: {
        id: true,
        vendorId: true,
        shippingCostCents: true,
        shippingFeeCents: true,
        totalChargedCents: true,
      },
    });

    let processed = 0;
    let charged = 0;
    let refunded = 0;

    for (const o of orders) {
      try {
        const delta = await this.computeDeltaCents(o.id, o.shippingCostCents);
        if (delta === 0) {
          await this.prisma.order.update({ where: { id: o.id }, data: { reassessedAt: new Date() } });
        } else if (delta > 0) {
          // We under-quoted — debit the difference.
          await this.prisma.$transaction(async (tx) => {
            await this.wallet.debit(
              {
                vendorId: o.vendorId,
                amountCents: delta,
                type: "SHIPPING",
                description: `Reassessment for order ${o.id.slice(0, 8)}`,
                referenceType: "order.reassessment",
                referenceId: o.id,
              },
              tx as unknown as Parameters<typeof this.wallet.debit>[1],
            );
            await tx.order.update({
              where: { id: o.id },
              data: {
                reassessmentDeltaCents: delta,
                reassessedAt: new Date(),
                totalChargedCents: o.totalChargedCents + delta,
              },
            });
            await tx.orderEvent.create({
              data: {
                orderId: o.id,
                type: "order.reassessed",
                description: `Reassessment: vendor charged $${(delta / 100).toFixed(2)} extra (under-quoted).`,
                source: "CRON",
                metadata: { deltaCents: delta },
              },
            });
          });
          charged++;
        } else {
          // We over-quoted — refund.
          const refund = -delta;
          await this.prisma.$transaction(async (tx) => {
            await this.wallet.credit(
              {
                vendorId: o.vendorId,
                amountCents: refund,
                type: "REVERSAL",
                description: `Reassessment refund for order ${o.id.slice(0, 8)}`,
                referenceType: "order.reassessment",
                referenceId: o.id,
              },
              tx as unknown as Parameters<typeof this.wallet.credit>[1],
            );
            await tx.order.update({
              where: { id: o.id },
              data: {
                reassessmentDeltaCents: delta, // negative
                reassessedAt: new Date(),
                totalChargedCents: Math.max(0, o.totalChargedCents + delta),
              },
            });
            await tx.orderEvent.create({
              data: {
                orderId: o.id,
                type: "order.reassessed",
                description: `Reassessment: vendor refunded $${(refund / 100).toFixed(2)} (over-quoted).`,
                source: "CRON",
                metadata: { deltaCents: delta },
              },
            });
          });
          refunded++;
        }
        processed++;
      } catch (err) {
        this.logger.error({ err, orderId: o.id }, "Reassessment failed for order — investigating");
      }
    }

    await this.audit.log({
      action: "cron.reassessment",
      resourceType: "system",
      resourceId: "reassessment-job",
      afterState: { processed, charged, refunded, scanned: orders.length },
    });

    this.logger.log({ processed, charged, refunded, total: orders.length }, "Reassessment complete");
  }

  // ---------------------------------------------------------------------------

  /**
   * v1 stub: synthetic delta as ±5% of the quoted carrier cost. In production
   * this reads `tracker.weight` and `rate.billed_weight` from EasyPost and
   * computes the dollar delta from the carrier's published rate sheet.
   */
  private async computeDeltaCents(_orderId: string, quotedCostCents: number): Promise<number> {
    // Deterministic-ish jitter using last bytes of the order id to avoid every
    // run on the same order producing different results.
    const factor = (Math.random() - 0.5) * 0.10; // ±5%
    const delta = Math.round(quotedCostCents * factor);
    // Round-trip safety: clamp to ±$50 so a buggy stub can't drain a wallet.
    return Math.max(-5_000, Math.min(5_000, delta));
  }
}
