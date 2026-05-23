/**
 * SkuService — vendor-scoped SKU read API + internal generation helper used
 * by the receiving workflow.
 *
 * SKU model: per (vendor, product, variant) combination. Each SKU bucket
 * tracks `quantity_available` and `quantity_reserved`. Receiving 100
 * fungible T-shirts into the same product+variant produces ONE SKU bucket
 * with quantity_available = 100, not 100 SKU rows.
 *
 * Format: UER-<vendor short>-<productCode>-<variant>
 *   vendor short = first 6 chars of vendor UUID, alphanumeric upper.
 *   variant     = sanitized to [A-Z0-9-], max 12 chars.
 *
 * Implementation Plan §6.1.
 */

import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Prisma, PrismaClient, Sku, SkuStatus, StorageTier } from "@prisma/client";

import { PrismaService } from "../../common/prisma.service";
import type { ListSkusInput } from "../../common/schemas/sku.schema";
import { AuditService } from "../audit/audit.service";

export interface PublicSku {
  id: string;
  productId: string;
  variant: string;
  quantityAvailable: number;
  quantityReserved: number;
  storageTier: StorageTier;
  warehouseLocation: string | null;
  status: SkuStatus;
  createdAt: Date;
  updatedAt: Date;
}

type Tx = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

@Injectable()
export class SkuService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Vendor-scoped reads
  // ---------------------------------------------------------------------------

  async list(
    vendorId: string,
    input: ListSkusInput,
  ): Promise<{ items: PublicSku[]; nextCursor: string | null }> {
    const where: Prisma.SkuWhereInput = { vendorId };
    if (input.status) where.status = input.status;
    if (input.productId) where.productId = input.productId;
    if (input.search) {
      where.OR = [
        { id: { contains: input.search, mode: "insensitive" } },
        { product: { name: { contains: input.search, mode: "insensitive" } } },
        { product: { code: { contains: input.search, mode: "insensitive" } } },
      ];
    }

    const items = await this.prisma.sku.findMany({
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
    return { items: items.map((s) => this.toPublic(s)), nextCursor };
  }

  async get(vendorId: string, id: string): Promise<PublicSku> {
    const sku = await this.prisma.sku.findFirst({ where: { id, vendorId } });
    if (!sku) throw new NotFoundException();
    return this.toPublic(sku);
  }

  // ---------------------------------------------------------------------------
  // Internal — used by the receiving workflow
  // ---------------------------------------------------------------------------

  /**
   * Find or create an SKU bucket for (vendorId, productId, variant). Increments
   * `quantity_available` by `qty` and writes an InventoryMovement of type
   * RECEIVE. Runs inside the caller's transaction.
   *
   * Returns the SKU id (may be a fresh row or an existing one).
   */
  async receiveIntoBucket(
    tx: Tx,
    args: {
      vendorId: string;
      productId: string;
      variant: string;
      qty: number;
      psnId: string;
      actorId: string;
      storageTier?: StorageTier;
    },
  ): Promise<string> {
    if (args.qty <= 0) {
      throw new ConflictException("Receive quantity must be positive.");
    }

    const product = await tx.product.findFirst({
      where: { id: args.productId, vendorId: args.vendorId },
    });
    if (!product) throw new NotFoundException("Product not found for this vendor.");

    const skuId = this.computeSkuId(args.vendorId, product.code, args.variant);

    // Upsert by id (deterministic). On insert, populate fields. On update,
    // increment quantity_available atomically.
    const existing = await tx.sku.findUnique({ where: { id: skuId } });
    if (!existing) {
      await tx.sku.create({
        data: {
          id: skuId,
          vendorId: args.vendorId,
          productId: args.productId,
          variant: args.variant,
          quantityAvailable: args.qty,
          quantityReserved: 0,
          storageTier: args.storageTier ?? "SMALL",
          // Migration 0034 — Model B: the first-month storage fee paid
          // at PSN submit covers this SKU's first cron cycle. Skip the
          // next cron run by setting nextBillingDate to the first of
          // the month AFTER receive. From then on the cron bills and
          // bumps the date forward one month at a time.
          nextBillingDate: computeFirstBillingDate(new Date()),
        },
      });
    } else {
      // Sanity: never allow cross-vendor reuse of an id.
      if (existing.vendorId !== args.vendorId) {
        throw new ConflictException("SKU id collision across vendors — this should never happen.");
      }
      await tx.sku.update({
        where: { id: skuId },
        data: { quantityAvailable: { increment: args.qty } },
      });
      // Top-up of an existing SKU bucket: we deliberately do NOT reset
      // nextBillingDate. The SKU's existing billing cadence continues
      // unchanged. The first-month-storage component of the intake fee
      // for the top-up is a known minor inequity (vendor pays it but
      // doesn't get a fresh first-cycle skip on this bucket). The fix
      // is a per-receive-event billing record rather than per-SKU,
      // which is V2 territory.
    }

    await tx.inventoryMovement.create({
      data: {
        vendorId: args.vendorId,
        skuId,
        type: "RECEIVE",
        deltaAvailable: args.qty,
        deltaReserved: 0,
        referenceType: "psn",
        referenceId: args.psnId,
        actorId: args.actorId,
      },
    });

    return skuId;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Deterministic SKU id. Same (vendor, product, variant) → same id, so
   * subsequent receiving events stack into the same bucket.
   */
  computeSkuId(vendorId: string, productCode: string, variant: string): string {
    const short = vendorId.replace(/-/g, "").slice(0, 6).toUpperCase();
    const code = productCode.replace(/[^A-Z0-9-]/gi, "").toUpperCase();
    const v = (variant || "STD").replace(/[^A-Z0-9-]/gi, "").toUpperCase().slice(0, 12);
    return `UER-${short}-${code}-${v}`;
  }

  private toPublic(s: Sku): PublicSku {
    return {
      id: s.id,
      productId: s.productId,
      variant: s.variant,
      quantityAvailable: s.quantityAvailable,
      quantityReserved: s.quantityReserved,
      storageTier: s.storageTier,
      warehouseLocation: s.warehouseLocation,
      status: s.status,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };
  }
}

/**
 * Migration 0034 — compute a new SKU's first billing date.
 *
 * Returns the first day of the month AFTER `receivedAt`'s month, in UTC.
 * The cron runs at 02:00 UTC on the 1st of each month — when it ticks
 * on that returned date, the SKU is eligible for its first storage
 * debit. The previous month's cron has already passed and is skipped,
 * which is the "first cycle included at intake" semantic.
 *
 * Example: receivedAt = 2026-05-25T14:30:00Z → returns 2026-07-01.
 * Example: receivedAt = 2026-05-01T00:01:00Z → returns 2026-07-01.
 * Example: receivedAt = 2026-12-31T23:59:00Z → returns 2027-02-01.
 *
 * Exported so the cron's "bump nextBillingDate forward one month" logic
 * and the unit tests can share the same date arithmetic without
 * duplicating month-rollover edge-case handling.
 */
export function computeFirstBillingDate(receivedAt: Date): Date {
  // First of receive month (UTC), then add two months → first of
  // month-after-next. Date.UTC clamps to a real calendar day so
  // December rolls into February of the following year cleanly.
  return new Date(Date.UTC(receivedAt.getUTCFullYear(), receivedAt.getUTCMonth() + 2, 1));
}

/**
 * Bump a SKU's next billing date forward by exactly one month, used by
 * the cron after a successful debit. Anchored to the first of the
 * month, in UTC. Mirrors computeFirstBillingDate's date arithmetic so
 * the two functions can't drift apart.
 */
export function advanceBillingDate(current: Date): Date {
  return new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 1));
}

