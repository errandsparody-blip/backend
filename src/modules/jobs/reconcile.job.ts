/**
 * Daily reconciliation job — proves that for every vendor the materialized
 * wallet.balance_cents equals the sum of their ledger_entries.
 *
 * Runs at 03:00 UTC every day. On a discrepancy, logs at ERROR and writes an
 * audit entry — the on-call gets paged via Sentry / BetterStack.
 *
 * Implementation Plan §6.4.2, §9.3 (ledger.reconcile).
 */

import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";

import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../audit/audit.service";
import { WalletService } from "../wallet/wallet.service";

@Injectable()
export class LedgerReconciliationJob {
  private readonly logger = new Logger(LedgerReconciliationJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly audit: AuditService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM, {
    name: "ledger-reconcile",
    timeZone: "UTC",
  })
  async run(): Promise<void> {
    this.logger.log("Ledger reconciliation starting");
    const vendors = await this.prisma.vendor.findMany({ select: { id: true } });
    const failures: Array<{ vendorId: string; materialized: number; ledger: number }> = [];

    for (const v of vendors) {
      try {
        const r = await this.wallet.reconcile(v.id);
        if (!r.ok) {
          failures.push({ vendorId: v.id, materialized: r.materialized, ledger: r.ledger });
          await this.audit.log({
            action: "wallet.reconciliation_failed",
            resourceType: "wallet",
            resourceId: v.id,
            afterState: { materialized: r.materialized, ledger: r.ledger, delta: r.materialized - r.ledger },
          });
        }
      } catch (err) {
        this.logger.error({ err, vendorId: v.id }, "Reconciliation threw — investigate");
      }
    }

    if (failures.length > 0) {
      this.logger.error({ count: failures.length, failures }, "Ledger reconciliation FOUND DISCREPANCIES");
    } else {
      this.logger.log({ vendors: vendors.length }, "Ledger reconciliation passed");
    }
  }
}
