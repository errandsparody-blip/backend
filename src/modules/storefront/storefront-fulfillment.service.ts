/**
 * StorefrontFulfillmentService — bridges a PAID storefront order into the
 * existing v2 fulfillment pipeline (Migration 0059, Layer 7).
 *
 * A PAID storefront order becomes a normal workflowVersion=2, PENDING_PACKING
 * order, so the warehouse packs it and the label is purchased AT PACK TIME with
 * the real dimensions/weight (the checkout shipping figure was only an
 * estimate). Two deliberate differences from the vendor/integration path:
 *   - Stock is NOT reserved again: checkout already reserved the exact SKUs
 *     (persisted as allocations on the storefront order), so we only attach
 *     OrderLines to that reservation.
 *   - Shipping is NOT charged to the vendor: the buyer paid delivery at
 *     checkout, so the platform buys the label at pack with no vendor debit.
 *   - The fulfillment fee IS charged to the vendor's wallet here, using the
 *     SAME WalletService.debit(type: FULFILLMENT) a normal order uses at
 *     submit. The buyer never pays fulfillment; the vendor does, exactly as on
 *     a normal order. Debit + order creation share one transaction, so either
 *     both commit or both roll back (a short wallet leaves the order unbridged
 *     to retry once funded — no partial state).
 *
 * Warehouse visibility: the amount the buyer paid + the speed they chose are
 * written into the order's sourcePayload so any order view can surface them.
 */
import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { OrderStatus } from "@prisma/client";

import { fulfillmentFeeForUnits, loadFeeSchedule } from "../../common/fees";
import { PrismaService } from "../../common/prisma.service";
import { opsNewOrderTemplate, storefrontVendorSaleTemplate } from "../email/email-templates";
import { NotificationService } from "../notifications/notification.service";
import { OpsAlertService } from "../notifications/ops-alert.service";
import { WalletService } from "../wallet/wallet.service";

interface StoredItem {
  productId: string;
  code: string;
  variant: string;
  name: string;
  qty: number;
  unitDeclaredValueCents: number;
  allocations: Array<{ skuId: string; qty: number }>;
}

interface StorefrontOrderFull {
  id: string;
  reference: string;
  vendor_id: string;
  buyer_email: string;
  buyer_name: string | null;
  buyer_phone: string | null;
  ship_address: {
    recipientName: string;
    line1: string;
    line2?: string | null;
    city: string;
    state: string;
    postalCode: string;
    country: string;
    phone?: string | null;
  };
  items: StoredItem[];
  shipping_speed: string;
  shipping_cents: number;
  total_cents: number;
  platform_fee_cents: number;
  cart_group_id: string | null;
  fulfillment_order_id: string | null;
}

@Injectable()
export class StorefrontFulfillmentService {
  private readonly logger = new Logger(StorefrontFulfillmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly opsAlerts: OpsAlertService,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * Create the fulfillment order for a paid storefront order, idempotently
   * (skips if already linked). Returns the fulfillment order id.
   */
  async createForPaidOrder(storefrontOrderId: string): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<StorefrontOrderFull[]>(Prisma.sql`
      SELECT id, reference, vendor_id, buyer_email, buyer_name, buyer_phone,
             ship_address, items, shipping_speed, shipping_cents, total_cents,
             platform_fee_cents, cart_group_id, fulfillment_order_id
      FROM storefront_orders WHERE id = ${storefrontOrderId}::uuid
    `);
    const so = rows[0];
    if (!so) return null;
    if (so.fulfillment_order_id) return so.fulfillment_order_id; // already bridged

    const addr = so.ship_address;
    const itemsDeclaredValueCents = so.items.reduce(
      (sum, it) =>
        sum +
        it.allocations.reduce((s, a) => s + it.unitDeclaredValueCents * a.qty, 0),
      0,
    );

    // Fulfillment fee for THIS vendor's units, from the same schedule normal
    // orders use. Charged to the vendor's wallet below (buyer never pays it).
    const schedule = await loadFeeSchedule(this.prisma);
    const units = so.items.reduce((s, it) => s + it.qty, 0);
    const fulfillmentFeeCents = fulfillmentFeeForUnits(units, schedule);

    const orderId = await this.prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          vendorId: so.vendor_id,
          source: "STOREFRONT",
          externalReference: so.reference,
          status: "PENDING_PACKING" as OrderStatus,
          recipientName: addr.recipientName,
          recipientPhone: addr.phone ?? so.buyer_phone ?? null,
          recipientEmail: so.buyer_email,
          shipAddressLine1: addr.line1,
          shipAddressLine2: addr.line2 ?? null,
          shipCity: addr.city,
          shipState: addr.state,
          shipPostalCode: addr.postalCode,
          shipCountry: addr.country,
          addressValidationStatus: "ACCEPTED",
          submittedAt: new Date(),
          allocatedAt: null,
          createdBy: null,
          // Buyer funded delivery (platform ships, so no vendor shipping debit).
          // The vendor IS charged the fulfillment fee via the wallet below, so
          // it's recorded on the order exactly like a normal order.
          itemsDeclaredValueCents,
          shippingCostCents: 0,
          shippingFeeCents: 0,
          fulfillmentFeeCents,
          insuranceFeeCents: 0,
          totalChargedCents: fulfillmentFeeCents,
          // The label is bought at pack with real dims; this is the estimate.
          estimatedShippingMinCents: so.shipping_cents,
          estimatedShippingMaxCents: so.shipping_cents,
          workflowVersion: 2,
          fulfillmentMode: "PLATFORM_SHIP",
          // Warehouse visibility: what the buyer paid + the speed chosen.
          sourcePayload: {
            storefrontReference: so.reference,
            paidTotalCents: so.total_cents,
            shippingSpeed: so.shipping_speed,
            shippingEstimateCents: so.shipping_cents,
            // Cross-vendor cart linkage: when set, this order ships together with
            // the other orders sharing this cartGroupId (one physical delivery).
            // The warehouse groups by this id; buyer paid shipping once (on the
            // leg where shippingEstimateCents > 0).
            ...(so.cart_group_id ? { cartGroupId: so.cart_group_id, shipsTogether: true } : {}),
          } as Prisma.InputJsonValue,
        } as unknown as Prisma.OrderCreateInput,
        select: { id: true },
      });

      // Promote the cart-group link onto the fulfillment order so the warehouse
      // can query/pack the group as one shipment (raw UPDATE keeps this working
      // even before the Prisma client is regenerated with the new column).
      if (so.cart_group_id) {
        await tx.$executeRaw(Prisma.sql`
          UPDATE orders SET cart_group_id = ${so.cart_group_id}::uuid
          WHERE id = ${created.id}::uuid
        `);
      }

      // Charge the vendor the fulfillment fee — SAME wallet debit a normal
      // order uses at submit. In the same transaction as the order create, so a
      // short wallet (ConflictException insufficient_funds) rolls the whole
      // bridge back and the order stays unbridged to retry once funded.
      if (fulfillmentFeeCents > 0) {
        await this.wallet.debit(
          {
            vendorId: so.vendor_id,
            amountCents: fulfillmentFeeCents,
            type: "FULFILLMENT",
            description: `Fulfillment fee for storefront order ${so.reference} (${units} unit${units === 1 ? "" : "s"})`,
            referenceType: "order",
            referenceId: created.id,
          },
          tx as unknown as Parameters<typeof this.wallet.debit>[1],
        );
      }

      for (const it of so.items) {
        for (const alloc of it.allocations) {
          await tx.orderLine.create({
            data: {
              orderId: created.id,
              vendorId: so.vendor_id,
              productId: it.productId,
              skuId: alloc.skuId,
              productCode: it.code,
              productName: it.name,
              variant: it.variant,
              quantity: alloc.qty,
              declaredValueCents: it.unitDeclaredValueCents * alloc.qty,
              allocationStatus: "RESERVED",
            },
          });
          // Audit the reservation (the stock move happened at checkout) tied to
          // this order so the SHIP decrement later reconciles cleanly.
          await tx.inventoryMovement.create({
            data: {
              vendorId: so.vendor_id,
              skuId: alloc.skuId,
              type: "RESERVE",
              deltaAvailable: -alloc.qty,
              deltaReserved: alloc.qty,
              referenceType: "storefront_order",
              referenceId: so.id,
              actorId: null,
            },
          });
        }
      }

      await tx.$executeRaw(Prisma.sql`
        UPDATE storefront_orders
        SET fulfillment_order_id = ${created.id}::uuid, status = 'FULFILLING', updated_at = now()
        WHERE id = ${so.id}::uuid
      `);
      return created.id;
    });

    this.logger.log(
      { reference: so.reference, orderId },
      "storefront.order.fulfillment_created",
    );

    // Ops/admin alert — SAME opsNewOrderTemplate a normal order fires on
    // creation, so the ops inbox + in-app queue see storefront orders exactly
    // like any other new order. Best-effort; a failed alert never affects the
    // order (the buyer has already paid).
    void (async () => {
      try {
        const vendor = await this.prisma.vendor.findUnique({
          where: { id: so.vendor_id },
          select: { businessName: true },
        });
        const tpl = opsNewOrderTemplate({
          orderId,
          orderRef: so.reference,
          vendorBusinessName: vendor?.businessName ?? "(unknown vendor)",
          lineCount: so.items.length,
          totalChargedCents: fulfillmentFeeCents,
        });
        await this.opsAlerts.send({
          type: "ops.order.new",
          subject: tpl.subject,
          html: tpl.html,
          text: tpl.text,
          idempotencyKey: `ops:order:new:${orderId}`,
          href: `/admin/orders/${orderId}`,
        });

        // Notify the VENDOR they made a sale — in-app notification + email to
        // their active users (best-effort; never blocks the order).
        const earningsCents = Math.max(0, so.total_cents - so.platform_fee_cents);
        const sale = storefrontVendorSaleTemplate({
          businessName: vendor?.businessName ?? "there",
          orderRef: so.reference,
          units,
          earningsCents,
        });
        await this.notifications.emit({
          vendorId: so.vendor_id,
          type: "storefront.sale",
          title: "You made a sale",
          // USA Errands fulfils storefront orders — the vendor just earns. Point
          // them at their storefront earnings, not a fulfillment queue.
          body: `Order ${so.reference} — ${units} item${units === 1 ? "" : "s"}. We'll handle fulfillment; your earnings are in your storefront wallet.`,
          href: `/storefront`,
          email: { subject: sale.subject, html: sale.html, text: sale.text },
        });
      } catch {
        /* fire-and-forget */
      }
    })();

    return orderId;
  }
}
