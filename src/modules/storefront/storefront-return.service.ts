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

import { StorefrontOrderService } from "./storefront-order.service";

const RETURNABLE_ORDER_STATUSES = new Set(["SHIPPED", "DELIVERED"]);

@Injectable()
export class StorefrontReturnService {
  private readonly logger = new Logger(StorefrontReturnService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: StorefrontOrderService,
    private readonly email: EmailService,
  ) {}

  /** Buyer requests a return on their own order (matched by their email). */
  async requestReturn(
    buyerEmail: string,
    orderReference: string,
    reason: string,
  ): Promise<{ reference: string; status: string }> {
    const email = buyerEmail.trim().toLowerCase();
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        status: string;
        shipped_at: Date | null;
        buyer_name: string | null;
        store_name: string | null;
        business_name: string;
        returns_allowed: boolean | null;
        return_window_days: number | null;
      }>
    >(Prisma.sql`
      SELECT so.id, so.status, so.shipped_at, so.buyer_name,
             vs.display_name AS store_name, v.business_name,
             vs.returns_allowed, vs.return_window_days
      FROM storefront_orders so
      JOIN vendors v ON v.id = so.vendor_id
      LEFT JOIN vendor_storefronts vs ON vs.vendor_id = so.vendor_id
      WHERE so.reference = ${orderReference} AND lower(so.buyer_email) = ${email}
      LIMIT 1
    `);
    const order = rows[0];
    if (!order) {
      throw new NotFoundException({ message: "Order not found.", code: "storefront_order_not_found" });
    }
    if (!RETURNABLE_ORDER_STATUSES.has(order.status)) {
      throw new BadRequestException({
        message: "Returns can be requested once an order has shipped.",
        code: "order_not_returnable",
        status: order.status,
      });
    }

    // Vendor-declared returns policy. Defaults (allowed, 30 days) apply when the
    // storefront row predates the policy columns.
    const returnsAllowed = order.returns_allowed ?? true;
    if (!returnsAllowed) {
      throw new BadRequestException({
        message: "This store doesn't accept returns.",
        code: "returns_not_accepted",
      });
    }
    const windowDays = order.return_window_days ?? 30;
    // Count the window from shipment (fall back to now if unset, i.e. no bar yet).
    if (order.shipped_at) {
      const deadline = new Date(order.shipped_at).getTime() + windowDays * 24 * 60 * 60 * 1000;
      if (Date.now() > deadline) {
        throw new BadRequestException({
          message: `The ${windowDays}-day return window for this order has passed.`,
          code: "return_window_expired",
          windowDays,
        });
      }
    }

    let reference: string;
    try {
      const refRow = await this.prisma.$queryRaw<Array<{ n: bigint }>>(
        Prisma.sql`SELECT nextval('storefront_return_ref_seq') AS n`,
      );
      reference = `SR-${String(Number(refRow[0]!.n)).padStart(6, "0")}`;
      await this.prisma.$executeRaw(Prisma.sql`
        INSERT INTO storefront_return_requests
          (reference, storefront_order_id, buyer_email, status, reason, created_at, updated_at)
        VALUES (${reference}, ${order.id}::uuid, ${email}, 'REQUESTED', ${reason}, now(), now())
      `);
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

    this.logger.log({ reference, orderReference }, "storefront.return.requested");
    return { reference, status: "REQUESTED" };
  }

  /** Admin queue of return requests (optionally filtered by status). */
  async adminList(opts: { status?: string } = {}) {
    return this.prisma.$queryRaw(Prisma.sql`
      SELECT rr.id, rr.reference, rr.status, rr.reason, rr.resolution_note,
             rr.refund_id, rr.refunded_cents, rr.created_at, rr.resolved_at,
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
