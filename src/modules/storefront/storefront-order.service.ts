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
import { storefrontOrderConfirmedTemplate, storefrontRefundTemplate } from "../email/email-templates";

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
  buyer_email: string;
  buyer_name: string | null;
  store_name: string | null;
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
        platform_fee_cents: number;
        collector_processor: string | null;
        payout_transfer_id: string | null;
        payout_status: string;
        items: Array<{ allocations?: Array<{ skuId: string; qty: number }> }>;
        buyer_email: string;
        buyer_name: string | null;
        vendor_id: string;
        fulfillment_order_id: string | null;
        store_name: string | null;
        business_name: string;
      }>
    >(Prisma.sql`
      SELECT so.id, so.status, so.processor, so.payment_ref, so.total_cents,
             so.platform_fee_cents, so.collector_processor, so.payout_transfer_id,
             so.payout_status, so.items,
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

    // Refund via the rail that COLLECTED the money. For a unified cart the buyer
    // paid the platform's collector on one charge, so refund there (always a
    // partial of the shared charge = this sub-order's amount). For a direct
    // charge, refund the vendor rail (full or partial).
    const isUnified = !!o.collector_processor;
    const refundRail = (isUnified ? o.collector_processor : o.processor) as ProcessorKey;
    const { refundId } = await this.registry.get(refundRail).refund({
      paymentRef: o.payment_ref,
      amountCents: isUnified ? amount : full ? undefined : amount,
      reason: "requested_by_customer",
    });

    // Unified + still HELD: the vendor was never paid (their share is held on the
    // platform balance), so a refund just cancels the hold — no clawback at all.
    // This is the fast path the return window is designed for.
    if (isUnified && (o.payout_status === "HELD" || o.payout_status === "PENDING")) {
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE storefront_orders SET payout_status = 'CANCELLED', payout_release_at = NULL, updated_at = now()
        WHERE id = ${o.id}::uuid AND payout_status IN ('HELD', 'PENDING')
      `);
    }

    // Unified + already PAID: claw back the vendor's payout (their product share)
    // so the refund doesn't come out of USA Errands' pocket. Best-effort — a rail
    // that can't reverse (e.g. Flutterwave) is logged for manual clawback; the
    // buyer refund above already succeeded. This only happens for returns that
    // land after the hold window has released the payout.
    if (isUnified && o.payout_transfer_id && o.payout_status === "PAID") {
      const vendorShare = Math.max(0, o.total_cents - o.platform_fee_cents);
      const reverseCents = Math.min(amount, vendorShare);
      if (reverseCents > 0) {
        try {
          await this.registry.get(o.processor as ProcessorKey).reverseTransfer({
            transferId: o.payout_transfer_id,
            amountCents: reverseCents,
            reference,
          });
        } catch (err) {
          this.logger.error(
            { err: `${err}`, reference, transferId: o.payout_transfer_id },
            "storefront.refund.transfer_reversal_failed",
          );
        }
      }
    }

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

    // Unified cart charge (collect-then-payout): the reference is CART-<groupId>.
    // Mark every sub-order paid and pay each vendor their share.
    if (event.reference && event.reference.startsWith("CART-")) {
      return this.distributeCartPayment(event.reference.slice("CART-".length), event);
    }

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

    // Buyer confirmation + receipt (best-effort; idempotent per order).
    const confirm = storefrontOrderConfirmedTemplate({
      buyerName: order.buyer_name,
      orders: [{ reference: order.reference, storeName: order.store_name, totalCents: order.total_cents }],
      grandTotalCents: order.total_cents,
    });
    await this.email
      .send({
        to: order.buyer_email,
        subject: confirm.subject,
        html: confirm.html,
        text: confirm.text,
        type: "storefront.order_confirmed",
        idempotencyKey: `storefront_confirmed:${order.reference}`,
      })
      .catch(() => undefined);

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

    // Hold the vendor's share on the platform balance for their return window
    // (or a 24h buffer if they take no returns), so a refund/cancel during the
    // window is instant + clawback-free. No-op for legacy direct-charge orders
    // (payout_status NONE). Best-effort; a hiccup must not fail the webhook.
    await this.holdVendorPayout(order.id).catch((err) =>
      this.logger.error({ err: `${err}`, reference: order.reference }, "storefront.order.hold_failed"),
    );

    return { handled: true, orderId: order.id, reference: order.reference };
  }

  /**
   * Unified cart (collect-then-payout): the platform took ONE charge for the
   * whole cart. Mark every sub-order paid + bridge to fulfillment (as for a
   * direct charge), then pay each vendor their product share out of the platform
   * balance. Idempotent throughout: the paid-flip is conditional per row, and the
   * payout is guarded by `payout_status` + a processor idempotency key, so a
   * duplicate webhook never double-pays a vendor.
   */
  private async distributeCartPayment(
    cartGroupId: string,
    event: ParsedPaymentEvent,
  ): Promise<MarkPaidResult> {
    const subs = await this.prisma.$queryRaw<
      Array<{
        id: string;
        reference: string;
        status: string;
        total_cents: number;
        platform_fee_cents: number;
        currency: string;
        vendor_id: string;
        processor: string;
        payout_status: string;
        buyer_email: string;
        buyer_name: string | null;
        store_name: string | null;
        returns_allowed: boolean | null;
        return_window_days: number | null;
      }>
    >(Prisma.sql`
      SELECT so.id, so.reference, so.status, so.total_cents, so.platform_fee_cents, so.currency,
             so.vendor_id, so.processor, so.payout_status,
             so.buyer_email, so.buyer_name,
             COALESCE(vs.display_name, v.business_name) AS store_name,
             vs.returns_allowed, vs.return_window_days
      FROM storefront_orders so
      JOIN vendors v ON v.id = so.vendor_id
      LEFT JOIN vendor_storefronts vs ON vs.vendor_id = so.vendor_id
      WHERE so.cart_group_id = ${cartGroupId}::uuid
      ORDER BY so.created_at ASC
    `);
    if (subs.length === 0) {
      this.logger.warn({ cartGroupId }, "storefront.webhook.cart_not_found");
      return { handled: false, reason: "order_not_found" };
    }

    // The single platform charge must equal the sum of the sub-order totals.
    const expectedTotal = subs.reduce((s, o) => s + o.total_cents, 0);
    if (
      event.amountCents != null &&
      (event.amountCents !== expectedTotal ||
        (event.currency ?? "USD").toUpperCase() !== (subs[0]!.currency || "USD").toUpperCase())
    ) {
      this.logger.error(
        { cartGroupId, expected: expectedTotal, got: event.amountCents },
        "storefront.webhook.cart_amount_mismatch",
      );
      return { handled: false, reason: "amount_mismatch" };
    }

    for (const o of subs) {
      const flipped = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        UPDATE storefront_orders
        SET status = 'PAID', paid_at = now(),
            payment_ref = COALESCE(payment_ref, ${event.paymentRef}), updated_at = now()
        WHERE id = ${o.id}::uuid AND status = 'PENDING_PAYMENT'
        RETURNING id
      `);
      if (flipped.length > 0) {
        try {
          await this.fulfillment.createForPaidOrder(o.id);
        } catch (err) {
          this.logger.error(
            { err: `${err}`, reference: o.reference },
            "storefront.order.fulfillment_bridge_failed",
          );
        }
      }
      // Hold the vendor's share for their return window (or a 24h buffer when
      // they take no returns), so refunds during the window are instant and
      // clawback-free. Best-effort; a hiccup must not fail the webhook.
      await this.holdVendorPayout(o.id).catch((err) =>
        this.logger.error({ err: `${err}`, reference: o.reference }, "storefront.cart.payout_failed"),
      );
    }

    // One buyer confirmation + receipt for the whole cart (best-effort;
    // idempotent per cart group).
    const grandTotalCents = subs.reduce((s, o) => s + o.total_cents, 0);
    const confirm = storefrontOrderConfirmedTemplate({
      buyerName: subs[0]!.buyer_name,
      orders: subs.map((o) => ({ reference: o.reference, storeName: o.store_name, totalCents: o.total_cents })),
      grandTotalCents,
    });
    await this.email
      .send({
        to: subs[0]!.buyer_email,
        subject: confirm.subject,
        html: confirm.html,
        text: confirm.text,
        type: "storefront.order_confirmed",
        idempotencyKey: `storefront_confirmed:CART-${cartGroupId}`,
      })
      .catch(() => undefined);

    this.logger.log({ cartGroupId, subOrders: subs.length }, "storefront.cart.paid_distributed");
    return { handled: true, reference: `CART-${cartGroupId}` };
  }

  /**
   * At payment time, HOLD the vendor's share on the platform balance until it's
   * safe to release: their full return window if they take returns, otherwise a
   * 24h buffer (a cancel/refund can still happen right after purchase). Sets
   * payout_status = 'HELD' + payout_release_at; the hourly release sweep pays it
   * out once the window passes with no open return. A refund during the window
   * just cancels the hold — no clawback, so the business never pays a vendor
   * money it might have to refund. Only acts on a PENDING row (set when the order
   * was collected to the platform), so a duplicate webhook never re-holds, and
   * it's a no-op for legacy direct-charge orders (payout_status NONE).
   */
  private async holdVendorPayout(orderId: string): Promise<void> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        payout_status: string;
        returns_allowed: boolean | null;
        return_window_days: number | null;
      }>
    >(Prisma.sql`
      SELECT so.payout_status, vs.returns_allowed, vs.return_window_days
      FROM storefront_orders so
      LEFT JOIN vendor_storefronts vs ON vs.vendor_id = so.vendor_id
      WHERE so.id = ${orderId}::uuid
    `);
    const o = rows[0];
    if (!o || o.payout_status !== "PENDING") return;
    // Return window in hours if the vendor takes returns; else a 24h buffer.
    const holdHours = (o.returns_allowed ?? true)
      ? Math.max(1, o.return_window_days ?? 30) * 24
      : 24;
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE storefront_orders
      SET payout_status = 'HELD',
          payout_release_at = now() + (${holdHours} * interval '1 hour'),
          updated_at = now()
      WHERE id = ${orderId}::uuid AND payout_status = 'PENDING'
    `);
  }

  /**
   * Transfer one vendor's product share (total − platform fee) from the platform
   * balance to their connected account. Idempotent: only acts when
   * payout_status = 'PENDING', and the transfer itself is keyed on the sub-order
   * reference. Marks PAID (with the transfer id) or FAILED.
   */
  private async payoutVendor(o: {
    id: string;
    reference: string;
    total_cents: number;
    platform_fee_cents: number;
    currency: string;
    vendor_id: string;
    processor: string;
    payout_status: string;
  }): Promise<void> {
    if (o.payout_status !== "PENDING") return; // direct charge, or already handled
    const amountCents = o.total_cents - o.platform_fee_cents; // vendor product share
    if (amountCents <= 0) {
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE storefront_orders SET payout_status = 'PAID', updated_at = now()
        WHERE id = ${o.id}::uuid AND payout_status = 'PENDING'
      `);
      return;
    }
    const acct = await this.prisma.$queryRaw<
      Array<{ external_account_id: string | null; bank_code: string | null; account_number: string | null }>
    >(
      Prisma.sql`
        SELECT external_account_id, bank_code, account_number FROM vendor_payout_accounts
        WHERE vendor_id = ${o.vendor_id}::uuid AND processor = ${o.processor} AND status = 'ACTIVE'
        LIMIT 1
      `,
    );
    const row = acct[0];
    // Stripe pays to the connected-account id; Flutterwave to the stored bank
    // details. Fail loudly if the needed destination is missing.
    const ext = row?.external_account_id;
    if (!ext && !(row?.bank_code && row?.account_number)) {
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE storefront_orders SET payout_status = 'FAILED', updated_at = now()
        WHERE id = ${o.id}::uuid AND payout_status = 'PENDING'
      `);
      this.logger.error({ reference: o.reference }, "storefront.cart.payout_no_account");
      return;
    }
    try {
      const { transferId } = await this.registry.get(o.processor as ProcessorKey).transferToVendor({
        externalAccountId: ext ?? "",
        amountCents,
        currency: o.currency || "USD",
        reference: o.reference,
        bankCode: row?.bank_code ?? undefined,
        accountNumber: row?.account_number ?? undefined,
      });
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE storefront_orders
        SET payout_status = 'PAID', payout_transfer_id = ${transferId}, updated_at = now()
        WHERE id = ${o.id}::uuid AND payout_status = 'PENDING'
      `);
    } catch (err) {
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE storefront_orders SET payout_status = 'FAILED', updated_at = now()
        WHERE id = ${o.id}::uuid AND payout_status = 'PENDING'
      `);
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Records — read models for vendor + admin accounts (Layer 9)
  // ---------------------------------------------------------------------------

  /** A vendor's own storefront orders (most recent first). */
  async listForVendor(vendorId: string) {
    return this.prisma.$queryRaw(Prisma.sql`
      SELECT reference, buyer_email, buyer_name, status, processor,
             product_subtotal_cents, discount_cents, shipping_cents, shipping_speed,
             total_cents, tracking_number, carrier, payout_status, payout_release_at,
             created_at, paid_at, shipped_at
      FROM storefront_orders
      WHERE vendor_id = ${vendorId}::uuid
      ORDER BY created_at DESC
      LIMIT 200
    `);
  }

  /**
   * Vendor storefront earnings wallet. The vendor's share of each paid order
   * (total − platform fee) is recognised immediately and grouped by where the
   * money is: HELD/PENDING = held on the platform balance (paying out on
   * payout_release_at), PAID = already sent to their account. Refunded/cancelled
   * holds drop out. Gives the vendor a clear "you've earned X, Y is on the way,
   * Z has paid out" without exposing platform internals.
   */
  async earningsForVendor(vendorId: string): Promise<{
    heldCents: number;
    paidCents: number;
    currency: string;
    upcoming: Array<{ reference: string; amountCents: number; releaseAt: string | null; status: string }>;
    recentPaid: Array<{ reference: string; amountCents: number; paidAt: string | null }>;
  }> {
    const totals = await this.prisma.$queryRaw<
      Array<{ held_cents: bigint | null; paid_cents: bigint | null }>
    >(Prisma.sql`
      SELECT
        COALESCE(SUM(total_cents - platform_fee_cents) FILTER (WHERE payout_status IN ('HELD','PENDING')), 0) AS held_cents,
        COALESCE(SUM(total_cents - platform_fee_cents) FILTER (WHERE payout_status = 'PAID'), 0) AS paid_cents
      FROM storefront_orders
      WHERE vendor_id = ${vendorId}::uuid
    `);
    const upcoming = await this.prisma.$queryRaw<
      Array<{ reference: string; amount_cents: number; release_at: Date | null; payout_status: string }>
    >(Prisma.sql`
      SELECT reference, (total_cents - platform_fee_cents) AS amount_cents, payout_release_at AS release_at, payout_status
      FROM storefront_orders
      WHERE vendor_id = ${vendorId}::uuid AND payout_status IN ('HELD','PENDING')
      ORDER BY payout_release_at ASC NULLS LAST, created_at ASC
      LIMIT 100
    `);
    const recentPaid = await this.prisma.$queryRaw<
      Array<{ reference: string; amount_cents: number; paid_at: Date | null }>
    >(Prisma.sql`
      SELECT reference, (total_cents - platform_fee_cents) AS amount_cents, paid_at
      FROM storefront_orders
      WHERE vendor_id = ${vendorId}::uuid AND payout_status = 'PAID'
      ORDER BY updated_at DESC
      LIMIT 50
    `);
    return {
      heldCents: Number(totals[0]?.held_cents ?? 0),
      paidCents: Number(totals[0]?.paid_cents ?? 0),
      currency: "USD",
      upcoming: upcoming.map((r) => ({
        reference: r.reference,
        amountCents: Number(r.amount_cents),
        releaseAt: r.release_at ? r.release_at.toISOString() : null,
        status: r.payout_status,
      })),
      recentPaid: recentPaid.map((r) => ({
        reference: r.reference,
        amountCents: Number(r.amount_cents),
        paidAt: r.paid_at ? r.paid_at.toISOString() : null,
      })),
    };
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
             so.tracking_number, so.carrier, so.payout_status, so.payout_release_at,
             so.created_at, so.paid_at, so.shipped_at
      FROM storefront_orders so
      JOIN vendors v ON v.id = so.vendor_id
      ${opts.status ? Prisma.sql`WHERE so.status = ${opts.status}` : Prisma.empty}
      ORDER BY so.created_at DESC
      LIMIT 300
    `);
  }

  /** Sub-orders whose vendor payout failed (unified cart) — for admin follow-up. */
  async listFailedPayouts() {
    return this.prisma.$queryRaw(Prisma.sql`
      SELECT so.reference, so.vendor_id, v.business_name, so.processor, so.total_cents,
             so.platform_fee_cents, so.cart_group_id, so.payout_status, so.created_at
      FROM storefront_orders so
      JOIN vendors v ON v.id = so.vendor_id
      WHERE so.payout_status = 'FAILED'
      ORDER BY so.created_at DESC
      LIMIT 200
    `);
  }

  /**
   * Retry a failed vendor payout for one sub-order. Resets it to PENDING and
   * re-runs the transfer (idempotency-keyed on the reference, so a transfer that
   * actually went through won't double-pay). Returns the resulting payout status.
   */
  async retryPayout(reference: string): Promise<{ reference: string; payoutStatus: string }> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        reference: string;
        total_cents: number;
        platform_fee_cents: number;
        currency: string;
        vendor_id: string;
        processor: string;
        payout_status: string;
      }>
    >(Prisma.sql`
      SELECT id, reference, total_cents, platform_fee_cents, currency, vendor_id,
             processor, payout_status
      FROM storefront_orders WHERE reference = ${reference} LIMIT 1
    `);
    const o = rows[0];
    if (!o) {
      throw new NotFoundException({ message: "Order not found.", code: "storefront_order_not_found" });
    }
    if (o.payout_status !== "FAILED") {
      throw new BadRequestException({
        message: `Payout is '${o.payout_status}', not FAILED — nothing to retry.`,
        code: "payout_not_failed",
      });
    }
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE storefront_orders SET payout_status = 'PENDING', updated_at = now()
      WHERE id = ${o.id}::uuid AND payout_status = 'FAILED'
    `);
    try {
      await this.payoutVendor({ ...o, payout_status: "PENDING" });
    } catch (err) {
      // payoutVendor already flipped the row back to FAILED on error.
      this.logger.error({ err: `${err}`, reference }, "storefront.cart.payout_retry_failed");
    }
    const after = await this.prisma.$queryRaw<Array<{ payout_status: string }>>(
      Prisma.sql`SELECT payout_status FROM storefront_orders WHERE id = ${o.id}::uuid`,
    );
    return { reference, payoutStatus: after[0]?.payout_status ?? "UNKNOWN" };
  }

  /**
   * Retry FAILED vendor payouts (unified cart) at least `maxAgeMinutes` old.
   * Bounded per run; idempotent (the transfer is keyed on the sub-order ref).
   * Returns how many were retried.
   */
  async sweepFailedPayouts(maxAgeMinutes = 30, limit = 100): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ reference: string }>>(Prisma.sql`
      SELECT reference FROM storefront_orders
      WHERE payout_status = 'FAILED'
        AND updated_at < now() - (${maxAgeMinutes} * interval '1 minute')
      ORDER BY updated_at ASC
      LIMIT ${limit}
    `);
    let attempted = 0;
    for (const r of rows) {
      try {
        await this.retryPayout(r.reference);
        attempted++;
      } catch (err) {
        this.logger.warn(
          { err: `${err}`, reference: r.reference },
          "storefront.cart.payout_sweep_retry_failed",
        );
      }
    }
    if (attempted > 0) this.logger.log({ attempted }, "storefront.cart.payout_sweep");
    return attempted;
  }

  /**
   * Release ONE held vendor payout immediately, ignoring the window (admin/demo
   * action — it moves money). Flips HELD → PENDING then pays via payoutVendor.
   */
  async releaseHeldPayout(reference: string): Promise<{ reference: string; payoutStatus: string }> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        reference: string;
        total_cents: number;
        platform_fee_cents: number;
        currency: string;
        vendor_id: string;
        processor: string;
        payout_status: string;
      }>
    >(Prisma.sql`
      SELECT id, reference, total_cents, platform_fee_cents, currency, vendor_id,
             processor, payout_status
      FROM storefront_orders WHERE reference = ${reference} LIMIT 1
    `);
    const o = rows[0];
    if (!o) {
      throw new NotFoundException({ message: "Order not found.", code: "storefront_order_not_found" });
    }
    if (o.payout_status !== "HELD") {
      throw new BadRequestException({
        message: `Payout is '${o.payout_status}', not HELD — nothing to release.`,
        code: "payout_not_held",
      });
    }
    const claimed = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      UPDATE storefront_orders SET payout_status = 'PENDING', updated_at = now()
      WHERE id = ${o.id}::uuid AND payout_status = 'HELD'
      RETURNING id
    `);
    if (claimed.length === 0) {
      // Lost the race (another release/refund got there first).
      const after = await this.prisma.$queryRaw<Array<{ payout_status: string }>>(
        Prisma.sql`SELECT payout_status FROM storefront_orders WHERE id = ${o.id}::uuid`,
      );
      return { reference, payoutStatus: after[0]?.payout_status ?? "UNKNOWN" };
    }
    try {
      await this.payoutVendor({ ...o, payout_status: "PENDING" });
    } catch (err) {
      this.logger.error({ err: `${err}`, reference }, "storefront.cart.release_now_failed");
    }
    const after = await this.prisma.$queryRaw<Array<{ payout_status: string }>>(
      Prisma.sql`SELECT payout_status FROM storefront_orders WHERE id = ${o.id}::uuid`,
    );
    return { reference, payoutStatus: after[0]?.payout_status ?? "UNKNOWN" };
  }

  /**
   * Release vendor payouts whose HOLD window has elapsed (Migration 0071).
   * Pays HELD sub-orders where payout_release_at has passed, the order is still
   * in a paid/fulfilling/shipped/delivered state, and there's no open return
   * request. Flips HELD → PENDING then pays (idempotent via payoutVendor + the
   * per-reference transfer key). Bounded per run. Returns how many were released.
   */
  async releaseHeldPayouts(limit = 100): Promise<number> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        reference: string;
        total_cents: number;
        platform_fee_cents: number;
        currency: string;
        vendor_id: string;
        processor: string;
      }>
    >(Prisma.sql`
      SELECT so.id, so.reference, so.total_cents, so.platform_fee_cents, so.currency,
             so.vendor_id, so.processor
      FROM storefront_orders so
      WHERE so.payout_status = 'HELD'
        AND so.payout_release_at IS NOT NULL
        AND so.payout_release_at <= now()
        AND so.status IN ('PAID', 'FULFILLING', 'SHIPPED', 'DELIVERED')
        AND NOT EXISTS (
          SELECT 1 FROM storefront_return_requests rr
          WHERE rr.storefront_order_id = so.id AND rr.status = 'REQUESTED'
        )
      ORDER BY so.payout_release_at ASC
      LIMIT ${limit}
    `);
    let released = 0;
    for (const o of rows) {
      // Flip HELD → PENDING, then pay. The conditional UPDATE means only one
      // worker/run can claim a given held row.
      const claimed = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        UPDATE storefront_orders SET payout_status = 'PENDING', updated_at = now()
        WHERE id = ${o.id}::uuid AND payout_status = 'HELD'
        RETURNING id
      `);
      if (claimed.length === 0) continue;
      try {
        await this.payoutVendor({ ...o, payout_status: "PENDING" });
        released++;
      } catch (err) {
        // payoutVendor already flipped the row to FAILED; the retry sweep handles it.
        this.logger.warn({ err: `${err}`, reference: o.reference }, "storefront.cart.release_failed");
      }
    }
    if (released > 0) this.logger.log({ released }, "storefront.cart.payout_released");
    return released;
  }

  private async findOrder(event: ParsedPaymentEvent): Promise<OrderRow | null> {
    // Prefer the processor payment ref; fall back to the SF order reference.
    const rows = await this.prisma.$queryRaw<OrderRow[]>(Prisma.sql`
      SELECT so.id, so.reference, so.status, so.total_cents, so.currency, so.items,
             so.buyer_email, so.buyer_name,
             COALESCE(vs.display_name, v.business_name) AS store_name
      FROM storefront_orders so
      JOIN vendors v ON v.id = so.vendor_id
      LEFT JOIN vendor_storefronts vs ON vs.vendor_id = so.vendor_id
      WHERE (${event.paymentRef}::text IS NOT NULL AND so.payment_ref = ${event.paymentRef})
         OR (${event.reference}::text IS NOT NULL AND so.reference = ${event.reference})
      ORDER BY so.created_at DESC
      LIMIT 1
    `);
    return rows[0] ?? null;
  }
}
