/**
 * StorefrontShipmentSyncService — propagate a shipped fulfillment order back to
 * its storefront order and email the buyer their tracking (Migration 0059,
 * Layer 9).
 *
 * Called (best-effort) from the pack pipeline the moment a label is purchased.
 * No-op for non-storefront orders. Idempotent: the conditional UPDATE + a
 * stable email idempotency key mean a re-run never double-emails.
 */
import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { PrismaService } from "../../common/prisma.service";
import { EmailService } from "../email/email.service";
import { storefrontTrackingTemplate } from "../email/email-templates";

@Injectable()
export class StorefrontShipmentSyncService {
  private readonly logger = new Logger(StorefrontShipmentSyncService.name);

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
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        reference: string;
        buyer_email: string;
        buyer_name: string | null;
        store_name: string | null;
        business_name: string;
      }>
    >(Prisma.sql`
      UPDATE storefront_orders so
      SET status = 'SHIPPED', tracking_number = ${info.trackingNumber},
          carrier = ${info.carrier}, shipped_at = now(), updated_at = now()
      FROM vendors v
      LEFT JOIN vendor_storefronts vs ON vs.vendor_id = v.id
      WHERE so.fulfillment_order_id = ${fulfillmentOrderId}::uuid
        AND so.vendor_id = v.id
        AND so.status <> 'SHIPPED'
      RETURNING so.id, so.reference, so.buyer_email, so.buyer_name,
                vs.display_name AS store_name, v.business_name
    `);
    const so = rows[0];
    if (!so) return; // not a storefront order, or already shipped

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
      idempotencyKey: `storefront_tracking:${so.reference}`,
    });
    if (!res.ok) {
      this.logger.warn(
        { reference: so.reference, error: res.error },
        "storefront.tracking_email.failed",
      );
    }
  }
}
