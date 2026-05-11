/**
 * AdminOrderService — operator-side fulfillment workflow.
 *
 *   ALLOCATED        → purchaseLabel()  → LABEL_PURCHASED  (carrier label bought)
 *   LABEL_PURCHASED  → pick()           → PICKING
 *   PICKING          → pack()           → PACKED
 *   PACKED           → ship()           → SHIPPED          (handed to carrier)
 *
 * The forward-only state machine is enforced THREE places:
 *   - here (status check + ConflictException on bad transition)
 *   - the OrderService.cancel logic (refuses to cancel after LABEL_PURCHASED)
 *   - the DB trigger `enforce_order_status_transition` (defence in depth)
 *
 * Every transition writes an append-only OrderEvent + an AuditLogEntry.
 *
 * Implementation Plan §6.6, §14.4.
 */

import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { Order, OrderStatus, PrismaClient } from "@prisma/client";

import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../audit/audit.service";
import { orderShippedTemplate } from "../email/email-templates";
import { ShippoService } from "../integrations/shippo/shippo.service";
import { NotificationService } from "../notifications/notification.service";

type Tx = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

export interface AdminOrderListInput {
  status?: OrderStatus;
  /**
   * "queue" (default): ALLOCATED → PACKED only — the operator's working
   * set.
   * "all": no status filter, show every order so post-shipment lookups
   * and history queries work.
   */
  view?: "queue" | "all";
  cursor?: string | undefined;
  limit: number;
}

const ALLOWED_TRANSITIONS: Record<string, OrderStatus[]> = {
  purchaseLabel: ["ALLOCATED"],
  pick: ["LABEL_PURCHASED"],
  pack: ["PICKING"],
  ship: ["PACKED"],
};

@Injectable()
export class AdminOrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly shippo: ShippoService,
    private readonly notifications: NotificationService,
  ) {}

  // ---------------------------------------------------------------------------
  // Read — operator queue
  // ---------------------------------------------------------------------------

  async list(input: AdminOrderListInput) {
    // Filter precedence:
    //   1. Explicit `status` → exact match (e.g. "show me all SHIPPED orders").
    //   2. `view=all`        → no filter, every order regardless of status.
    //   3. Default           → operator queue (ALLOCATED → PACKED).
    const where: Prisma.OrderWhereInput = input.status
      ? { status: input.status }
      : input.view === "all"
        ? {}
        : { status: { in: ["ALLOCATED", "LABEL_PURCHASED", "PICKING", "PACKED"] } };

    const orders = await this.prisma.order.findMany({
      where,
      include: {
        lines: true,
        vendor: { select: { id: true, businessName: true, country: true } },
      },
      take: input.limit + 1,
      orderBy: { allocatedAt: "asc" },
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    });

    let nextCursor: string | null = null;
    if (orders.length > input.limit) {
      const next = orders.pop();
      nextCursor = next?.id ?? null;
    }
    return { items: orders, nextCursor };
  }

  async get(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        lines: true,
        events: { orderBy: { occurredAt: "asc" } },
        vendor: { select: { id: true, businessName: true } },
      },
    });
    if (!order) throw new NotFoundException();
    return order;
  }

  // ---------------------------------------------------------------------------
  // Transitions
  // ---------------------------------------------------------------------------

  async purchaseLabel(id: string, actorId: string) {
    return this.transition(id, actorId, "purchaseLabel", async (tx, order) => {
      // Buy the label from the carrier. The rateProviderRef + ratePurchasedRef
      // were saved at order create time so we have everything we need.
      if (!order.rateProviderRef || !order.ratePurchasedRef) {
        throw new ConflictException({
          message: "Order is missing rate references; cannot purchase label.",
          code: "order_label_missing_rate",
        });
      }
      const label = await this.shippo.purchaseLabel({
        shipmentId: order.rateProviderRef,
        rateId: order.ratePurchasedRef,
        insuranceCents: order.insuranceFeeCents,
      });

      const updated = await tx.order.update({
        where: { id },
        data: {
          status: "LABEL_PURCHASED",
          carrier: label.carrier,
          carrierService: `${label.carrier} ${label.service}`,
          trackingNumber: label.trackingNumber,
          labelUrl: label.labelUrl,
          labelPurchasedAt: new Date(),
        },
      });

      await tx.orderEvent.create({
        data: {
          orderId: id,
          type: "carrier.label_purchased",
          description: `Label purchased: ${label.trackingNumber} (${label.carrier})`,
          source: "ADMIN",
          actorId,
          metadata: { trackingNumber: label.trackingNumber, labelUrl: label.labelUrl },
        },
      });
      return updated;
    });
  }

  async pick(id: string, actorId: string) {
    return this.transition(id, actorId, "pick", async (tx) => {
      const updated = await tx.order.update({
        where: { id },
        data: { status: "PICKING", pickingStartedAt: new Date() },
      });
      await tx.orderEvent.create({
        data: {
          orderId: id,
          type: "order.picking_started",
          description: "Picking started.",
          source: "ADMIN",
          actorId,
        },
      });
      return updated;
    });
  }

  async pack(id: string, actorId: string) {
    return this.transition(id, actorId, "pack", async (tx) => {
      const updated = await tx.order.update({
        where: { id },
        data: { status: "PACKED", packedAt: new Date() },
      });
      await tx.orderEvent.create({
        data: {
          orderId: id,
          type: "order.packed",
          description: "Order packed.",
          source: "ADMIN",
          actorId,
        },
      });
      return updated;
    });
  }

  async ship(id: string, actorId: string) {
    const updated = await this.transition(id, actorId, "ship", async (tx) => {
      // Mark the order lines as SHIPPED + decrement reserved counts.
      const lines = await tx.orderLine.findMany({ where: { orderId: id } });
      for (const line of lines) {
        await tx.sku.update({
          where: { id: line.skuId },
          data: { quantityReserved: { decrement: line.quantity } },
        });
        await tx.inventoryMovement.create({
          data: {
            vendorId: line.vendorId,
            skuId: line.skuId,
            type: "SHIP",
            deltaAvailable: 0,
            deltaReserved: -line.quantity,
            referenceType: "order",
            referenceId: id,
            actorId,
          },
        });
        await tx.orderLine.update({
          where: { id: line.id },
          data: { allocationStatus: "SHIPPED" },
        });
      }

      const o = await tx.order.update({
        where: { id },
        data: { status: "SHIPPED", shippedAt: new Date() },
      });
      await tx.orderEvent.create({
        data: {
          orderId: id,
          type: "order.shipped",
          description: "Handed to carrier.",
          source: "ADMIN",
          actorId,
        },
      });
      return o;
    });

    // Side-effect after the transaction commits — notification + email parity.
    // Failures here MUST NOT roll back the carrier hand-off above.
    if (updated.trackingNumber && updated.carrier) {
      const tpl = orderShippedTemplate({
        orderRef: updated.externalReference ?? updated.id.slice(0, 8),
        carrier: updated.carrier,
        trackingNumber: updated.trackingNumber,
        orderId: updated.id,
      });
      await this.notifications.emit({
        vendorId: updated.vendorId,
        type: "order.shipped",
        severity: "INFO",
        title: `Order ${updated.externalReference ?? updated.id.slice(0, 8)} shipped`,
        body: `${updated.carrier} picked it up. Tracking: ${updated.trackingNumber}.`,
        href: `/orders/${updated.id}`,
        email: { subject: tpl.subject, html: tpl.html, text: tpl.text },
      });
    }
    return updated;
  }

  // ---------------------------------------------------------------------------

  /** Wraps a transition: lock the order, validate state, run the body, audit. */
  private async transition<T>(
    id: string,
    actorId: string,
    name: keyof typeof ALLOWED_TRANSITIONS,
    body: (tx: Tx, order: Order) => Promise<T>,
  ): Promise<T> {
    const allowed = ALLOWED_TRANSITIONS[name]!;

    const result = await this.prisma.$transaction(async (tx) => {
      // Lock the row.
      const lockedRows = await tx.$queryRaw<Array<{ id: string; status: OrderStatus }>>(
        Prisma.sql`SELECT id, status FROM orders WHERE id = ${id}::uuid FOR UPDATE`,
      );
      const locked = lockedRows[0];
      if (!locked) throw new NotFoundException();
      if (!allowed.includes(locked.status)) {
        throw new ConflictException({
          message: `Order in ${locked.status} cannot be transitioned via ${name}. Allowed: ${allowed.join(", ")}.`,
          code: "order_invalid_transition",
        });
      }

      const order = await tx.order.findUniqueOrThrow({ where: { id } });
      return body(tx, order);
    });

    await this.audit.log({
      actorId,
      action: `order.admin.${name}`,
      resourceType: "order",
      resourceId: id,
    });

    return result;
  }
}
