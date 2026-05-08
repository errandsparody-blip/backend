/**
 * AdminSkuService — cross-vendor inventory reads + manual ADJUST write.
 *
 * Why this is admin-only:
 *   - The read API includes vendorId and business name on every row, which
 *     the vendor-scoped `SkuController` deliberately does not expose.
 *   - The ADJUST write changes ledger-relevant inventory state. Vendors
 *     never adjust their own inventory directly — they file PSNs and
 *     orders, and SKU counts move through those flows. Manual ADJUST is a
 *     compliance / forensic tool reserved for warehouse operators and
 *     finance.
 *
 * Append-only enforcement: every ADJUST writes one InventoryMovement
 * row. The movement is the legal record; the SKU row's
 * `quantityAvailable` is the materialised view. Reconciliation
 * (sum-of-deltas == current quantity) is verified nightly by the audit
 * cron — any divergence is alarmed.
 */

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Prisma } from "@prisma/client";

import { PrismaService } from "../../common/prisma.service";
import type {
  AdminAdjustSkuInput,
  AdminListMovementsInput,
  AdminListSkusInput,
} from "../../common/schemas/sku.schema";
import { AuditService } from "../audit/audit.service";

export interface AdminSkuRow {
  id: string;
  vendorId: string;
  vendorBusinessName: string;
  productId: string;
  productCode: string;
  productName: string;
  variant: string;
  quantityAvailable: number;
  quantityReserved: number;
  storageTier: string;
  warehouseLocation: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminMovementRow {
  id: string;
  type: string;
  deltaAvailable: number;
  deltaReserved: number;
  reason: string | null;
  referenceType: string | null;
  referenceId: string | null;
  actorId: string | null;
  createdAt: Date;
}

@Injectable()
export class AdminSkuService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Cross-vendor list
  // ---------------------------------------------------------------------------

  async list(
    input: AdminListSkusInput,
  ): Promise<{ items: AdminSkuRow[]; nextCursor: string | null }> {
    const where: Prisma.SkuWhereInput = {};
    if (input.status) where.status = input.status;
    if (input.productId) where.productId = input.productId;
    if (input.vendorId) where.vendorId = input.vendorId;
    if (input.storageTier) where.storageTier = input.storageTier;
    if (input.zeroOnly) {
      where.AND = [
        { quantityAvailable: { lte: 0 } },
        { quantityReserved: { lte: 0 } },
      ];
    }
    if (input.search) {
      where.OR = [
        { id: { contains: input.search, mode: "insensitive" } },
        { product: { name: { contains: input.search, mode: "insensitive" } } },
        { product: { code: { contains: input.search, mode: "insensitive" } } },
        { vendor: { businessName: { contains: input.search, mode: "insensitive" } } },
      ];
    }

    const items = await this.prisma.sku.findMany({
      where,
      take: input.limit + 1,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      include: {
        product: { select: { id: true, code: true, name: true } },
        vendor: { select: { id: true, businessName: true } },
      },
    });

    let nextCursor: string | null = null;
    if (items.length > input.limit) {
      const next = items.pop();
      nextCursor = next?.id ?? null;
    }

    return {
      items: items.map((s) => ({
        id: s.id,
        vendorId: s.vendorId,
        vendorBusinessName: s.vendor.businessName,
        productId: s.productId,
        productCode: s.product.code,
        productName: s.product.name,
        variant: s.variant,
        quantityAvailable: s.quantityAvailable,
        quantityReserved: s.quantityReserved,
        storageTier: s.storageTier,
        warehouseLocation: s.warehouseLocation,
        status: s.status,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      })),
      nextCursor,
    };
  }

  // ---------------------------------------------------------------------------
  // Detail (with movement history paginated separately)
  // ---------------------------------------------------------------------------

  async get(id: string): Promise<AdminSkuRow> {
    const sku = await this.prisma.sku.findUnique({
      where: { id },
      include: {
        product: { select: { id: true, code: true, name: true } },
        vendor: { select: { id: true, businessName: true } },
      },
    });
    if (!sku) throw new NotFoundException();
    return {
      id: sku.id,
      vendorId: sku.vendorId,
      vendorBusinessName: sku.vendor.businessName,
      productId: sku.productId,
      productCode: sku.product.code,
      productName: sku.product.name,
      variant: sku.variant,
      quantityAvailable: sku.quantityAvailable,
      quantityReserved: sku.quantityReserved,
      storageTier: sku.storageTier,
      warehouseLocation: sku.warehouseLocation,
      status: sku.status,
      createdAt: sku.createdAt,
      updatedAt: sku.updatedAt,
    };
  }

  async listMovements(
    skuId: string,
    input: AdminListMovementsInput,
  ): Promise<{ items: AdminMovementRow[]; nextCursor: string | null }> {
    const exists = await this.prisma.sku.findUnique({ where: { id: skuId }, select: { id: true } });
    if (!exists) throw new NotFoundException();

    const items = await this.prisma.inventoryMovement.findMany({
      where: { skuId },
      take: input.limit + 1,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    });

    let nextCursor: string | null = null;
    if (items.length > input.limit) {
      const next = items.pop();
      nextCursor = next?.id ?? null;
    }

    return {
      items: items.map((m) => ({
        id: m.id,
        type: m.type,
        deltaAvailable: m.deltaAvailable,
        deltaReserved: m.deltaReserved,
        reason: m.reason,
        referenceType: m.referenceType,
        referenceId: m.referenceId,
        actorId: m.actorId,
        createdAt: m.createdAt,
      })),
      nextCursor,
    };
  }

  // ---------------------------------------------------------------------------
  // Manual ADJUST
  // ---------------------------------------------------------------------------

  /**
   * Apply a signed adjustment to `quantityAvailable`. Reservation balance
   * is intentionally NOT touched here — adjustments are about the
   * available pool. Reservations move only through the order lifecycle
   * (RESERVE / RELEASE / SHIP).
   *
   * Atomicity: the SKU update + the InventoryMovement write run inside a
   * single transaction. If either fails, the other rolls back. The
   * append-only DB triggers on `inventory_movements` enforce the audit
   * trail at the privilege level.
   */
  async adjust(
    skuId: string,
    actorId: string,
    input: AdminAdjustSkuInput,
  ): Promise<AdminSkuRow> {
    const sku = await this.prisma.sku.findUnique({
      where: { id: skuId },
      select: {
        id: true,
        vendorId: true,
        quantityAvailable: true,
      },
    });
    if (!sku) throw new NotFoundException();

    const projected = sku.quantityAvailable + input.delta;
    if (projected < 0) {
      throw new BadRequestException({
        message: `Adjustment would drive quantity_available negative (current ${sku.quantityAvailable}, requested delta ${input.delta}).`,
        code: "sku_negative_quantity",
        currentQuantityAvailable: sku.quantityAvailable,
        requestedDelta: input.delta,
      });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.sku.update({
        where: { id: skuId },
        data: { quantityAvailable: { increment: input.delta } },
      });
      await tx.inventoryMovement.create({
        data: {
          vendorId: sku.vendorId,
          skuId,
          type: "ADJUST",
          deltaAvailable: input.delta,
          deltaReserved: 0,
          reason: input.note ? `${input.reason}: ${input.note}` : input.reason,
          referenceType: "manual_adjust",
          referenceId: null,
          actorId,
        },
      });
    });

    await this.audit.log({
      actorId,
      action: "sku.adjusted",
      resourceType: "sku",
      resourceId: skuId,
      beforeState: { quantityAvailable: sku.quantityAvailable },
      afterState: {
        quantityAvailable: projected,
        delta: input.delta,
        reason: input.reason,
        note: input.note ?? null,
      },
    });

    return this.get(skuId);
  }
}
