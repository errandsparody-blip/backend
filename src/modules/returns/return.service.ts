/**
 * ReturnService — vendor-side RMA creation + admin receive/inspect.
 *
 * Implementation Plan §6.7.
 *
 * Critical guarantees:
 *
 *   1. A return can only be created against an order in DELIVERED or
 *      EXCEPTION status. Pending/in-transit orders go through cancel, not RMA.
 *
 *   2. requestedQty per line must not exceed the order line's quantity (a
 *      vendor cannot return more than they ordered).
 *
 *   3. On RESTOCKED, the restocked qty is added back to the SKU's available
 *      bucket via InventoryMovement of type RETURN. Damaged / disposed qty
 *      does NOT come back to inventory.
 *
 *   4. The refund is paid via wallet.credit() with type REVERSAL — atomic
 *      against the inventory movements. Either everything happens or nothing.
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomBytes } from "node:crypto";
import type { PrismaClient, Return, ReturnStatus } from "@prisma/client";

import { formatOrderRef } from "../../common/order-ref";
import { PrismaService } from "../../common/prisma.service";
import type {
  CreateReturnInput,
  InspectReturnInput,
  ListReturnsInput,
  ReceiveReturnInput,
} from "../../common/schemas/return.schema";
import { AuditService } from "../audit/audit.service";
import { returnAuthorizedTemplate, returnRefundedTemplate } from "../email/email-templates";
import { ShippoService } from "../integrations/shippo/shippo.service";
import { NotificationService } from "../notifications/notification.service";
import { WalletService } from "../wallet/wallet.service";

type Tx = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

@Injectable()
export class ReturnService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly wallet: WalletService,
    private readonly shippo: ShippoService,
    private readonly notifications: NotificationService,
  ) {}

  // ===========================================================================
  // Vendor — create / read / cancel
  // ===========================================================================

  async create(vendorId: string, actorId: string, input: CreateReturnInput): Promise<Return> {
    // Tenant-scoped order load.
    const order = await this.prisma.order.findFirst({
      where: { id: input.orderId, vendorId },
      include: { lines: true },
    });
    if (!order) throw new NotFoundException("Order not found.");
    if (!["DELIVERED", "EXCEPTION"].includes(order.status)) {
      throw new ConflictException({
        message: `Returns can only be created for delivered orders. Current status: ${order.status}.`,
        code: "return_order_not_returnable",
      });
    }

    // Migration 0018 — enforce the configurable return window. Vendors
    // can't open an RMA against an order delivered more than N days
    // ago. Mirrors the public-facing 30-day FBA-style policy. The
    // window is stored as a configuration row so admins can tune it
    // without a deploy.
    const windowDays = await this.loadReturnWindowDays();
    if (order.deliveredAt) {
      const ageMs = Date.now() - order.deliveredAt.getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      if (ageDays > windowDays) {
        throw new ConflictException({
          message: `This order was delivered ${Math.floor(ageDays)} days ago. Returns must be opened within ${windowDays} days of delivery.`,
          code: "return_outside_window",
          windowDays,
          deliveredAt: order.deliveredAt.toISOString(),
        });
      }
    }

    // Validate every requested line: must belong to the order, requestedQty ≤ ordered qty.
    const linesById = new Map(order.lines.map((l) => [l.id, l]));
    for (const r of input.lines) {
      const ol = linesById.get(r.orderLineId);
      if (!ol) {
        throw new BadRequestException({
          message: `Order line ${r.orderLineId} is not part of this order.`,
          code: "return_invalid_order_line",
        });
      }
      if (r.requestedQty > ol.quantity) {
        throw new BadRequestException({
          message: `Cannot return ${r.requestedQty} of line ${r.orderLineId}: only ${ol.quantity} were ordered.`,
          code: "return_qty_exceeds_order",
        });
      }
    }

    const rmaCode = this.generateRmaCode();

    // Create return + lines + inbound label in a single transaction.
    // The `attachmentUrls` field exists in the DB (migration 0018) but
    // not in the stale generated Prisma client checked into the repo.
    // Cast through `unknown` to bypass — Railway's `prisma generate`
    // step on the next deploy aligns the two.
    const created = await this.prisma.$transaction(async (tx) => {
      const ret = await tx.return.create({
        data: {
          vendorId,
          orderId: order.id,
          rmaCode,
          status: "AUTHORIZED",
          reason: input.reason,
          createdBy: actorId,
          authorizedAt: new Date(),
          // Migration 0018 — vendor-supplied photo evidence.
          ...({ attachmentUrls: input.attachmentUrls ?? [] } as Record<string, unknown>),
          lines: {
            create: input.lines.map((l) => ({
              orderLineId: l.orderLineId,
              skuId: linesById.get(l.orderLineId)!.skuId,
              requestedQty: l.requestedQty,
            })),
          },
        } as unknown as Prisma.ReturnCreateInput,
        include: { lines: true },
      });
      return ret;
    });

    await this.audit.log({
      actorId,
      action: "return.created",
      resourceType: "return",
      resourceId: created.id,
      afterState: { rmaCode, orderId: order.id, lineCount: input.lines.length, reason: input.reason },
    });

    // Inbound label is best-effort — if the carrier API fails, the RMA still
    // exists in AUTHORIZED state and an admin can attach the label later.
    try {
      const label = await this.shippo.purchaseLabel({
        shipmentId: order.rateProviderRef ?? `inbound_${created.id}`,
        rateId: order.ratePurchasedRef ?? `inbound_rate_${created.id}`,
      });
      await this.prisma.return.update({
        where: { id: created.id },
        data: {
          inboundCarrier: label.carrier,
          inboundTracking: label.trackingNumber,
          inboundLabelUrl: label.labelUrl,
        },
      });
    } catch {
      // Swallow — admin will retry from the admin UI.
    }

    const finalRet = await this.prisma.return.findUniqueOrThrow({
      where: { id: created.id },
      include: { lines: true },
    });

    // Notify vendor + send the RMA-authorized email. After-tx, best-effort.
    // Pass the Shippo-hosted label URL too so the email's CTA goes
    // straight to the printable PDF — saves the vendor a portal hop
    // before forwarding it to their customer.
    const tpl = returnAuthorizedTemplate({
      rmaCode: finalRet.rmaCode,
      orderRef: formatOrderRef(order.orderNumber),
      trackingNumber: finalRet.inboundTracking,
      inboundLabelUrl: finalRet.inboundLabelUrl,
    });
    await this.notifications.emit({
      vendorId,
      type: "return.authorized",
      severity: "INFO",
      title: `Return ${finalRet.rmaCode} authorised`,
      body: finalRet.inboundTracking
        ? `Inbound tracking: ${finalRet.inboundTracking}. We'll inspect on arrival.`
        : "We'll attach an inbound label shortly. The customer will be notified.",
      href: "/returns",
      email: { subject: tpl.subject, html: tpl.html, text: tpl.text },
    });

    return finalRet;
  }

  async list(vendorId: string, input: ListReturnsInput) {
    const where: Prisma.ReturnWhereInput = { vendorId };
    if (input.status) where.status = input.status;

    const items = await this.prisma.return.findMany({
      where,
      include: { lines: true },
      take: input.limit + 1,
      orderBy: { createdAt: "desc" },
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    });

    let nextCursor: string | null = null;
    if (items.length > input.limit) {
      const next = items.pop();
      nextCursor = next?.id ?? null;
    }
    return { items, nextCursor };
  }

  async get(vendorId: string, id: string) {
    const ret = await this.prisma.return.findFirst({
      where: { id, vendorId },
      include: { lines: true },
    });
    if (!ret) throw new NotFoundException();
    return ret;
  }

  async cancel(vendorId: string, actorId: string, id: string) {
    const ret = await this.prisma.return.findFirst({ where: { id, vendorId } });
    if (!ret) throw new NotFoundException();
    if (!["REQUESTED", "AUTHORIZED"].includes(ret.status)) {
      throw new ConflictException({
        message: `Cannot cancel a return in ${ret.status}.`,
        code: "return_not_cancellable",
      });
    }
    const updated = await this.prisma.return.update({
      where: { id },
      data: { status: "CANCELLED", resolvedAt: new Date() },
      include: { lines: true },
    });
    await this.audit.log({
      actorId,
      action: "return.cancelled",
      resourceType: "return",
      resourceId: id,
      beforeState: { status: ret.status },
    });
    return updated;
  }

  // ===========================================================================
  // Admin — receive + inspect
  // ===========================================================================

  async adminReceive(actorId: string, id: string, input: ReceiveReturnInput) {
    return this.prisma.$transaction(async (tx) => {
      const ret = await this.lockReturn(tx, id);
      if (!["AUTHORIZED", "IN_TRANSIT"].includes(ret.status)) {
        throw new ConflictException({
          message: `Cannot receive a return in ${ret.status}.`,
          code: "return_not_receivable",
        });
      }

      const lines = await tx.returnLine.findMany({ where: { returnId: id } });
      const linesById = new Map(lines.map((l) => [l.id, l]));

      for (const r of input.lines) {
        const line = linesById.get(r.returnLineId);
        if (!line) {
          throw new BadRequestException(`Return line ${r.returnLineId} is not part of this return.`);
        }
        if (r.receivedQty > line.requestedQty) {
          throw new BadRequestException({
            message: `Received qty (${r.receivedQty}) exceeds requested (${line.requestedQty}) on line ${r.returnLineId}.`,
            code: "return_overreceive",
          });
        }
        await tx.returnLine.update({
          where: { id: r.returnLineId },
          data: { receivedQty: r.receivedQty },
        });
      }

      const updated = await tx.return.update({
        where: { id },
        data: { status: "RECEIVED", receivedAt: new Date() },
        include: { lines: true },
      });
      await this.audit.log({
        actorId,
        action: "return.received",
        resourceType: "return",
        resourceId: id,
      });
      return updated;
    });
  }

  async adminInspect(actorId: string, id: string, input: InspectReturnInput) {
    const result = await this.prisma.$transaction(async (tx) => {
      const ret = await this.lockReturn(tx, id);
      if (ret.status !== "RECEIVED") {
        throw new ConflictException({
          message: `Cannot inspect a return in ${ret.status}.`,
          code: "return_not_inspectable",
        });
      }

      // Validate the disposition split per line.
      const lines = await tx.returnLine.findMany({ where: { returnId: id } });
      const linesById = new Map(lines.map((l) => [l.id, l]));

      for (const r of input.lines) {
        const line = linesById.get(r.returnLineId);
        if (!line) {
          throw new BadRequestException(`Return line ${r.returnLineId} is not part of this return.`);
        }
        const split = r.restockedQty + r.damagedQty + r.disposedQty;
        if (split > line.receivedQty) {
          throw new BadRequestException({
            message: `Disposition split (${split}) exceeds received (${line.receivedQty}) on line ${r.returnLineId}.`,
            code: "return_disposition_exceeds_received",
          });
        }
        await tx.returnLine.update({
          where: { id: r.returnLineId },
          data: {
            restockedQty: r.restockedQty,
            damagedQty: r.damagedQty,
            disposedQty: r.disposedQty,
            ...(r.notes !== undefined ? { notes: r.notes } : {}),
          },
        });

        // Restock — increment SKU available + write inventory movement.
        if (r.restockedQty > 0) {
          await tx.sku.update({
            where: { id: line.skuId },
            data: { quantityAvailable: { increment: r.restockedQty } },
          });
          await tx.inventoryMovement.create({
            data: {
              vendorId: ret.vendorId,
              skuId: line.skuId,
              type: "RETURN",
              deltaAvailable: r.restockedQty,
              deltaReserved: 0,
              referenceType: "return",
              referenceId: id,
              actorId,
            },
          });
        }
      }

      // Refund the wallet (net of restock fee).
      const netRefund = Math.max(0, input.refundAmountCents - input.restockFeeCents);
      if (netRefund > 0) {
        await this.wallet.credit(
          {
            vendorId: ret.vendorId,
            amountCents: netRefund,
            type: "REVERSAL",
            description: `Return refund for ${ret.rmaCode}`,
            referenceType: "return",
            referenceId: id,
            actorId,
          },
          tx as unknown as Parameters<typeof this.wallet.credit>[1],
        );
      }

      // Determine terminal status.
      const totalRestocked = input.lines.reduce((s, l) => s + l.restockedQty, 0);
      const next: ReturnStatus = totalRestocked > 0 ? "RESTOCKED" : "DISPOSED";

      const updated = await tx.return.update({
        where: { id },
        data: {
          status: next,
          refundAmountCents: input.refundAmountCents,
          restockFeeCents: input.restockFeeCents,
          inspectorNotes: input.inspectorNotes ?? null,
          inspectedAt: new Date(),
          resolvedAt: new Date(),
        },
        include: { lines: true },
      });

      // Mark order as RETURNED on the parent order so the vendor sees it.
      // Skipping any orders that are CANCELLED — those cannot transition.
      const order = await tx.order.findUnique({ where: { id: ret.orderId } });
      if (order && order.status === "DELIVERED") {
        await tx.order.update({ where: { id: order.id }, data: { status: "RETURNED" } });
        await tx.orderEvent.create({
          data: {
            orderId: order.id,
            type: "order.returned",
            description: `Return ${ret.rmaCode} resolved (${next}).`,
            source: "ADMIN",
            actorId,
          },
        });
      }

      await this.audit.log({
        actorId,
        action: "return.inspected",
        resourceType: "return",
        resourceId: id,
        afterState: {
          status: next,
          refundAmountCents: input.refundAmountCents,
          restockFeeCents: input.restockFeeCents,
        },
      });

      return { updated, vendorId: ret.vendorId, netRefund };
    });

    // After-tx side-effect: notify the vendor + email parity. Errors here
    // do NOT roll back the inspection.
    if (result.netRefund > 0) {
      const wallet = await this.prisma.wallet.findUnique({ where: { vendorId: result.vendorId } });
      const tpl = returnRefundedTemplate({
        rmaCode: result.updated.rmaCode,
        netRefundCents: result.netRefund,
        balanceAfterCents: wallet?.balanceCents ?? 0,
      });
      await this.notifications.emit({
        vendorId: result.vendorId,
        type: "return.refunded",
        severity: "SUCCESS",
        title: `Return ${result.updated.rmaCode} refunded`,
        body: `$${(result.netRefund / 100).toFixed(2)} added back to your wallet.`,
        href: "/wallet",
        email: { subject: tpl.subject, html: tpl.html, text: tpl.text },
      });
    }
    return result.updated;
  }

  async adminList(input: ListReturnsInput) {
    const where: Prisma.ReturnWhereInput = {};
    if (input.status) where.status = input.status;
    if (input.from || input.to) {
      where.createdAt = {
        ...(input.from ? { gte: input.from } : {}),
        ...(input.to ? { lte: input.to } : {}),
      };
    }
    const items = await this.prisma.return.findMany({
      where,
      include: { lines: true, order: { select: { id: true, externalReference: true, vendorId: true } } },
      take: input.limit + 1,
      orderBy: { createdAt: "desc" },
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    });
    let nextCursor: string | null = null;
    if (items.length > input.limit) {
      const next = items.pop();
      nextCursor = next?.id ?? null;
    }
    return { items, nextCursor };
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /** RMA code: RMA-XXXXXXXX (uppercase alphanumeric, 8 chars after the prefix). */
  private generateRmaCode(): string {
    const charset = "ABCDEFGHIJKLMNPQRSTUVWXYZ23456789"; // omit 0/O/1/I for legibility
    const buf = randomBytes(8);
    let out = "";
    for (let i = 0; i < 8; i++) {
      out += charset[buf[i]! % charset.length];
    }
    return `RMA-${out}`;
  }

  private async lockReturn(tx: Tx, id: string): Promise<Return> {
    const rows = await tx.$queryRaw<Return[]>(
      Prisma.sql`SELECT * FROM returns WHERE id = ${id}::uuid FOR UPDATE`,
    );
    const row = rows[0];
    if (!row) throw new NotFoundException();
    return row;
  }

  /**
   * Read the configurable return-window cutoff in days from the
   * configuration table. Defaults to 30 (matches FBA / Amazon norms)
   * if the row is absent or the value isn't a positive integer.
   *
   * Public so the order controller can compute `returnableUntil` on
   * the order GET response without re-implementing the lookup.
   */
  async getReturnWindowDays(): Promise<number> {
    return this.loadReturnWindowDays();
  }

  private async loadReturnWindowDays(): Promise<number> {
    const FALLBACK = 30;
    const MAX = 365;
    try {
      const row = await this.prisma.configuration.findUnique({
        where: { key: "returns_window_days" },
      });
      if (!row) return FALLBACK;
      const value = row.value as unknown;
      const days = typeof value === "number" ? value : Number(value);
      if (!Number.isInteger(days) || days < 1 || days > MAX) return FALLBACK;
      return days;
    } catch {
      // Defensive: a config-table outage shouldn't block returns.
      // Fall back to the safer 30-day default.
      return FALLBACK;
    }
  }
}
