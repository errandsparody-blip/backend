/**
 * Shippo tracking webhook.
 *
 * Implementation Plan §6.6.3. Replaces the earlier EasyPost webhook.
 *
 *   1. Verify the path-secret on the URL query string (`?secret=…`). This
 *      is Shippo's only built-in webhook auth surface — they don't HMAC
 *      payloads. Constant-time compare so timing attacks can't reveal it.
 *
 *   2. Dedup by webhook_events unique(provider, event_id). Same event id
 *      delivered twice is a no-op the second time.
 *
 *   3. Defense in depth — Shippo doesn't sign payloads, so even after the
 *      path-secret matches we re-fetch the tracker from Shippo's API and
 *      trust the API response's status over the webhook payload's claim.
 *      A forged event whose tracker doesn't exist in Shippo gets dropped.
 *
 *   4. Apply the status mapping. Forward-only; the DB trigger refuses
 *      anything backward.
 *
 * The endpoint is @Public — no Bearer token, only the path secret. Rate-
 * limited so a flood can't overwhelm us.
 */

import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { OrderStatus } from "@prisma/client";

import { Public } from "../../../common/decorators/public.decorator";
import { formatOrderRef } from "../../../common/order-ref";
import { PrismaService } from "../../../common/prisma.service";
import { orderDeliveredTemplate } from "../../email/email-templates";
import { NotificationService } from "../../notifications/notification.service";

import { ShippoService } from "./shippo.service";

interface ShippoTrackUpdatedPayload {
  /** "track_updated" — the only event type we subscribe to. */
  event?: string;
  /** Shippo emits a top-level id on webhook deliveries we use for dedup. */
  data?: {
    /** Shippo's tracker resource id (not the carrier tracking number). */
    object_id?: string;
    carrier?: string;
    tracking_number?: string;
    tracking_status?: {
      status?: string;
      status_details?: string | null;
      status_date?: string | null;
      location?: { city?: string; state?: string; country?: string } | null;
    } | null;
  };
}

const STATUS_MAP: Record<string, OrderStatus> = {
  // Canonical Shippo statuses, lowercased.
  pre_transit: "LABEL_PURCHASED",
  transit: "IN_TRANSIT",
  delivered: "DELIVERED",
  returned: "EXCEPTION",
  failure: "EXCEPTION",
  unknown: "IN_TRANSIT",
};

@Controller({ path: "webhooks/shippo", version: "1" })
export class ShippoWebhookController {
  private readonly log = new Logger(ShippoWebhookController.name);

  constructor(
    private readonly shippo: ShippoService,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  @Public()
  @Post()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  async receive(
    @Query("secret") secret: string | undefined,
    @Body() payload: ShippoTrackUpdatedPayload,
  ): Promise<{ received: true; deduped?: boolean; ignored?: string }> {
    // 1. Path-secret check — cheap reject of obvious forgeries.
    if (!this.shippo.verifyWebhookSecret(secret)) {
      throw new BadRequestException({
        code: "shippo_secret_invalid",
        message: "Invalid webhook secret.",
      });
    }

    const eventId = this.deriveEventId(payload);

    // 2. Idempotent log via unique(provider, event_id).
    try {
      await this.prisma.webhookEvent.create({
        data: { provider: "shippo", eventId, payload: payload as unknown as object },
      });
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") {
        return { received: true, deduped: true };
      }
      throw err;
    }

    try {
      const ignored = await this.applyEvent(payload);
      await this.prisma.webhookEvent.updateMany({
        where: { provider: "shippo", eventId },
        data: { processedAt: new Date() },
      });
      return ignored ? { received: true, ignored } : { received: true };
    } catch (err) {
      const msg = (err as Error).message ?? "unknown";
      this.log.error({ err: msg, eventId }, "Shippo webhook handler failed");
      await this.prisma.webhookEvent
        .updateMany({
          where: { provider: "shippo", eventId },
          data: { error: msg.slice(0, 500) },
        })
        .catch(() => undefined);
      throw err;
    }
  }

  // ---------------------------------------------------------------------------

  private deriveEventId(payload: ShippoTrackUpdatedPayload): string {
    // Shippo includes the tracker resource id on every delivery for the
    // same tracker. We combine with the status to allow N status transitions
    // for the same tracker (each is a distinct event), while still
    // deduping replays of the SAME status.
    const trackerId = payload.data?.object_id ?? "no-tracker";
    const status = payload.data?.tracking_status?.status ?? "no-status";
    const statusDate = payload.data?.tracking_status?.status_date ?? "no-date";
    return `${trackerId}:${status}:${statusDate}`;
  }

  /**
   * Apply the tracking event to the matching order. Returns a short reason
   * string when the event was deliberately skipped (so callers / tests can
   * see *why* nothing changed).
   */
  private async applyEvent(payload: ShippoTrackUpdatedPayload): Promise<string | undefined> {
    const trackingCode = payload.data?.tracking_number;
    const carrier = payload.data?.carrier;
    if (!trackingCode || !carrier) {
      this.log.warn({ payload }, "Shippo event missing tracking_number or carrier — skipped");
      return "missing_tracker";
    }

    // 3. API callback verification — re-fetch the tracker from Shippo. If
    // the API doesn't know this tracker, the event was either forged or
    // refers to a tracker that's been deleted; either way we drop it.
    const verified = await this.shippo.getTracker(carrier, trackingCode);
    // In stub mode `getTracker` returns null — fall back to the payload's
    // claim so tests can drive the controller without a network round-trip.
    const status = verified
      ? verified.status
      : payload.data?.tracking_status?.status?.toLowerCase() ?? "unknown";
    const statusDetail =
      verified?.statusDetail ?? payload.data?.tracking_status?.status_details ?? null;
    const statusDate =
      verified?.statusDate ?? payload.data?.tracking_status?.status_date ?? null;

    if (this.shippo.isLive() && !verified) {
      this.log.warn(
        { trackingCode, carrier },
        "Shippo API did not recognise tracker — dropping event",
      );
      return "tracker_unknown_to_provider";
    }

    const order = await this.prisma.order.findFirst({
      where: { trackingNumber: trackingCode },
    });
    if (!order) {
      this.log.warn({ trackingCode }, "No matching order — ignoring tracking event");
      return "no_matching_order";
    }

    const targetStatus = STATUS_MAP[status];
    if (!targetStatus) {
      this.log.warn({ status }, "Unknown Shippo status — ignoring");
      return "unknown_status";
    }

    // Terminal-state guard.
    if (order.status === "DELIVERED" || order.status === "CANCELLED" || order.status === "RETURNED") {
      return "order_terminal";
    }

    // Don't downgrade. e.g. once SHIPPED, ignore a delayed pre_transit event.
    //
    // Migration 0037 — HANDED_OFF is a terminal success state for
    // VENDOR_CARRIER orders. Those orders never carry a Shippo label
    // and Shippo will never emit a tracking webhook for them, so in
    // practice we should never reach this RANK lookup with a
    // HANDED_OFF order. We still include it (at the same rank as
    // DELIVERED) so a spurious webhook can't downgrade the status.
    //
    // The type is `Partial<Record<OrderStatus, number>>` rather than the
    // exhaustive variant so the file builds in both environments where
    // the Prisma client may be slightly out of sync with the schema
    // (sandbox regen blocked by binaries.prisma.sh; Railway regen
    // succeeds at deploy time). The defaultRank fallback below makes
    // missing keys SAFE — any unmapped status is treated as terminal
    // (Number.MAX_SAFE_INTEGER), so a webhook for an unknown status
    // can never be ranked LOWER than a known one and therefore can't
    // accidentally advance the order.
    // Plain string-keyed map (not Partial<Record<OrderStatus, number>>)
    // because the Prisma client may be one schema-bump behind the
    // application code in CI / local sandboxes. Casting to the strict
    // type would surface a stale-client error here without adding
    // safety, since `rankOf` already falls back for unmapped keys.
    const RANK: Record<string, number> = {
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
      HANDED_OFF: 8,
      RETURNED: 9,
      CANCELLED: 9,
    };
    const rankOf = (s: OrderStatus): number =>
      RANK[s as string] ?? Number.MAX_SAFE_INTEGER;
    if (rankOf(targetStatus) < rankOf(order.status)) {
      // Still record the event for the timeline.
      await this.prisma.orderEvent.create({
        data: {
          orderId: order.id,
          type: `carrier.${status}`,
          description: statusDetail ?? `Carrier event: ${status}`,
          source: "CARRIER",
          metadata: { trackingCode, statusDetail: statusDetail ?? null },
        },
      });
      return "rank_not_forward";
    }

    await this.prisma.$transaction(async (tx) => {
      const data: Record<string, unknown> = { status: targetStatus };
      if (targetStatus === "DELIVERED") data.deliveredAt = new Date();
      if (targetStatus === "IN_TRANSIT" && !order.shippedAt) data.shippedAt = new Date();

      await tx.order.update({ where: { id: order.id }, data });
      await tx.orderEvent.create({
        data: {
          orderId: order.id,
          type: `carrier.${status}`,
          description: statusDetail ?? `Carrier event: ${status}`,
          source: "CARRIER",
          metadata: {
            trackingCode,
            statusDetail: statusDetail ?? null,
            statusDate: statusDate ?? null,
          },
        },
      });
    });

    if (targetStatus === "DELIVERED") {
      void this.notifyOrderDelivered(order.id).catch(() => undefined);
    }
    return undefined;
  }

  private async notifyOrderDelivered(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, orderNumber: true, vendorId: true },
    });
    if (!order) return;
    const ref = formatOrderRef(order.orderNumber);
    const tpl = orderDeliveredTemplate({
      orderRef: ref,
      orderId: order.id,
    });
    await this.notifications.emit({
      vendorId: order.vendorId,
      type: "order.delivered",
      severity: "INFO",
      title: `Order ${ref} delivered`,
      body: "The carrier confirmed delivery.",
      href: `/orders/${order.id}`,
      email: { subject: tpl.subject, html: tpl.html, text: tpl.text },
    });
  }
}
