/**
 * WooCommerceWebhookService — direct WooCommerce → USA Errands ingestion.
 *
 * A vendor pastes a per-vendor webhook URL (carrying an unguessable token) into
 * WooCommerce → Settings → Advanced → Webhooks, topic "Order created". Woo then
 * POSTs its native order object straight to us — no middleman (Shipbubble) and
 * no plugin. This service resolves the vendor from the URL token, maps Woo's
 * order shape into our platform-neutral integration schema, and hands it to the
 * same IntegrationOrderService.ingest() the API uses, so stock reservation,
 * holds, wallet debit and idempotency all behave identically.
 *
 * Design choices:
 *  - Only PAID orders are ingested (Woo status `processing` or `completed`);
 *    anything else (pending, on-hold, failed, cancelled, refunded) is ACKed and
 *    skipped so we don't pull in unpaid/abandoned carts.
 *  - We ALWAYS answer 200 for a valid token, even when the order is held or the
 *    payload is unusable — otherwise WooCommerce counts failures and disables
 *    the webhook after a few. Problems are logged, never bounced back.
 */

import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { integrationOrderSchema } from "../../common/schemas/integration.schema";
import { PrismaService } from "../../common/prisma.service";

import { IntegrationOrderService } from "./integration-order.service";

/** Loose shape of the fields we read from a WooCommerce order webhook body. */
interface WooAddress {
  first_name?: string;
  last_name?: string;
  address_1?: string;
  address_2?: string;
  city?: string;
  state?: string;
  postcode?: string;
  country?: string;
  email?: string;
  phone?: string;
}
interface WooOrder {
  id?: number | string;
  number?: string;
  status?: string;
  billing?: WooAddress;
  shipping?: WooAddress;
  line_items?: Array<{
    name?: string;
    product_id?: number | string;
    quantity?: number;
    sku?: string;
  }>;
}

@Injectable()
export class WooCommerceWebhookService {
  private readonly logger = new Logger(WooCommerceWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: IntegrationOrderService,
  ) {}

  /** Resolve a vendor id from the URL webhook token, or null if unknown. */
  async vendorIdForToken(token: string): Promise<string | null> {
    if (!token || token.length < 16 || token.length > 128) return null;
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM vendors WHERE woocommerce_webhook_token = ${token} LIMIT 1
    `);
    return rows[0]?.id ?? null;
  }

  /**
   * Handle one WooCommerce webhook delivery for a resolved vendor. Returns a
   * short status string for logging; the controller always answers 200.
   */
  async handle(vendorId: string, body: unknown): Promise<string> {
    const order = (body ?? {}) as WooOrder;

    // WooCommerce fires a "ping" with a near-empty body when a webhook is first
    // saved — ignore anything without an id + line items.
    const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
    if (order.id == null || lineItems.length === 0) {
      return "ignored_ping_or_empty";
    }

    // Only ingest paid orders.
    const status = String(order.status ?? "").toLowerCase();
    if (status !== "processing" && status !== "completed") {
      return `skipped_status_${status || "unknown"}`;
    }

    const ship = order.shipping ?? {};
    const bill = order.billing ?? {};
    // Prefer the shipping address; fall back to billing when shipping is blank
    // (common when a store doesn't collect a separate shipping address).
    const hasShip = !!(ship.address_1 && String(ship.address_1).trim());
    const addr = hasShip ? ship : bill;

    const name = `${addr.first_name ?? bill.first_name ?? ""} ${
      addr.last_name ?? bill.last_name ?? ""
    }`.trim();

    const candidate = {
      externalReference: String(order.id),
      recipient: {
        name,
        phone: bill.phone ?? ship.phone ?? undefined,
        email: bill.email ?? undefined,
        line1: addr.address_1 ?? "",
        line2: addr.address_2 || undefined,
        city: addr.city ?? "",
        state: addr.state ?? "",
        postalCode: addr.postcode ?? "",
        country: addr.country ?? "US",
      },
      // Every line keeps a value for `sku` so a missing-SKU line holds as
      // UNMAPPED (visible to ops) rather than failing the whole order.
      lines: lineItems.map((li) => ({
        sku: (li.sku && String(li.sku).trim()) || `WC-${li.product_id ?? "unknown"}`,
        quantity: typeof li.quantity === "number" && li.quantity > 0 ? li.quantity : 1,
        name: li.name ? String(li.name).slice(0, 200) : undefined,
      })),
      fulfillmentMode: "PLATFORM_SHIP" as const,
    };

    const parsed = integrationOrderSchema.safeParse(candidate);
    if (!parsed.success) {
      // Don't 400 back to WooCommerce (it would disable the webhook). Log the
      // first problem so ops can see why this order couldn't be shaped.
      this.logger.warn(
        {
          vendorId,
          externalReference: candidate.externalReference,
          issue: parsed.error.issues[0]?.message,
        },
        "WooCommerce order could not be mapped to a valid order",
      );
      return "unmappable_payload";
    }

    await this.orders.ingest({ vendorId, apiKeyId: null, input: parsed.data });
    return "ingested";
  }
}
