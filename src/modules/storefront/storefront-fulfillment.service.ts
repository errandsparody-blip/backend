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
 *   - The vendor wallet is NOT debited: the buyer already paid shipping +
 *     fulfillment, so charging the vendor would double-bill.
 *
 * Warehouse visibility: the amount the buyer paid + the speed they chose are
 * written into the order's sourcePayload so any order view can surface them.
 */
import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { OrderStatus } from "@prisma/client";

import { PrismaService } from "../../common/prisma.service";

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
  fulfillment_order_id: string | null;
}

@Injectable()
export class StorefrontFulfillmentService {
  private readonly logger = new Logger(StorefrontFulfillmentService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create the fulfillment order for a paid storefront order, idempotently
   * (skips if already linked). Returns the fulfillment order id.
   */
  async createForPaidOrder(storefrontOrderId: string): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<StorefrontOrderFull[]>(Prisma.sql`
      SELECT id, reference, vendor_id, buyer_email, buyer_name, buyer_phone,
             ship_address, items, shipping_speed, shipping_cents, total_cents,
             fulfillment_order_id
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
          // Buyer funded shipping + fulfillment; the vendor is not charged.
          itemsDeclaredValueCents,
          shippingCostCents: 0,
          shippingFeeCents: 0,
          fulfillmentFeeCents: 0,
          insuranceFeeCents: 0,
          totalChargedCents: 0,
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
          } as Prisma.InputJsonValue,
        } as unknown as Prisma.OrderCreateInput,
        select: { id: true },
      });

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
    return orderId;
  }
}
