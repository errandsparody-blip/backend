/**
 * EarningsService — USA + Canada admin payouts (Phases 7 & 8).
 *
 * Computes what an operational admin has earned and manages the settlement +
 * receipt lifecycle.
 *
 *   Fulfillment earnings (Phase 7): gross = fulfillment fees on orders the
 *   admin processed. Platform fee (default 6%) comes off gross; the processing
 *   fee then comes off the remainder; what's left is net payable. Both
 *   percentages are SUPER_ADMIN-editable and are snapshotted onto each
 *   settlement so past payouts never change when the rates change.
 *
 *   Storage earnings (Phase 8): admin receives 100% of storage collected for
 *   their assigned vendors. USA: no deduction. Canada: the processing fee only.
 *
 * Fee percentages live in the configuration table (basis points):
 *   admin_platform_fee_bps   (default 600 = 6%)
 *   admin_processing_fee_bps (default 0)
 *
 * Raw SQL for the 0083 table + aggregates (stale generated client).
 */

import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { PrismaService } from "../../common/prisma.service";
import { toFulfillmentCountry } from "../../common/fulfillment-country";
import { AuditService } from "../audit/audit.service";

const PLATFORM_KEY = "admin_platform_fee_bps";
const PROCESSING_KEY = "admin_processing_fee_bps";
const DEFAULT_PLATFORM_BPS = 600; // 6%
const DEFAULT_PROCESSING_BPS = 0;

export interface FeeSettings {
  platformBps: number;
  processingBps: number;
}

export interface EarningsBreakdown {
  grossCents: number;
  platformFeeCents: number;
  processingFeeCents: number;
  netCents: number;
  platformBps: number;
  processingBps: number;
}

@Injectable()
export class EarningsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // --- fee settings --------------------------------------------------------

  async getFeeSettings(): Promise<FeeSettings> {
    const [p, q] = await Promise.all([
      this.prisma.configuration.findUnique({ where: { key: PLATFORM_KEY } }),
      this.prisma.configuration.findUnique({ where: { key: PROCESSING_KEY } }),
    ]);
    return {
      platformBps: this.bps(p?.value, DEFAULT_PLATFORM_BPS),
      processingBps: this.bps(q?.value, DEFAULT_PROCESSING_BPS),
    };
  }

  async setFeeSettings(actorId: string, input: FeeSettings): Promise<FeeSettings> {
    const platformBps = this.clampBps(input.platformBps);
    const processingBps = this.clampBps(input.processingBps);
    await this.prisma.configuration.upsert({
      where: { key: PLATFORM_KEY },
      create: { key: PLATFORM_KEY, value: { bps: platformBps } },
      update: { value: { bps: platformBps } },
    });
    await this.prisma.configuration.upsert({
      where: { key: PROCESSING_KEY },
      create: { key: PROCESSING_KEY, value: { bps: processingBps } },
      update: { value: { bps: processingBps } },
    });
    await this.audit.log({
      actorId,
      action: "admin.fee_settings_set",
      resourceType: "configuration",
      resourceId: "admin_fees",
      afterState: { platformBps, processingBps },
    });
    return { platformBps, processingBps };
  }

  // --- earnings computation -----------------------------------------------

  /** Fulfillment earnings for an admin over [from, to). */
  async fulfillmentEarnings(adminUserId: string, from: Date, to: Date): Promise<EarningsBreakdown> {
    const rows = await this.prisma.$queryRaw<Array<{ gross: bigint }>>(Prisma.sql`
      SELECT COALESCE(SUM(-le.amount_cents), 0)::bigint AS gross
      FROM ledger_entries le
      JOIN orders o ON o.id = le.reference_id::uuid
      WHERE le.type = 'FULFILLMENT' AND le.reference_type = 'order'
        AND o.processing_user_id = ${adminUserId}::uuid
        AND le.created_at >= ${from} AND le.created_at < ${to}
    `);
    const gross = Number(rows[0]?.gross ?? 0);
    const { platformBps, processingBps } = await this.getFeeSettings();
    return this.applyFees(gross, platformBps, processingBps);
  }

  /** Storage earnings for an admin over [from, to). Country = the admin's scope. */
  async storageEarnings(adminUserId: string, from: Date, to: Date): Promise<EarningsBreakdown> {
    const cRows = await this.prisma.$queryRaw<Array<{ admin_country: string | null }>>(
      Prisma.sql`SELECT admin_country FROM users WHERE id = ${adminUserId}::uuid`,
    );
    const country = cRows[0]?.admin_country ? toFulfillmentCountry(cRows[0].admin_country) : "US";

    const rows = await this.prisma.$queryRaw<Array<{ gross: bigint }>>(Prisma.sql`
      SELECT COALESCE(SUM(-le.amount_cents), 0)::bigint AS gross
      FROM ledger_entries le
      WHERE le.type = 'STORAGE' AND le.country = ${country}
        AND le.vendor_id IN (
          SELECT vendor_id FROM vendor_admin_assignments
          WHERE admin_user_id = ${adminUserId}::uuid AND country = ${country}
        )
        AND le.created_at >= ${from} AND le.created_at < ${to}
    `);
    const gross = Number(rows[0]?.gross ?? 0);
    const { processingBps } = await this.getFeeSettings();
    // USA: 100%, no deduction. Canada: processing fee only. No platform fee on storage.
    if (country === "US") {
      return { grossCents: gross, platformFeeCents: 0, processingFeeCents: 0, netCents: gross, platformBps: 0, processingBps: 0 };
    }
    const processingFee = Math.round((gross * processingBps) / 10_000);
    return {
      grossCents: gross,
      platformFeeCents: 0,
      processingFeeCents: processingFee,
      netCents: gross - processingFee,
      platformBps: 0,
      processingBps,
    };
  }

  // --- settlements ---------------------------------------------------------

  async createSettlement(
    actorId: string,
    input: { adminUserId: string; kind: "FULFILLMENT" | "STORAGE"; from: Date; to: Date },
  ): Promise<{ id: string } & EarningsBreakdown> {
    const b =
      input.kind === "FULFILLMENT"
        ? await this.fulfillmentEarnings(input.adminUserId, input.from, input.to)
        : await this.storageEarnings(input.adminUserId, input.from, input.to);
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      INSERT INTO admin_settlements
        (admin_user_id, kind, period_start, period_end, gross_cents, platform_fee_cents,
         processing_fee_cents, net_cents, platform_fee_bps, processing_fee_bps, created_by_id)
      VALUES (${input.adminUserId}::uuid, ${input.kind}::"AdminSettlementKind",
              ${input.from}, ${input.to}, ${b.grossCents}, ${b.platformFeeCents},
              ${b.processingFeeCents}, ${b.netCents}, ${b.platformBps}, ${b.processingBps},
              ${actorId}::uuid)
      RETURNING id
    `);
    await this.audit.log({
      actorId,
      action: "admin.settlement_created",
      resourceType: "admin_settlement",
      resourceId: rows[0]!.id,
      afterState: { kind: input.kind, netCents: b.netCents },
    });
    return { id: rows[0]!.id, ...b };
  }

  async markPaid(
    actorId: string,
    id: string,
    input: { receiptUrl?: string; note?: string },
  ): Promise<void> {
    const found = await this.prisma.$queryRaw<Array<{ status: string }>>(
      Prisma.sql`SELECT status FROM admin_settlements WHERE id = ${id}::uuid`,
    );
    if (found.length === 0) throw new NotFoundException();
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE admin_settlements
      SET status = 'PAID_AWAITING', paid_at = CURRENT_TIMESTAMP,
          receipt_url = ${input.receiptUrl ?? null}, note = ${input.note ?? null},
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${id}::uuid
    `);
    await this.audit.log({
      actorId, action: "admin.settlement_paid", resourceType: "admin_settlement", resourceId: id,
    });
  }

  /** Admin confirms (or disputes) a settlement they own. */
  async respond(
    adminUserId: string,
    id: string,
    outcome: "CONFIRMED" | "DISPUTED",
    note?: string,
  ): Promise<void> {
    const rows = await this.prisma.$queryRaw<Array<{ admin_user_id: string; status: string }>>(
      Prisma.sql`SELECT admin_user_id, status FROM admin_settlements WHERE id = ${id}::uuid`,
    );
    const row = rows[0];
    if (!row) throw new NotFoundException();
    if (row.admin_user_id !== adminUserId) throw new ForbiddenException("Not your settlement.");
    if (row.status !== "PAID_AWAITING") {
      throw new BadRequestException("Only a paid-awaiting settlement can be confirmed or disputed.");
    }
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE admin_settlements
      SET status = ${outcome}::"AdminSettlementStatus",
          confirmed_at = ${outcome === "CONFIRMED" ? Prisma.sql`CURRENT_TIMESTAMP` : Prisma.sql`NULL`},
          note = COALESCE(${note ?? null}, note), updated_at = CURRENT_TIMESTAMP
      WHERE id = ${id}::uuid
    `);
    await this.audit.log({
      actorId: adminUserId,
      action: outcome === "CONFIRMED" ? "admin.settlement_confirmed" : "admin.settlement_disputed",
      resourceType: "admin_settlement",
      resourceId: id,
    });
  }

  async list(filter: { adminUserId?: string }): Promise<Array<Record<string, unknown>>> {
    const where = filter.adminUserId
      ? Prisma.sql`WHERE admin_user_id = ${filter.adminUserId}::uuid`
      : Prisma.sql``;
    return this.prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT s.id, s.admin_user_id, u.email AS admin_email, s.kind, s.period_start, s.period_end,
             s.gross_cents, s.platform_fee_cents, s.processing_fee_cents, s.net_cents,
             s.status, s.receipt_url, s.note, s.paid_at, s.confirmed_at, s.created_at
      FROM admin_settlements s
      JOIN users u ON u.id = s.admin_user_id
      ${where}
      ORDER BY s.created_at DESC
      LIMIT 200
    `);
  }

  // --- helpers -------------------------------------------------------------

  private applyFees(gross: number, platformBps: number, processingBps: number): EarningsBreakdown {
    const platformFee = Math.round((gross * platformBps) / 10_000);
    const afterPlatform = gross - platformFee;
    const processingFee = Math.round((afterPlatform * processingBps) / 10_000);
    return {
      grossCents: gross,
      platformFeeCents: platformFee,
      processingFeeCents: processingFee,
      netCents: afterPlatform - processingFee,
      platformBps,
      processingBps,
    };
  }

  private bps(raw: unknown, fallback: number): number {
    if (raw && typeof raw === "object" && "bps" in raw) {
      const v = (raw as { bps?: unknown }).bps;
      if (typeof v === "number" && v >= 0) return Math.min(10_000, Math.round(v));
    }
    return fallback;
  }
  private clampBps(v: number): number {
    return Math.max(0, Math.min(10_000, Math.round(v)));
  }
}
