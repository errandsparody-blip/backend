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
import { NotificationService } from "../notifications/notification.service";

export interface AdminSkuRow {
  id: string;
  vendorId: string;
  vendorBusinessName: string;
  productId: string;
  productCode: string;
  productName: string;
  variant: string;
  /**
   * Locked product image URL (R2) for the parent product, or null if the
   * vendor never uploaded one. Surfaced to admin views so warehouse staff
   * can visually match incoming/outgoing stock against the cataloged
   * image without a separate lookup. Frozen at creation along with the
   * rest of the product fields — see ProductService.update().
   */
  productImageUrl: string | null;
  /**
   * True when the parent product has all three shipping dimensions (L×W×H) set.
   * When false, the marketplace has to estimate a box from weight, so shipping
   * quotes are less accurate — surfaced so an admin can backfill the dimensions.
   */
  dimensionsSet: boolean;
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
    private readonly notifications: NotificationService,
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
        // imageUrl was added in migration 0022. The generated client may
        // still be stale at typecheck time so we cast at the row-mapping
        // boundary below. Including it in the select keeps the query
        // shape narrow.
        product: {
          select: {
            id: true,
            code: true,
            name: true,
            imageUrl: true,
            lengthIn: true,
            widthIn: true,
            heightIn: true,
          } as unknown as { id: true; code: true; name: true },
        },
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
        productImageUrl:
          (s.product as unknown as { imageUrl?: string | null }).imageUrl ?? null,
        dimensionsSet: (() => {
          const p = s.product as unknown as {
            lengthIn?: number | null;
            widthIn?: number | null;
            heightIn?: number | null;
          };
          return p.lengthIn != null && p.widthIn != null && p.heightIn != null;
        })(),
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
        // imageUrl was added in migration 0022. The generated client may
        // still be stale at typecheck time so we cast at the row-mapping
        // boundary below. Including it in the select keeps the query
        // shape narrow.
        product: {
          select: {
            id: true,
            code: true,
            name: true,
            imageUrl: true,
            lengthIn: true,
            widthIn: true,
            heightIn: true,
          } as unknown as { id: true; code: true; name: true },
        },
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
      productImageUrl:
        (sku.product as unknown as { imageUrl?: string | null }).imageUrl ?? null,
      dimensionsSet: (() => {
        const p = sku.product as unknown as {
          lengthIn?: number | null;
          widthIn?: number | null;
          heightIn?: number | null;
        };
        return p.lengthIn != null && p.widthIn != null && p.heightIn != null;
      })(),
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

    const updated = await this.get(skuId);

    // Tell the vendor their stock was manually adjusted. Vendors never make
    // these adjustments themselves, so a silent change looks like a bug (or
    // worse) from their side — they must get a notice of what changed and
    // why. Best-effort: a notification hiccup must not fail the adjustment,
    // which is already committed above.
    await this.notifyVendorOfAdjustment(updated, sku.quantityAvailable, input);

    return updated;
  }

  /**
   * In-app + email notice to the vendor that an operator adjusted the
   * available count of one of their SKUs. Fires only when the count
   * actually moved (delta != 0). Never throws.
   */
  private async notifyVendorOfAdjustment(
    sku: AdminSkuRow,
    previousQuantity: number,
    input: AdminAdjustSkuInput,
  ): Promise<void> {
    try {
      if (input.delta === 0) return;

      const reasonText = input.note
        ? `${input.reason}: ${input.note}`
        : input.reason;
      const signedDelta = `${input.delta > 0 ? "+" : ""}${input.delta}`;
      const variantSuffix = sku.variant ? ` · ${sku.variant}` : "";
      const productLabel = `${sku.productName} (${sku.productCode}${variantSuffix})`;
      const direction = input.delta < 0 ? "reduced" : "increased";

      const body =
        `USA Errands ${direction} the available count of ${productLabel} ` +
        `from ${previousQuantity} to ${sku.quantityAvailable} (${signedDelta}). ` +
        `Reason: ${reasonText}.`;

      await this.notifications.emit({
        vendorId: sku.vendorId,
        type: "inventory.adjusted",
        // Reductions are the concerning case (stock removed) — flag amber.
        severity: input.delta < 0 ? "WARNING" : "INFO",
        title: "Inventory adjusted by USA Errands",
        body,
        href: "/inventory",
        email: {
          subject: `Inventory adjusted — ${sku.productCode}`,
          html:
            `<p>${body}</p>` +
            `<p>If this doesn't look right, reply to this email or contact support.</p>` +
            `<p><a href="https://myusaerrands.com/inventory">View your inventory</a></p>`,
          text:
            `${body}\n\nIf this doesn't look right, contact support.\n\n` +
            `View your inventory: https://myusaerrands.com/inventory`,
        },
      });
    } catch {
      // Swallow — the adjustment is committed; a failed notice is non-fatal.
    }
  }
}
