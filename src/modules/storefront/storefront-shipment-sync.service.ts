/**
 * StorefrontShipmentSyncService — propagate a shipped fulfillment order back to
 * its storefront order and email the buyer their tracking (Migration 0059,
 * Layer 9).
 *
 * Called (best-effort) from the pack pipeline the moment a label is purchased.
 * No-op for non-storefront orders. Idempotent: the conditional UPDATE + a
 * stable email idempotency key mean a re-run never double-emails.
 *
 * Cross-vendor consolidation (Migration 0064/0065, feature-flagged):
 * When STOREFRONT_CONSOLIDATE_SHIPMENTS=true and the shipped order belongs to a
 * multi-vendor cart (cart_group_id set), the first leg to get a label becomes
 * the consolidation PRIMARY: its sibling legs are marked SHIPPED on the SAME
 * tracking number, their fulfillment orders are linked to the primary via
 * consolidated_into_order_id (so the pack UI knows not to buy a second label),
 * and the buyer gets ONE tracking email for the whole cart. This is OFF by
 * default; it must be verified in staging before enabling (it changes buyer-
 * facing shipment + email behaviour). See docs/proposals/
 * cross-vendor-consolidated-shipment.md.
 */
import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { PrismaService } from "../../common/prisma.service";
import { EmailService } from "../email/email.service";
import { storefrontTrackingTemplate } from "../email/email-templates";

interface ShippedStorefrontOrder {
  id: string;
  reference: string;
  buyer_email: string;
  buyer_name: string | null;
  store_name: string | null;
  business_name: string;
  cart_group_id: string | null;
}

@Injectable()
export class StorefrontShipmentSyncService {
  private readonly logger = new Logger(StorefrontShipmentSyncService.name);
  /**
   * Consolidate a cross-vendor cart into one shipment/tracking/email. OFF by
   * default — flip only after staging verification (see class docblock).
   */
  private readonly consolidateEnabled =
    (process.env.STOREFRONT_CONSOLIDATE_SHIPMENTS ?? "").toLowerCase() === "true";

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  async syncFromFulfillmentOrder(
    fulfillmentOrderId: string,
    info: { trackingNumber: string; carrier: string | null },
  ): Promise<void> {
    // Flip to SHIPPED + record tracking only if this fulfillment order belongs
    // to a storefront order that hasn't shipped yet.
    const rows = await this.prisma.$queryRaw<ShippedStorefrontOrder[]>(Prisma.sql`
      UPDATE storefront_orders so
      SET status = 'SHIPPED', tracking_number = ${info.trackingNumber},
          carrier = ${info.carrier}, shipped_at = now(), updated_at = now()
      FROM vendors v
      LEFT JOIN vendor_storefronts vs ON vs.vendor_id = v.id
      WHERE so.fulfillment_order_id = ${fulfillmentOrderId}::uuid
        AND so.vendor_id = v.id
        AND so.status <> 'SHIPPED'
      RETURNING so.id, so.reference, so.buyer_email, so.buyer_name,
                vs.display_name AS store_name, v.business_name, so.cart_group_id
    `);
    const so = rows[0];
    if (!so) return; // not a storefront order, or already shipped

    // Cross-vendor consolidation: fold the sibling legs into this shipment and
    // send a single combined email. Falls back to the per-order email below when
    // the flag is off or this isn't a multi-vendor cart.
    if (this.consolidateEnabled && so.cart_group_id) {
      try {
        await this.consolidateSiblings(fulfillmentOrderId, so.cart_group_id, info);
        await this.sendTrackingEmail(so, info, `storefront_tracking_group:${so.cart_group_id}`);
        return;
      } catch (err) {
        // Consolidation is best-effort; never fail a completed label purchase.
        // Fall through to the normal single-order email so the buyer is still
        // notified for this leg.
        this.logger.warn(
          { err: `${err}`, cartGroupId: so.cart_group_id, reference: so.reference },
          "storefront.shipment_consolidation.failed",
        );
      }
    }

    await this.sendTrackingEmail(so, info, `storefront_tracking:${so.reference}`);
  }

  /**
   * Mark the sibling legs of a cart group SHIPPED on the same tracking number
   * and link their fulfillment orders to the primary. Deliberately does NOT
   * touch the sibling fulfillment orders' status (that would fight the order
   * state-machine trigger); the pack UI uses consolidated_into_order_id to skip
   * buying a second label. Only siblings already in FULFILLING (a fulfillment
   * order exists) are folded in — never an unpaid/pending leg.
   */
  private async consolidateSiblings(
    primaryFulfillmentOrderId: string,
    cartGroupId: string,
    info: { trackingNumber: string; carrier: string | null },
  ): Promise<void> {
    // Mark the primary fulfillment order as the consolidation anchor.
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE orders SET is_consolidated_primary = true, updated_at = now()
      WHERE id = ${primaryFulfillmentOrderId}::uuid
    `);

    // Ship the sibling storefront orders on the same tracking. Exclude the
    // primary leg (already SHIPPED) and any not yet in fulfillment.
    const siblings = await this.prisma.$queryRaw<
      Array<{ reference: string; fulfillment_order_id: string | null }>
    >(Prisma.sql`
      UPDATE storefront_orders
      SET status = 'SHIPPED', tracking_number = ${info.trackingNumber},
          carrier = ${info.carrier}, shipped_at = now(), updated_at = now()
      WHERE cart_group_id = ${cartGroupId}::uuid
        AND status = 'FULFILLING'
        AND (fulfillment_order_id IS NULL
             OR fulfillment_order_id <> ${primaryFulfillmentOrderId}::uuid)
      RETURNING reference, fulfillment_order_id
    `);

    for (const s of siblings) {
      if (!s.fulfillment_order_id) continue;
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE orders
        SET consolidated_into_order_id = ${primaryFulfillmentOrderId}::uuid,
            tracking_number = ${info.trackingNumber},
            carrier = ${info.carrier},
            updated_at = now()
        WHERE id = ${s.fulfillment_order_id}::uuid
      `);
    }

    if (siblings.length > 0) {
      this.logger.log(
        { cartGroupId, consolidated: siblings.length },
        "storefront.shipment_consolidated",
      );
    }
  }

  private async sendTrackingEmail(
    so: ShippedStorefrontOrder,
    info: { trackingNumber: string; carrier: string | null },
    idempotencyKey: string,
  ): Promise<void> {
    const tpl = storefrontTrackingTemplate({
      reference: so.reference,
      storeName: so.store_name ?? so.business_name,
      trackingNumber: info.trackingNumber,
      carrier: info.carrier ?? "",
      buyerName: so.buyer_name,
    });
    const res = await this.email.send({
      to: so.buyer_email,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      type: "storefront.tracking",
      idempotencyKey,
    });
    if (!res.ok) {
      this.logger.warn(
        { reference: so.reference, error: res.error },
        "storefront.tracking_email.failed",
      );
    }
  }
}
