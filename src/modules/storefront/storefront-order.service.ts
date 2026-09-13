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

    // Unified: also claw back the vendor's payout (their product share) so the
    // refund doesn't come out of USA Errands' pocket. Best-effort — a rail that
    // can't reverse (e.g. Flutterwave) is logged for manual clawback; the buyer
    // refund above already succeeded.
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
      }>
    >(Prisma.sql`
      SELECT id, reference, status, total_cents, platform_fee_cents, currency,
             vendor_id, processor, payout_status
      FROM storefront_orders
      WHERE cart_group_id = ${cartGroupId}::uuid
      ORDER BY created_at ASC
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
      // Pay the vendor their share — best-effort; a payout hiccup must not fail
      // the webhook (the buyer has paid). Failed payouts are marked FAILED for a
      // later retry/admin action.
      await this.payoutVendor(o).catch((err) =>
        this.logger.error({ err: `${err}`, reference: o.reference }, "storefront.cart.payout_failed"),
      );
    }

    this.logger.log({ cartGroupId, subOrders: subs.length }, "storefront.cart.paid_distributed");
    return { handled: true, reference: `CART-${cartGroupId}` };
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
