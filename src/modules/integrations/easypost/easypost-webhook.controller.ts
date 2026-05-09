/**
 * EasyPost tracking webhook.
 *
 * Implementation Plan §6.6.3.
 *
 *   1. Verify the HMAC signature (defence: a forged tracking event must NEVER
 *      transition an order's status).
 *   2. Dedup by webhook_events unique(provider, event_id) — same event id
 *      delivered twice is a no-op the second time.
 *   3. Match the event to an order by trackingNumber. If not found, log + 200
 *      (so EasyPost stops retrying).
 *   4. Apply the status mapping. Forward-only — DELIVERED is terminal, the
 *      DB trigger will refuse anything backward.
 *
 * The endpoint is @Public — no Bearer token. Rate-limited so a flood can't
 * overwhelm us. Body is the raw JSON; we don't trust the unsigned shape.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { OrderStatus } from "@prisma/client";
import type { Request } from "express";

import { Public } from "../../../common/decorators/public.decorator";
import { PrismaService } from "../../../common/prisma.service";
import { orderDeliveredTemplate } from "../../email/email-templates";
import { NotificationService } from "../../notifications/notification.service";

import { EasyPostService } from "./easypost.service";

interface EasyPostTrackerPayload {
  id?: string;
  description?: string;
  result?: {
    object?: string;
    tracking_code?: string;
    status?: string;
    status_detail?: string;
    est_delivery_date?: string | null;
    signed_by?: string | null;
    tracking_details?: Array<{
      object_id?: string;
      status?: string;
      status_detail?: string;
      message?: string;
      datetime?: string;
      tracking_location?: { city?: string; state?: string; country?: string };
    }>;
  };
}

const STATUS_MAP: Record<string, OrderStatus> = {
  // EasyPost emits these on the tracker.status field.
  pre_transit: "LABEL_PURCHASED",
  in_transit: "IN_TRANSIT",
  out_for_delivery: "IN_TRANSIT",
  delivered: "DELIVERED",
  available_for_pickup: "IN_TRANSIT",
  return_to_sender: "EXCEPTION",
  failure: "EXCEPTION",
  cancelled: "EXCEPTION",
  error: "EXCEPTION",
  unknown: "IN_TRANSIT",
};

@Controller({ path: "webhooks/easypost", version: "1" })
export class EasyPostWebhookController {
  private readonly log = new Logger(EasyPostWebhookController.name);

  constructor(
    private readonly easypost: EasyPostService,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  @Public()
  @Post()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  async receive(
    @Req() req: Request,
    @Headers("x-hmac-signature") signatureHeader: string | undefined,
    @Body() payload: EasyPostTrackerPayload,
  ): Promise<{ received: true; deduped?: boolean }> {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody?.toString("utf8") ?? JSON.stringify(payload);

    if (!this.easypost.verifyWebhookSignature(rawBody, signatureHeader)) {
      throw new BadRequestException({ code: "easypost_signature_invalid", message: "Invalid signature." });
    }

    const eventId = payload.id ?? `noid-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Idempotent log via unique(provider, event_id). On dup-key (P2002) we
    // know this is a replay — ack with `deduped: true` and bail.
    try {
      await this.prisma.webhookEvent.create({
        data: { provider: "easypost", eventId, payload: payload as unknown as object },
      });
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") {
        return { received: true, deduped: true };
      }
      throw err;
    }

    try {
      await this.applyEvent(payload);
      await this.prisma.webhookEvent.updateMany({
        where: { provider: "easypost", eventId },
        data: { processedAt: new Date() },
      });
    } catch (err) {
      const msg = (err as Error).message ?? "unknown";
      this.log.error({ err: msg, eventId }, "EasyPost webhook handler failed");
      await this.prisma.webhookEvent
        .updateMany({
          where: { provider: "easypost", eventId },
          data: { error: msg.slice(0, 500) },
        })
        .catch(() => undefined);
      throw err;
    }

    return { received: true };
  }

  // ---------------------------------------------------------------------------

  private async applyEvent(payload: EasyPostTrackerPayload): Promise<void> {
    const trackingCode = payload.result?.tracking_code;
    const carrierStatus = payload.result?.status;
    if (!trackingCode || !carrierStatus) {
      this.log.warn({ payload }, "EasyPost event missing tracking_code or status — skipped");
      return;
    }

    const order = await this.prisma.order.findFirst({ where: { trackingNumber: trackingCode } });
    if (!order) {
      this.log.warn({ trackingCode }, "No matching order — ignoring tracking event");
      return;
    }

    const targetStatus = STATUS_MAP[carrierStatus];
    if (!targetStatus) {
      this.log.warn({ carrierStatus }, "Unknown EasyPost status — ignoring");
      return;
    }

    // Terminal-state guard: the DB trigger will reject DELIVERED → anything,
    // so we silently no-op once delivered.
    if (order.status === "DELIVERED" || order.status === "CANCELLED" || order.status === "RETURNED") {
      return;
    }

    // Don't downgrade. e.g. once SHIPPED, ignore a delayed pre_transit event.
    const RANK: Record<OrderStatus, number> = {
      DRAFT: 0,
      SUBMITTED: 1,
      ALLOCATED: 2,
      LABEL_PURCHASED: 3,
      PICKING: 4,
      PACKED: 5,
      SHIPPED: 6,
      IN_TRANSIT: 7,
      EXCEPTION: 7,
      DELIVERED: 8,
      RETURNED: 9,
      CANCELLED: 9,
    };
    if (RANK[targetStatus] < RANK[order.status]) {
      // Still record the event for the timeline, but don't change status.
      await this.prisma.orderEvent.create({
        data: {
          orderId: order.id,
          type: `carrier.${carrierStatus}`,
          description: payload.result?.status_detail ?? `Carrier event: ${carrierStatus}`,
          source: "CARRIER",
          metadata: { trackingCode, statusDetail: payload.result?.status_detail ?? null },
        },
      });
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      const data: Record<string, unknown> = { status: targetStatus };
      if (targetStatus === "DELIVERED") data.deliveredAt = new Date();
      if (targetStatus === "IN_TRANSIT" && !order.shippedAt) data.shippedAt = new Date();

      await tx.order.update({ where: { id: order.id }, data });
      await tx.orderEvent.create({
        data: {
          orderId: order.id,
          type: `carrier.${carrierStatus}`,
          description: payload.result?.status_detail ?? `Carrier event: ${carrierStatus}`,
          source: "CARRIER",
          metadata: {
            trackingCode,
            statusDetail: payload.result?.status_detail ?? null,
            estDeliveryDate: payload.result?.est_delivery_date ?? null,
            signedBy: payload.result?.signed_by ?? null,
          },
        },
      });
    });

    // Vendor delivery notification — only on the actual SHIPPED → DELIVERED
    // transition (not on duplicate webhook delivery, since the rank guard
    // above already short-circuits those). Best-effort.
    if (targetStatus === "DELIVERED") {
      void this.notifyOrderDelivered(order.id).catch(() => undefined);
    }
  }

  /**
   * Send the vendor an "order delivered" email + in-app notification.
   * Re-fetches the order to get the canonical externalReference / vendor.
   */
  private async notifyOrderDelivered(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, externalReference: true, vendorId: true },
    });
    if (!order) return;
    const tpl = orderDeliveredTemplate({
      orderRef: order.externalReference ?? order.id.slice(0, 8),
      orderId: order.id,
    });
    await this.notifications.emit({
      vendorId: order.vendorId,
      type: "order.delivered",
      severity: "INFO",
      title: `Order ${order.externalReference ?? order.id.slice(0, 8)} delivered`,
      body: "The carrier confirmed delivery.",
      href: `/orders/${order.id}`,
      email: { subject: tpl.subject, html: tpl.html, text: tpl.text },
    });
  }
}
