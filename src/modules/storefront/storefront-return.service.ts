/**
 * StorefrontReturnService — buyer self-service returns (Migration 0061).
 *
 * A signed-in buyer requests a return on a shipped/delivered order; an admin
 * approves (which issues a refund via StorefrontOrderService) or rejects. One
 * open request per order (enforced by a partial unique index). Raw SQL.
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { PrismaService } from "../../common/prisma.service";
import { EmailService } from "../email/email.service";
import {
  storefrontReturnReceivedTemplate,
  storefrontReturnRejectedTemplate,
} from "../email/email-templates";
import { NotificationService } from "../notifications/notification.service";

import { StorefrontOrderService } from "./storefront-order.service";

const RETURNABLE_ORDER_STATUSES = new Set(["SHIPPED", "DELIVERED"]);

@Injectable()
export class StorefrontReturnService {
  private readonly logger = new Logger(StorefrontReturnService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: StorefrontOrderService,
    private readonly email: EmailService,
    private readonly notifications: NotificationService,
  ) {}

  /** Buyer requests a return on their own order (matched by their email). */
  async requestReturn(
    buyerEmail: string,
    orderReference: string,
    reason: string,
    trackingNumber?: string | null,
  ): Promise<{ reference: string; status: string }> {
    const email = buyerEmail.trim().toLowerCase();
    const order = await this.resolveBuyerOrder(orderReference, email);
    if (!order) {
      throw new NotFoundException({ message: "Order not found.", code: "storefront_order_not_found" });
    }
    // Throws with a specific code when the order can't be returned.
    this.assertReturnable(order);

    let reference: string;
    try {
      reference = await this.insertReturn(order, email, reason, trackingNumber ?? null);
    } catch (err) {
      // The partial unique index rejects a second open request for the order.
      if (`${err}`.includes("one_open") || `${err}`.includes("unique")) {
        throw new ConflictException({
          message: "There's already an open return request for this order.",
          code: "return_already_open",
        });
      }
      throw err;
    }

    const tpl = storefrontReturnReceivedTemplate({
      reference,
      orderReference,
      storeName: order.store_name ?? order.business_name,
      buyerName: order.buyer_name,
    });
    await this.email
      .send({
        to: email,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
        type: "storefront.return_received",
        idempotencyKey: `storefront_return_ack:${reference}`,
      })
      .catch(() => undefined);
    this.notifyVendorOfReturn(order, orderReference, reference);

    this.logger.log({ reference, orderReference }, "storefront.return.requested");
    return { reference, status: "REQUESTED" };
  }

  /**
   * Look up an order (by reference + buyer email) and return every sub-order in
   * the same cart, each with items + whether it can be returned right now. Powers
   * the self-service returns page: enter your order number + email, pick which
   * store's items to send back.
   */
  async lookupForBuyer(
    orderReference: string,
    buyerEmail: string,
  ): Promise<{
    buyerName: string | null;
    subOrders: Array<{
      reference: string;
      storeName: string;
      status: string;
      items: Array<{ name: string; qty: number }>;
      returnable: boolean;
      reason: string | null;
      existingReturn: string | null;
    }>;
  }> {
    const email = buyerEmail.trim().toLowerCase();
    // The looked-up order pins the buyer + (optional) cart group.
    const anchor = await this.prisma.$queryRaw<
      Array<{ cart_group_id: string | null; buyer_name: string | null }>
    >(Prisma.sql`
      SELECT cart_group_id, buyer_name FROM storefront_orders
      WHERE reference = ${orderReference} AND lower(buyer_email) = ${email}
      LIMIT 1
    `);
    const a = anchor[0];
    if (!a) {
      throw new NotFoundException({
        message: "We couldn't find an order with that number and email.",
        code: "storefront_order_not_found",
      });
    }

    const rows = await this.prisma.$queryRaw<
      Array<{
        reference: string;
        status: string;
        shipped_at: Date | null;
        items: Array<{ name: string; qty: number }>;
        store_name: string | null;
        business_name: string;
        returns_allowed: boolean | null;
        return_window_days: number | null;
        open_return: string | null;
        resolved_return: string | null;
      }>
    >(Prisma.sql`
      SELECT so.reference, so.status, so.shipped_at, so.items,
             vs.display_name AS store_name, v.business_name,
             vs.returns_allowed, vs.return_window_days,
             (SELECT rr.reference FROM storefront_return_requests rr
                WHERE rr.storefront_order_id = so.id AND rr.status = 'REQUESTED' LIMIT 1) AS open_return,
             (SELECT rr.status FROM storefront_return_requests rr
                WHERE rr.storefront_order_id = so.id AND rr.status <> 'REQUESTED'
                ORDER BY rr.created_at DESC LIMIT 1) AS resolved_return
      FROM storefront_orders so
      JOIN vendors v ON v.id = so.vendor_id
      LEFT JOIN vendor_storefronts vs ON vs.vendor_id = so.vendor_id
      WHERE lower(so.buyer_email) = ${email}
        AND ${a.cart_group_id
          ? Prisma.sql`so.cart_group_id = ${a.cart_group_id}::uuid`
          : Prisma.sql`so.reference = ${orderReference}`}
      ORDER BY so.created_at ASC
    `);

    return {
      buyerName: a.buyer_name,
      subOrders: rows.map((r) => {
        const check = this.returnableReason({
          status: r.status,
          shipped_at: r.shipped_at,
          returns_allowed: r.returns_allowed,
          return_window_days: r.return_window_days,
        });
        const blocked =
          r.open_return
            ? "A return is already open for this order."
            : r.resolved_return === "APPROVED"
              ? "Already refunded."
              : check;
        return {
          reference: r.reference,
          storeName: r.store_name ?? r.business_name,
          status: r.status,
          items: Array.isArray(r.items) ? r.items.map((i) => ({ name: i.name, qty: i.qty })) : [],
          returnable: blocked === null,
          reason: blocked,
          existingReturn: r.open_return ?? null,
        };
      }),
    };
  }

  /**
   * Open returns for one or more sub-orders of a buyer's cart in a single go,
   * stamping the tracking number of the parcel they've shipped back. Per-order
   * failures are collected (not fatal) so a partial cart still succeeds.
   */
  async requestCartReturn(
    buyerEmail: string,
    references: string[],
    reason: string,
    trackingNumber: string,
  ): Promise<{
    created: Array<{ orderReference: string; returnReference: string }>;
    skipped: Array<{ orderReference: string; message: string }>;
  }> {
    const created: Array<{ orderReference: string; returnReference: string }> = [];
    const skipped: Array<{ orderReference: string; message: string }> = [];
    for (const ref of references) {
      try {
        const res = await this.requestReturn(buyerEmail, ref, reason, trackingNumber);
        created.push({ orderReference: ref, returnReference: res.reference });
      } catch (err) {
        const msg =
          (err as { response?: { message?: string } })?.response?.message ??
          (err as Error)?.message ??
          "Couldn't open a return for this order.";
        skipped.push({ orderReference: ref, message: msg });
      }
    }
    if (created.length === 0 && skipped.length > 0) {
      throw new BadRequestException({
        message: skipped[0]!.message,
        code: "return_none_created",
        skipped,
      });
    }
    return { created, skipped };
  }

  /** Warehouse marks a returned parcel received (gate before admin approves). */
  async markReceived(id: string, actorId: string): Promise<{ id: string; receivedAt: string }> {
    const rows = await this.prisma.$queryRaw<Array<{ status: string }>>(
      Prisma.sql`SELECT status FROM storefront_return_requests WHERE id = ${id}::uuid LIMIT 1`,
    );
    if (!rows[0]) {
      throw new NotFoundException({ message: "Return request not found.", code: "return_not_found" });
    }
    if (rows[0].status !== "REQUESTED") {
      throw new ConflictException({
        message: `This return is already ${rows[0].status.toLowerCase()}.`,
        code: "return_not_open",
      });
    }
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE storefront_return_requests
      SET received_at = COALESCE(received_at, now()), received_by = ${actorId}::uuid, updated_at = now()
      WHERE id = ${id}::uuid
    `);
    this.logger.log({ id }, "storefront.return.received");
    return { id, receivedAt: new Date().toISOString() };
  }

  // --- helpers ---------------------------------------------------------------

  private async resolveBuyerOrder(orderReference: string, email: string) {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        vendor_id: string;
        status: string;
        shipped_at: Date | null;
        buyer_name: string | null;
        store_name: string | null;
        business_name: string;
        returns_allowed: boolean | null;
        return_window_days: number | null;
      }>
    >(Prisma.sql`
      SELECT so.id, so.vendor_id, so.status, so.shipped_at, so.buyer_name,
             vs.display_name AS store_name, v.business_name,
             vs.returns_allowed, vs.return_window_days
      FROM storefront_orders so
      JOIN vendors v ON v.id = so.vendor_id
      LEFT JOIN vendor_storefronts vs ON vs.vendor_id = so.vendor_id
      WHERE so.reference = ${orderReference} AND lower(so.buyer_email) = ${email}
      LIMIT 1
    `);
    return rows[0] ?? null;
  }

  /** Non-throwing eligibility check; returns a reason string when blocked, else null. */
  private returnableReason(o: {
    status: string;
    shipped_at: Date | null;
    returns_allowed: boolean | null;
    return_window_days: number | null;
  }): string | null {
    if (!RETURNABLE_ORDER_STATUSES.has(o.status)) return "Not shipped yet.";
    if (!(o.returns_allowed ?? true)) return "This store doesn't accept returns.";
    const windowDays = o.return_window_days ?? 30;
    if (o.shipped_at) {
      const deadline = new Date(o.shipped_at).getTime() + windowDays * 24 * 60 * 60 * 1000;
      if (Date.now() > deadline) return `The ${windowDays}-day return window has passed.`;
    }
    return null;
  }

  /** Throwing eligibility check used by requestReturn. */
  private assertReturnable(o: {
    status: string;
    shipped_at: Date | null;
    returns_allowed: boolean | null;
    return_window_days: number | null;
  }): void {
    if (!RETURNABLE_ORDER_STATUSES.has(o.status)) {
      throw new BadRequestException({
        message: "Returns can be requested once an order has shipped.",
        code: "order_not_returnable",
        status: o.status,
      });
    }
    if (!(o.returns_allowed ?? true)) {
      throw new BadRequestException({
        message: "This store doesn't accept returns.",
        code: "returns_not_accepted",
      });
    }
    const windowDays = o.return_window_days ?? 30;
    if (o.shipped_at) {
      const deadline = new Date(o.shipped_at).getTime() + windowDays * 24 * 60 * 60 * 1000;
      if (Date.now() > deadline) {
        throw new BadRequestException({
          message: `The ${windowDays}-day return window for this order has passed.`,
          code: "return_window_expired",
          windowDays,
        });
      }
    }
  }

  private async insertReturn(
    order: { id: string },
    email: string,
    reason: string,
    trackingNumber: string | null,
  ): Promise<string> {
    const refRow = await this.prisma.$queryRaw<Array<{ n: bigint }>>(
      Prisma.sql`SELECT nextval('storefront_return_ref_seq') AS n`,
    );
    const reference = `SR-${String(Number(refRow[0]!.n)).padStart(6, "0")}`;
    await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO storefront_return_requests
        (reference, storefront_order_id, buyer_email, status, reason,
         return_tracking_number, created_at, updated_at)
      VALUES (${reference}, ${order.id}::uuid, ${email}, 'REQUESTED', ${reason},
              ${trackingNumber}, now(), now())
    `);
    return reference;
  }

  /** In-app + email notify the vendor that a buyer opened a return (fire-and-forget). */
  private notifyVendorOfReturn(
    order: { vendor_id: string },
    orderReference: string,
    returnReference: string,
  ): void {
    void this.notifications
      .emit({
        vendorId: order.vendor_id,
        type: "storefront.return_requested",
        title: "A buyer opened a return",
        body: `Return ${returnReference} on order ${orderReference} is awaiting the parcel and admin review.`,
        href: `/storefront/orders`,
        email: {
          subject: `Return opened on order ${orderReference}`,
          html: `<p>A buyer has opened return <strong>${returnReference}</strong> on order <strong>${orderReference}</strong>.</p><p>USA Errands will review it once the parcel is received. No action is needed from you — if it's approved, the refund is handled centrally.</p>`,
          text: `A buyer opened return ${returnReference} on order ${orderReference}. USA Errands will review it once the parcel is received.`,
        },
      })
      .catch(() => undefined);
  }

  /** Admin queue of return requests (optionally filtered by status). */
  async adminList(opts: { status?: string } = {}) {
    return this.prisma.$queryRaw(Prisma.sql`
      SELECT rr.id, rr.reference, rr.status, rr.reason, rr.resolution_note,
             rr.refund_id, rr.refunded_cents, rr.return_tracking_number, rr.received_at,
             rr.created_at, rr.resolved_at,
             so.reference AS order_reference, so.buyer_email, so.total_cents,
             so.status AS order_status, v.business_name
      FROM storefront_return_requests rr
      JOIN storefront_orders so ON so.id = rr.storefront_order_id
      JOIN vendors v ON v.id = so.vendor_id
      ${opts.status ? Prisma.sql`WHERE rr.status = ${opts.status}` : Prisma.empty}
      ORDER BY rr.created_at DESC
      LIMIT 300
    `);
  }

  /** Approve a return → issue the refund and mark it approved. */
  async approve(
    id: string,
    actorId: string,
    amountCents?: number,
  ): Promise<{ status: string; refundId: string; refundedCents: number }> {
    const req = await this.loadOpen(id);
    const refund = await this.orders.refund(req.orderReference, actorId, amountCents);
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE storefront_return_requests
      SET status = 'APPROVED', refund_id = ${refund.refundId}, refunded_cents = ${refund.amountCents},
          resolved_by = ${actorId}::uuid, resolved_at = now(), updated_at = now()
      WHERE id = ${id}::uuid
    `);
    this.logger.log({ id, refundId: refund.refundId }, "storefront.return.approved");
    return { status: "APPROVED", refundId: refund.refundId, refundedCents: refund.amountCents };
  }

  /** Reject a return with a note; emails the buyer. */
  async reject(id: string, actorId: string, note?: string): Promise<{ status: string }> {
    const req = await this.loadOpen(id);
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE storefront_return_requests
      SET status = 'REJECTED', resolution_note = ${note ?? null},
          resolved_by = ${actorId}::uuid, resolved_at = now(), updated_at = now()
      WHERE id = ${id}::uuid
    `);
    const tpl = storefrontReturnRejectedTemplate({
      reference: req.reference,
      storeName: req.storeName,
      note,
      buyerName: req.buyerName,
    });
    await this.email
      .send({
        to: req.buyerEmail,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
        type: "storefront.return_rejected",
        idempotencyKey: `storefront_return_reject:${req.reference}`,
      })
      .catch(() => undefined);
    this.logger.log({ id }, "storefront.return.rejected");
    return { status: "REJECTED" };
  }

  private async loadOpen(id: string): Promise<{
    reference: string;
    orderReference: string;
    buyerEmail: string;
    buyerName: string | null;
    storeName: string;
  }> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        status: string;
        reference: string;
        order_reference: string;
        buyer_email: string;
        buyer_name: string | null;
        store_name: string | null;
        business_name: string;
      }>
    >(Prisma.sql`
      SELECT rr.status, rr.reference, so.reference AS order_reference, so.buyer_email,
             so.buyer_name, vs.display_name AS store_name, v.business_name
      FROM storefront_return_requests rr
      JOIN storefront_orders so ON so.id = rr.storefront_order_id
      JOIN vendors v ON v.id = so.vendor_id
      LEFT JOIN vendor_storefronts vs ON vs.vendor_id = so.vendor_id
      WHERE rr.id = ${id}::uuid
      LIMIT 1
    `);
    const r = rows[0];
    if (!r) throw new NotFoundException({ message: "Return request not found.", code: "return_not_found" });
    if (r.status !== "REQUESTED") {
      throw new ConflictException({
        message: `This return is already ${r.status.toLowerCase()}.`,
        code: "return_not_open",
      });
    }
    return {
      reference: r.reference,
      orderReference: r.order_reference,
      buyerEmail: r.buyer_email,
      buyerName: r.buyer_name,
      storeName: r.store_name ?? r.business_name,
    };
  }
}
