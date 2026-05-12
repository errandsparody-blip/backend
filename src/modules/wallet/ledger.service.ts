/**
 * LedgerService — vendor-scoped read API for the immutable ledger.
 * No write methods exist here. Writes go through WalletService only.
 */

import { Injectable } from "@nestjs/common";
import type { LedgerEntry, LedgerEntryType, Prisma } from "@prisma/client";

import { PrismaService } from "../../common/prisma.service";

export interface PublicLedgerEntry {
  id: string;
  type: LedgerEntryType;
  amountCents: number;
  balanceAfterCents: number;
  description: string;
  referenceType: string | null;
  referenceId: string | null;
  createdAt: Date;
}

export interface ListLedgerInput {
  type?: LedgerEntryType;
  cursor?: string;
  limit: number;
}

@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    vendorId: string,
    input: ListLedgerInput,
  ): Promise<{ items: PublicLedgerEntry[]; nextCursor: string | null }> {
    const where: Prisma.LedgerEntryWhereInput = { vendorId };
    if (input.type) where.type = input.type;

    const items = await this.prisma.ledgerEntry.findMany({
      where,
      take: input.limit + 1,
      orderBy: { createdAt: "desc" },
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    });
    let nextCursor: string | null = null;
    if (items.length > input.limit) {
      const next = items.pop();
      nextCursor = next?.id ?? null;
    }
    return { items: items.map((e) => this.toPublic(e)), nextCursor };
  }

  // ---------------------------------------------------------------------------
  // Monthly statement
  // ---------------------------------------------------------------------------

  /**
   * Build a closed-form monthly statement for the given vendor + month.
   *
   * `month` is YYYY-MM in UTC. The window is [first-of-month, first-of-next-month).
   * The opening balance is derived from the LAST entry strictly before the
   * window — every entry has `balance_after_cents` so this is one row read.
   * The closing balance is the LAST entry inside the window (or opening if
   * none). Sums per type are aggregated server-side.
   *
   * Vendor-scoped. Two-vendor IDOR is prevented by the WHERE filter.
   */
  async statement(vendorId: string, month: string): Promise<MonthlyStatement> {
    const m = /^(\d{4})-(\d{2})$/.exec(month);
    if (!m) throw new Error("month must be YYYY-MM");
    const year = Number(m[1]);
    const monthIdx = Number(m[2]) - 1; // 0-based
    if (monthIdx < 0 || monthIdx > 11) throw new Error("invalid month");
    const start = new Date(Date.UTC(year, monthIdx, 1, 0, 0, 0, 0));
    const end = new Date(Date.UTC(year, monthIdx + 1, 1, 0, 0, 0, 0));

    // Opening balance = last entry strictly before `start`. Falls back to 0
    // for a brand-new vendor.
    const before = await this.prisma.ledgerEntry.findFirst({
      where: { vendorId, createdAt: { lt: start } },
      orderBy: { createdAt: "desc" },
      select: { balanceAfterCents: true },
    });
    const openingCents = before?.balanceAfterCents ?? 0;

    const entries = await this.prisma.ledgerEntry.findMany({
      where: { vendorId, createdAt: { gte: start, lt: end } },
      orderBy: { createdAt: "asc" },
    });

    // Migration 0019 made balanceAfterCents nullable to support shopper-
    // side ledger rows (no wallet = no running balance). Vendor-scoped
    // queries never return those rows, but TS doesn't know that. Coerce
    // a stray null down to the opening balance so the statement still
    // makes arithmetic sense even if a backfill ever wrote a vendor row
    // with no snapshot.
    const closingCents =
      entries.length > 0
        ? entries[entries.length - 1]!.balanceAfterCents ?? openingCents
        : openingCents;

    // Per-type aggregates. Positive = credit, negative = charge.
    const byType: Record<string, { count: number; totalCents: number }> = {};
    let depositsCents = 0;
    let chargesCents = 0;
    let refundsCents = 0;
    for (const e of entries) {
      byType[e.type] ??= { count: 0, totalCents: 0 };
      byType[e.type]!.count++;
      byType[e.type]!.totalCents += e.amountCents;
      if (e.type === "REVERSAL") refundsCents += e.amountCents;
      else if (e.amountCents >= 0) depositsCents += e.amountCents;
      else chargesCents += e.amountCents;
    }

    return {
      month,
      windowStart: start.toISOString(),
      windowEnd: end.toISOString(),
      openingBalanceCents: openingCents,
      closingBalanceCents: closingCents,
      depositsCents,
      chargesCents,         // negative (cents charged)
      refundsCents,         // positive (cents refunded)
      entryCount: entries.length,
      byType,
      entries: entries.map((e) => this.toPublic(e)),
    };
  }

  private toPublic(e: LedgerEntry): PublicLedgerEntry {
    return {
      id: e.id,
      type: e.type,
      amountCents: e.amountCents,
      // Migration 0019 — column is nullable to support shopper-side
      // rows that have no wallet. The vendor-scoped queries above only
      // ever return vendor rows, which always carry a snapshot, but TS
      // can't see that — coerce null to 0 for the public shape.
      balanceAfterCents: e.balanceAfterCents ?? 0,
      description: e.description,
      referenceType: e.referenceType,
      referenceId: e.referenceId,
      createdAt: e.createdAt,
    };
  }
}

export interface MonthlyStatement {
  month: string;                  // YYYY-MM
  windowStart: string;            // ISO 8601 UTC
  windowEnd: string;              // ISO 8601 UTC, exclusive
  openingBalanceCents: number;
  closingBalanceCents: number;
  depositsCents: number;          // sum of positive non-REVERSAL
  chargesCents: number;           // sum of negative (will be ≤ 0)
  refundsCents: number;           // sum of REVERSAL (will be ≥ 0)
  entryCount: number;
  byType: Record<string, { count: number; totalCents: number }>;
  entries: PublicLedgerEntry[];
}
