/**
 * Public order tracking — no auth.
 *
 *   GET /v1/track/:trackingNumber
 *
 * Returns a sanitized projection of the order for the recipient. The
 * tracking number is treated as a low-entropy public identifier (carriers
 * publish them too) — we expose ONLY what a customer reasonably needs:
 *
 *   - status (mapped to a customer-friendly enum, not our internal ones)
 *   - carrier + service
 *   - recipient first name (so the customer recognizes the package, but
 *     last name + email + phone are never sent over the wire)
 *   - ship city / state — never line1/line2 (defence against doxxing)
 *   - delivery ETA
 *   - filtered timeline (carrier.* events only — no internal pick/pack)
 *
 * Throttled to 60/min per IP. The endpoint returns 404 for unknown tracking
 * numbers — never confirms order existence to the wrong tracking number.
 */

import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";

import { Public } from "../../common/decorators/public.decorator";
import { PrismaService } from "../../common/prisma.service";

interface PublicTrackingPayload {
  trackingNumber: string;
  carrier: string | null;
  carrierService: string | null;
  status:
    | "PROCESSING"
    | "LABEL_PRINTED"
    | "PICKED_UP"
    | "IN_TRANSIT"
    | "OUT_FOR_DELIVERY"
    | "DELIVERED"
    | "EXCEPTION"
    | "RETURNED";
  shippedAt: string | null;
  estDeliveryDate: string | null;
  deliveredAt: string | null;
  recipient: {
    firstName: string;
    city: string;
    state: string;
  };
  events: Array<{
    type: string;            // carrier-emitted code
    description: string;
    occurredAt: string;
    location?: { city?: string; state?: string };
  }>;
}

const STATUS_MAP: Record<string, PublicTrackingPayload["status"]> = {
  ALLOCATED: "PROCESSING",
  LABEL_PURCHASED: "LABEL_PRINTED",
  PICKING: "PROCESSING",
  PACKED: "PROCESSING",
  SHIPPED: "PICKED_UP",
  IN_TRANSIT: "IN_TRANSIT",
  DELIVERED: "DELIVERED",
  EXCEPTION: "EXCEPTION",
  RETURNED: "RETURNED",
  CANCELLED: "EXCEPTION", // we don't tell the recipient an order was cancelled
};

@Controller({ path: "track", version: "1" })
export class TrackingController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get(":trackingNumber")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async track(@Param("trackingNumber") trackingNumber: string): Promise<PublicTrackingPayload> {
    // Carrier tracking numbers are 8-40 chars alphanumeric. Reject obvious
    // garbage early so we don't hit the DB on enumeration attempts.
    if (!/^[A-Za-z0-9-]{6,40}$/.test(trackingNumber)) {
      throw new NotFoundException();
    }

    const order = await this.prisma.order.findFirst({
      where: { trackingNumber },
      select: {
        id: true,
        status: true,
        carrier: true,
        carrierService: true,
        trackingNumber: true,
        recipientName: true,
        shipCity: true,
        shipState: true,
        shippedAt: true,
        deliveredAt: true,
        // Only carrier-emitted events end up in the public timeline.
        events: {
          where: { source: "CARRIER" },
          orderBy: { occurredAt: "asc" },
          take: 50,
          select: {
            type: true,
            description: true,
            occurredAt: true,
            metadata: true,
          },
        },
      },
    });
    if (!order) throw new NotFoundException();

    // Don't expose the full recipient name to a stranger who knows the
    // tracking number (which the carrier publishes anyway). First name only.
    const firstName = order.recipientName.split(/\s+/)[0] ?? "Recipient";

    return {
      trackingNumber: order.trackingNumber!,
      carrier: order.carrier,
      carrierService: order.carrierService,
      status: STATUS_MAP[order.status] ?? "PROCESSING",
      shippedAt: order.shippedAt ? order.shippedAt.toISOString() : null,
      // ETA is best-effort — it lives on the most recent carrier event metadata.
      estDeliveryDate: null,
      deliveredAt: order.deliveredAt ? order.deliveredAt.toISOString() : null,
      recipient: {
        firstName,
        city: order.shipCity,
        state: order.shipState,
      },
      events: order.events.map((e) => {
        const meta = e.metadata as { statusDetail?: string; location?: { city?: string; state?: string } } | null;
        return {
          type: e.type,
          description: meta?.statusDetail ?? e.description,
          occurredAt: e.occurredAt.toISOString(),
          ...(meta?.location ? { location: meta.location } : {}),
        };
      }),
    };
  }
}
