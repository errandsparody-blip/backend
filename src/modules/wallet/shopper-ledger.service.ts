/**
 * ShopperLedgerService — write-side companion to LedgerService for shopper
 * requests.
 *
 * Background:
 *   - WalletService writes ledger rows for vendor wallet movements (with
 *     `vendorId` + `balanceAfterCents`).
 *   - Shopper requests pay through Stripe Checkout directly; there's no
 *     wallet involved. But the admin Finance page needs to see every dollar
 *     flow, including the items we bought, the commission we earned, and
 *     the shipping the buyer paid.
 *
 * Migration 0019 made `vendor_id` nullable + added `shopper_request_id`.
 * This service writes the post-payment rows for a shopper request:
 *
 *   1. PARTNERSHIP_ITEM_COST — what we'll spend buying the items for the
 *      buyer (cost of goods). Set at intake-paid using the estimated total;
 *      can be adjusted later when actuals come in.
 *
 *   2. PURCHASE_FEE — our commission / markup. This is platform revenue.
 *
 *   3. SHIPPING — what the buyer is paying for shipping. Recorded when the
 *      followup payment resolves OR when admin sets the actual shipping
 *      cost (whichever comes first).
 *
 * Idempotency: each row uses a deterministic `idempotency_key` so retries
 * of the Stripe webhook can't double-write. Pattern: `shopper:{requestId}:{type}`.
 *
 * The service is intentionally narrow — only the three transaction types
 * above. Refunds + cancellations flow through their own paths and land in
 * the same table via separate code paths (will land in Phase 3b.2 / Phase 2).
 */

import { Injectable, Logger } from "@nestjs/common";
import type { Prisma } from "@prisma/client";

import { PrismaService } from "../../common/prisma.service";

export interface ShopperLedgerWriteArgs {
  shopperRequestId: string;
  /** Human reference like "SHP-000042" for the row description. */
  reference: string;
  /** Snapshot at intake-paid time. Positive integer cents. */
  itemsCents: number;
  commissionCents: number;
  /** When the payment settled — used as the entry's `createdAt`. */
  occurredAt: Date;
}

export interface ShippingLedgerWriteArgs {
  shopperRequestId: string;
  reference: string;
  shippingCents: number;
  occurredAt: Date;
}

@Injectable()
export class ShopperLedgerService {
  private readonly log = new Logger(ShopperLedgerService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record the intake-paid moment as two ledger rows: items + commission.
   * Idempotent — replays from the Stripe webhook are no-ops.
   */
  async recordIntakePaid(args: ShopperLedgerWriteArgs): Promise<void> {
    const itemsKey = `shopper:${args.shopperRequestId}:PARTNERSHIP_ITEM_COST`;
    const commissionKey = `shopper:${args.shopperRequestId}:PURCHASE_FEE`;

    // Both rows in a single transaction so the pair is atomic — either
    // both land or neither does.
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.ledgerEntry.findMany({
        where: { idempotencyKey: { in: [itemsKey, commissionKey] } },
        select: { idempotencyKey: true },
      });
      const haveKeys = new Set(existing.map((e) => e.idempotencyKey));

      if (!haveKeys.has(itemsKey) && args.itemsCents > 0) {
        await tx.ledgerEntry.create({
          data: this.shopperRow({
            type: "PARTNERSHIP_ITEM_COST",
            shopperRequestId: args.shopperRequestId,
            amountCents: args.itemsCents,
            description: `Items purchased for ${args.reference}`,
            idempotencyKey: itemsKey,
            createdAt: args.occurredAt,
          }),
        });
      }

      if (!haveKeys.has(commissionKey) && args.commissionCents > 0) {
        await tx.ledgerEntry.create({
          data: this.shopperRow({
            type: "PURCHASE_FEE",
            shopperRequestId: args.shopperRequestId,
            amountCents: args.commissionCents,
            description: `Purchase fee for ${args.reference}`,
            idempotencyKey: commissionKey,
            createdAt: args.occurredAt,
          }),
        });
      }
    });
  }

  /**
   * Record the shipping charge for a shopper request. Called once per
   * request — when admin sets the actual shipping cost, OR when the
   * followup payment resolves with shipping included. Idempotent.
   */
  async recordShipping(args: ShippingLedgerWriteArgs): Promise<void> {
    if (args.shippingCents <= 0) return;
    const key = `shopper:${args.shopperRequestId}:SHIPPING`;
    const existing = await this.prisma.ledgerEntry.findFirst({
      where: { idempotencyKey: key },
      select: { id: true },
    });
    if (existing) return;

    await this.prisma.ledgerEntry.create({
      data: this.shopperRow({
        type: "SHIPPING",
        shopperRequestId: args.shopperRequestId,
        amountCents: args.shippingCents,
        description: `Shipping for ${args.reference}`,
        idempotencyKey: key,
        createdAt: args.occurredAt,
      }),
    });
  }

  // ---------------------------------------------------------------------------

  /**
   * Build the Prisma create payload for a shopper-side ledger row.
   *
   * Prisma client generation can't reach the network in our sandboxed dev
   * environment, so the generated types might be stale relative to the
   * schema (vendorId nullable, shopperRequestId added). The
   * `as unknown as Prisma.LedgerEntryUncheckedCreateInput` cast follows
   * the pattern used elsewhere (return.service.ts, shopper-request.service.ts).
   * At runtime the values are validated by the DB CHECK constraint added
   * in migration 0019.
   */
  private shopperRow(input: {
    type:
      | "PARTNERSHIP_ITEM_COST"
      | "PURCHASE_FEE"
      | "SHIPPING";
    shopperRequestId: string;
    amountCents: number;
    description: string;
    idempotencyKey: string;
    createdAt: Date;
  }): Prisma.LedgerEntryUncheckedCreateInput {
    return {
      ...({
        vendorId: null,
        shopperRequestId: input.shopperRequestId,
        type: input.type,
        amountCents: input.amountCents,
        balanceAfterCents: null,
        description: input.description,
        referenceType: "shopper_request",
        referenceId: input.shopperRequestId,
        idempotencyKey: input.idempotencyKey,
        createdAt: input.createdAt,
      } as Record<string, unknown>),
    } as unknown as Prisma.LedgerEntryUncheckedCreateInput;
  }
}
