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
      JOIN orders o ON o.id::text = le.reference_id
      WHERE le.type = 'FULFILLMENT' AND le.reference_type = 'order'
        AND o.processing_user_id = ${adminUserId}::uuid
        -- An order that was cancelled or returned had its fulfillment fee
        -- refunded, so it earns the admin nothing — exclude it. (Previously
        -- these still counted, inflating the pay.)
        AND o.status NOT IN ('CANCELLED', 'RETURNED')
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

    // Storage AND receiving income for the admin's assigned vendors. STORAGE
    // is country-tagged (0079); ONBOARDING (the receive/onboarding fee charged
    // when a PSN is received) is not, so we also count untagged onboarding
    // rows — scoped to this admin's assigned vendors, which keeps attribution
    // correct in the normal one-admin-per-vendor-per-country case. This is what
    // credits an admin for the PSNs they received (previously showed 0).
    const rows = await this.prisma.$queryRaw<Array<{ gross: bigint }>>(Prisma.sql`
      SELECT COALESCE(SUM(-le.amount_cents), 0)::bigint AS gross
      FROM ledger_entries le
      -- Join the PSN for PSN-referenced fees (onboarding / receiving-hold) so we
      -- can drop the ones whose PSN was rejected or cancelled — those fees were
      -- refunded and must not count toward the admin's pay. Recurring STORAGE
      -- rows don't reference a PSN (p.id IS NULL) and are kept: once a box has
      -- been billed for a period, that income is real even if it's later removed.
      LEFT JOIN psns p ON le.reference_type = 'psn' AND p.id::text = le.reference_id
      WHERE le.type::text IN ('STORAGE', 'ONBOARDING', 'RECEIVING_HOLD_FEE')
        AND (le.country = ${country} OR le.country IS NULL)
        AND le.vendor_id IN (
          SELECT vendor_id FROM vendor_admin_assignments
          WHERE admin_user_id = ${adminUserId}::uuid AND country = ${country}
        )
        AND (p.id IS NULL OR p.status NOT IN ('REJECTED', 'CANCELLED'))
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

  /**
   * Line-item reconciliation for an admin's earnings over [from, to). Returns
   * every charge that falls in the window with whether it was counted toward
   * pay and, if not, why (e.g. "Order cancelled — fee refunded"). This is the
   * transparency view behind a settlement number: it shows exactly which orders
   * / PSNs make up the total and which were excluded.
   */
  async breakdown(
    adminUserId: string,
    kind: "FULFILLMENT" | "STORAGE",
    from: Date,
    to: Date,
  ): Promise<{
    items: Array<{
      label: string;
      kind: string;
      amountCents: number;
      status: string | null;
      counted: boolean;
      reason: string | null;
    }>;
    includedCents: number;
    excludedCents: number;
  }> {
    const items: Array<{
      label: string;
      kind: string;
      amountCents: number;
      status: string | null;
      counted: boolean;
      reason: string | null;
    }> = [];

    if (kind === "FULFILLMENT") {
      const rows = await this.prisma.$queryRaw<
        Array<{ order_number: number; status: string; amount_cents: bigint }>
      >(Prisma.sql`
        SELECT o.order_number, o.status::text AS status, (-le.amount_cents)::bigint AS amount_cents
        FROM ledger_entries le
        JOIN orders o ON o.id::text = le.reference_id
        WHERE le.type = 'FULFILLMENT' AND le.reference_type = 'order'
          AND o.processing_user_id = ${adminUserId}::uuid
          AND le.created_at >= ${from} AND le.created_at < ${to}
        ORDER BY le.created_at DESC
      `);
      for (const r of rows) {
        const counted = r.status !== "CANCELLED" && r.status !== "RETURNED";
        items.push({
          label: `#${r.order_number}`,
          kind: "Fulfillment",
          amountCents: Number(r.amount_cents),
          status: r.status,
          counted,
          reason: counted ? null : `Order ${r.status.toLowerCase()} — fee refunded`,
        });
      }
    } else {
      const cRows = await this.prisma.$queryRaw<Array<{ admin_country: string | null }>>(
        Prisma.sql`SELECT admin_country FROM users WHERE id = ${adminUserId}::uuid`,
      );
      const country = cRows[0]?.admin_country
        ? toFulfillmentCountry(cRows[0].admin_country)
        : "US";
      const rows = await this.prisma.$queryRaw<
        Array<{
          kind: string;
          amount_cents: bigint;
          psn_status: string | null;
          psn_id: string | null;
        }>
      >(Prisma.sql`
        SELECT le.type::text AS kind, (-le.amount_cents)::bigint AS amount_cents,
               p.status::text AS psn_status, p.id AS psn_id
        FROM ledger_entries le
        LEFT JOIN psns p ON le.reference_type = 'psn' AND p.id::text = le.reference_id
        WHERE le.type::text IN ('STORAGE', 'ONBOARDING', 'RECEIVING_HOLD_FEE')
          AND (le.country = ${country} OR le.country IS NULL)
          AND le.vendor_id IN (
            SELECT vendor_id FROM vendor_admin_assignments
            WHERE admin_user_id = ${adminUserId}::uuid AND country = ${country}
          )
          AND le.created_at >= ${from} AND le.created_at < ${to}
        ORDER BY le.created_at DESC
      `);
      const kindLabel: Record<string, string> = {
        STORAGE: "Storage",
        ONBOARDING: "Receiving / onboarding",
        RECEIVING_HOLD_FEE: "Receiving hold",
      };
      for (const r of rows) {
        const rejected = r.psn_status === "REJECTED" || r.psn_status === "CANCELLED";
        const counted = !rejected;
        items.push({
          label: r.psn_id ? `PSN ${r.psn_id.slice(0, 8)}` : kindLabel[r.kind] ?? r.kind,
          kind: kindLabel[r.kind] ?? r.kind,
          amountCents: Number(r.amount_cents),
          status: r.psn_status,
          counted,
          reason: counted
            ? null
            : `PSN ${(r.psn_status ?? "").toLowerCase()} — fee refunded`,
        });
      }
    }

    const includedCents = items.filter((i) => i.counted).reduce((s, i) => s + i.amountCents, 0);
    const excludedCents = items.filter((i) => !i.counted).reduce((s, i) => s + i.amountCents, 0);
    return { items, includedCents, excludedCents };
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
