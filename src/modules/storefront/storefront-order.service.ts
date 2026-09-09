/**
 * StorefrontOrderService — storefront order lifecycle (Migration 0059).
 *
 * The single authority that flips an order to PAID. That transition happens
 * ONLY from a signature-verified processor webhook (Layer 6), is idempotent
 * (a duplicate webhook updates zero rows), and only after the charged amount +
 * currency match our record. On success it commits the soft-reserved stock
 * (available − qty, reserved − qty) so inventory reflects the sale, and hands
 * off to fulfillment (wired in Layer 7).
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
import { storefrontRefundTemplate } from "../email/email-templates";

import type { ParsedPaymentEvent, ProcessorKey } from "../payments/payment-processor.interface";
import { PaymentProcessorRegistry } from "../payments/payment-processor.registry";
import { StorefrontFulfillmentService } from "./storefront-fulfillment.service";

interface OrderRow {
  id: string;
  reference: string;
  status: string;
  total_cents: number;
  currency: string;
  items: Array<{ productId: string; qty: number }>;
}

export interface MarkPaidResult {
  handled: boolean;
  reason?: "not_paid_event" | "order_not_found" | "amount_mismatch" | "already_processed";
  orderId?: string;
  reference?: string;
}

@Injectable()
export class StorefrontOrderService {
  private readonly logger = new Logger(StorefrontOrderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fulfillment: StorefrontFulfillmentService,
    private readonly registry: PaymentProcessorRegistry,
    private readonly email: EmailService,
  ) {}

  /**
   * Admin-initiated refund of a storefront order (full or partial). Refunds via
   * the original processor, marks the order REFUNDED (idempotent), and — if it
   * hasn't shipped yet — restocks the items and cancels the fulfillment order so
   * the warehouse doesn't ship it. Emails the buyer a confirmation.
   */
  async refund(
    reference: string,
    actorId: string,
    amountCents?: number,
  ): Promise<{ refundId: string; amountCents: number }> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        status: string;
        processor: string;
        payment_ref: string | null;
        total_cents: number;
        items: Array<{ allocations?: Array<{ skuId: string; qty: number }> }>;
        buyer_email: string;
        buyer_name: string | null;
        vendor_id: string;
        fulfillment_order_id: string | null;
        store_name: string | null;
        business_name: string;
      }>
    >(Prisma.sql`
      SELECT so.id, so.status, so.processor, so.payment_ref, so.total_cents, so.items,
             so.buyer_email, so.buyer_name, so.vendor_id, so.fulfillment_order_id,
             vs.display_name AS store_name, v.business_name
      FROM storefront_orders so
      JOIN vendors v ON v.id = so.vendor_id
      LEFT JOIN vendor_storefronts vs ON vs.vendor_id = so.vendor_id
      WHERE so.reference = ${reference}
      LIMIT 1
    `);
    const o = rows[0];
    if (!o) {
      throw new NotFoundException({ message: "Order not found.", code: "storefront_order_not_found" });
    }
    if (o.status === "REFUNDED") {
      throw new ConflictException({ message: "This order is already refunded.", code: "already_refunded" });
    }
    const REFUNDABLE = new Set(["PAID", "FULFILLING", "SHIPPED", "DELIVERED"]);
    if (!REFUNDABLE.has(o.status)) {
      throw new BadRequestException({
        message: "This order can't be refunded in its current state.",
        code: "not_refundable",
        status: o.status,
      });
    }
    if (!o.payment_ref) {
      throw new BadRequestException({ message: "No payment reference on this order.", code: "no_payment_ref" });
    }
    const amount = amountCents ?? o.total_cents;
    if (amount <= 0 || amount > o.total_cents) {
      throw new BadRequestException({ message: "Invalid refund amount.", code: "invalid_refund_amount" });
    }
    const full = amount === o.total_cents;

    // Refund via the processor first — if this throws, nothing local changes.
    const { refundId } = await this.registry.get(o.processor as ProcessorKey).refund({
      paymentRef: o.payment_ref,
      amountCents: full ? undefined : amount,
      reason: "requested_by_customer",
    });

    // Not yet shipped → safe to restock + cancel the pending fulfillment order.
    const notShipped = o.status === "PAID" || o.status === "FULFILLING";

    await this.prisma.$transaction(async (tx) => {
      const upd = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        UPDATE storefront_orders SET status = 'REFUNDED', updated_at = now()
        WHERE id = ${o.id}::uuid AND status <> 'REFUNDED'
        RETURNING id
      `);
      if (upd.length === 0) return; // raced with another refund

      if (notShipped && full) {
        // Release reserved stock back to available.
        for (const item of o.items ?? []) {
          for (const a of item.allocations ?? []) {
            await tx.$executeRaw(Prisma.sql`
              UPDATE skus
              SET quantity_reserved = GREATEST(0, quantity_reserved - ${a.qty}),
                  quantity_available = quantity_available + ${a.qty},
                  updated_at = now()
              WHERE id = ${a.skuId}
            `);
            await tx.inventoryMovement.create({
              data: {
                vendorId: o.vendor_id,
                skuId: a.skuId,
                type: "RELEASE",
                deltaAvailable: a.qty,
                deltaReserved: -a.qty,
                referenceType: "storefront_order",
                referenceId: o.id,
                actorId,
              },
            });
          }
        }
        // Cancel the pending fulfillment order so the warehouse won't ship it.
        if (o.fulfillment_order_id) {
          await tx.$executeRaw(Prisma.sql`
            UPDATE orders SET status = 'CANCELLED'::"OrderStatus", updated_at = now()
            WHERE id = ${o.fulfillment_order_id}::uuid
              AND status NOT IN ('SHIPPED'::"OrderStatus", 'DELIVERED'::"OrderStatus", 'CANCELLED'::"OrderStatus")
          `);
          await tx.$executeRaw(Prisma.sql`
            UPDATE order_lines SET allocation_status = 'CANCELLED', updated_at = now()
            WHERE order_id = ${o.fulfillment_order_id}::uuid
          `);
        }
      }
    });

    // Best-effort buyer notification.
    const tpl = storefrontRefundTemplate({
      reference,
      storeName: o.store_name ?? o.business_name,
      amountCents: amount,
      buyerName: o.buyer_name,
    });
    await this.email
      .send({
        to: o.buyer_email,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
        type: "storefront.refund",
        idempotencyKey: `storefront_refund:${reference}:${refundId}`,
      })
      .catch(() => undefined);

    this.logger.log({ reference, amount, refundId }, "storefront.order.refunded");
    return { refundId, amountCents: amount };
  }

  /**
   * Idempotently mark an order paid from a verified webhook event, then bridge
   * it into the fulfillment pipeline. Stock was already reserved at checkout, so
   * this only flips the status (the first webhook wins) and creates the
   * fulfillment order. Safe to call repeatedly for the same event.
   */
  async markPaidFromEvent(event: ParsedPaymentEvent): Promise<MarkPaidResult> {
    if (event.type !== "paid") return { handled: false, reason: "not_paid_event" };

    const order = await this.findOrder(event);
    if (!order) {
      this.logger.warn(
        { paymentRef: event.paymentRef, reference: event.reference },
        "storefront.webhook.order_not_found",
      );
      return { handled: false, reason: "order_not_found" };
    }

    // Verify the money matches before trusting the event.
    if (
      event.amountCents != null &&
      (event.amountCents !== order.total_cents ||
        (event.currency ?? "USD").toUpperCase() !== order.currency.toUpperCase())
    ) {
      this.logger.error(
        {
          reference: order.reference,
          expected: order.total_cents,
          got: event.amountCents,
        },
        "storefront.webhook.amount_mismatch",
      );
      return { handled: false, reason: "amount_mismatch", orderId: order.id };
    }

    // Conditional flip — only the first webhook wins (stock was already
    // reserved + committed at checkout, so nothing else changes here).
    const updated = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      UPDATE storefront_orders
      SET status = 'PAID', paid_at = now(),
          payment_ref = COALESCE(payment_ref, ${event.paymentRef}), updated_at = now()
      WHERE id = ${order.id}::uuid AND status = 'PENDING_PAYMENT'
      RETURNING id
    `);
    if (updated.length === 0) {
      return { handled: false, reason: "already_processed", orderId: order.id };
    }

    this.logger.log({ reference: order.reference }, "storefront.order.paid");

    // Bridge into the fulfillment pipeline (its own transaction; idempotent).
    try {
      await this.fulfillment.createForPaidOrder(order.id);
    } catch (err) {
      // The money is captured + the order is PAID; a fulfillment hiccup must not
      // fail the webhook. Log for our own re-drive rather than asking the
      // processor to retry the (already-applied) payment.
      this.logger.error(
        { err: `${err}`, reference: order.reference },
        "storefront.order.fulfillment_bridge_failed",
      );
    }

    return { handled: true, orderId: order.id, reference: order.reference };
  }

  // ---------------------------------------------------------------------------
  // Records — read models for vendor + admin accounts (Layer 9)
  // ---------------------------------------------------------------------------

  /** A vendor's own storefront orders (most recent first). */
  async listForVendor(vendorId: string) {
    return this.prisma.$queryRaw(Prisma.sql`
      SELECT reference, buyer_email, buyer_name, status, processor,
             product_subtotal_cents, discount_cents, shipping_cents, shipping_speed,
             total_cents, tracking_number, carrier, created_at, paid_at, shipped_at
      FROM storefront_orders
      WHERE vendor_id = ${vendorId}::uuid
      ORDER BY created_at DESC
      LIMIT 200
    `);
  }

  /** One storefront order (vendor-scoped) with its line snapshot. */
  async getForVendor(vendorId: string, reference: string) {
    const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT reference, buyer_email, buyer_name, buyer_phone, ship_address, items,
             status, processor, product_subtotal_cents, discount_code, discount_cents,
             shipping_cents, shipping_speed, platform_fee_cents, total_cents,
             tracking_number, carrier, created_at, paid_at, shipped_at
      FROM storefront_orders
      WHERE vendor_id = ${vendorId}::uuid AND reference = ${reference}
      LIMIT 1
    `);
    return rows[0] ?? null;
  }

  /** Admin view across all vendors, optionally filtered by status. */
  async adminList(opts: { status?: string } = {}) {
    return this.prisma.$queryRaw(Prisma.sql`
      SELECT so.reference, so.vendor_id, v.business_name, so.buyer_email, so.status,
             so.processor, so.total_cents, so.shipping_speed, so.shipping_cents,
             so.tracking_number, so.carrier, so.created_at, so.paid_at, so.shipped_at
      FROM storefront_orders so
      JOIN vendors v ON v.id = so.vendor_id
      ${opts.status ? Prisma.sql`WHERE so.status = ${opts.status}` : Prisma.empty}
      ORDER BY so.created_at DESC
      LIMIT 300
    `);
  }

  private async findOrder(event: ParsedPaymentEvent): Promise<OrderRow | null> {
    // Prefer the processor payment ref; fall back to the SF order reference.
    const rows = await this.prisma.$queryRaw<OrderRow[]>(Prisma.sql`
      SELECT id, reference, status, total_cents, currency, items
      FROM storefront_orders
      WHERE (${event.paymentRef}::text IS NOT NULL AND payment_ref = ${event.paymentRef})
         OR (${event.reference}::text IS NOT NULL AND reference = ${event.reference})
      ORDER BY created_at DESC
      LIMIT 1
    `);
    return rows[0] ?? null;
  }
}
