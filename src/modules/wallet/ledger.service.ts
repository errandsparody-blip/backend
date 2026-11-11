/**
 * LedgerService — vendor-scoped read API for the immutable ledger.
 * No write methods exist here. Writes go through WalletService only.
 */

import { Injectable } from "@nestjs/common";
import type { LedgerEntry, LedgerEntryType, Prisma } from "@prisma/client";

import { formatOrderRef } from "../../common/order-ref";
import { PrismaService } from "../../common/prisma.service";

export interface PublicLedgerEntry {
  id: string;
  type: LedgerEntryType;
  amountCents: number;
  balanceAfterCents: number;
  description: string;
  referenceType: string | null;
  referenceId: string | null;
  /**
   * Human order reference (e.g. "#31356") for entries tagged to an order —
   * fulfillment and shipping charges especially. Resolved from referenceId at
   * read time so vendors can tell which order each charge was for; null for
   * deposits, manual credits, and any entry not tied to an order.
   */
  orderRef: string | null;
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
    const refs = await this.resolveOrderRefs(items);
    return { items: items.map((e) => this.toPublic(e, refs)), nextCursor };
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

    const refs = await this.resolveOrderRefs(entries);

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
      entries: entries.map((e) => this.toPublic(e, refs)),
    };
  }

  /**
   * Batch-resolve the human order reference for every order-tagged entry in
   * the set. One query, keyed by the order id already stored on each entry's
   * referenceId. Entries that aren't order-tagged (deposits, manual credits)
   * are simply absent from the map. Kept read-only — the stored ledger row is
   * never mutated; the ref is attached in the public shape only.
   */
  private async resolveOrderRefs(
    entries: Array<{ referenceType: string | null; referenceId: string | null }>,
  ): Promise<Map<string, string>> {
    const orderIds = Array.from(
      new Set(
        entries
          .filter((e) => e.referenceType === "order" && !!e.referenceId)
          .map((e) => e.referenceId as string),
      ),
    );
    if (orderIds.length === 0) return new Map();
    const orders = await this.prisma.order.findMany({
      where: { id: { in: orderIds } },
      select: { id: true, orderNumber: true },
    });
    const map = new Map<string, string>();
    for (const o of orders) map.set(o.id, formatOrderRef(o.orderNumber));
    return map;
  }

  private toPublic(e: LedgerEntry, refs?: Map<string, string>): PublicLedgerEntry {
    const orderRef =
      e.referenceType === "order" && e.referenceId
        ? refs?.get(e.referenceId) ?? null
        : null;
    // Surface the order number inline in the description too, so it's visible
    // wherever the raw description is shown (statement PDF/export, older web
    // builds) — not only where a client reads the structured orderRef field.
    // Idempotent: never double-appends if the ref is already present.
    const description =
      orderRef && !e.description.includes(orderRef)
        ? `${e.description} · Order ${orderRef}`
        : e.description;
    return {
      id: e.id,
      type: e.type,
      amountCents: e.amountCents,
      // column is nullable to support shopper-side
      // rows that have no wallet. The vendor-scoped queries above only
      // ever return vendor rows, which always carry a snapshot, but TS
      // can't see that — coerce null to 0 for the public shape.
      balanceAfterCents: e.balanceAfterCents ?? 0,
      description,
      referenceType: e.referenceType,
      referenceId: e.referenceId,
      orderRef,
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
