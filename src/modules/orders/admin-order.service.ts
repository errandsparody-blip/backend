/**
 * AdminOrderService — operator-side fulfillment workflow.
 *
 *   ALLOCATED        → purchaseLabel()  → LABEL_PURCHASED  (carrier label bought)
 *   LABEL_PURCHASED  → pick()           → PICKING
 *   PICKING          → pack()           → PACKED
 *   PACKED           → ship()           → SHIPPED          (handed to carrier)
 *
 * The forward-only state machine is enforced THREE places:
 *   - here (status check + ConflictException on bad transition)
 *   - the OrderService.cancel logic (refuses to cancel after LABEL_PURCHASED)
 *   - the DB trigger `enforce_order_status_transition` (defence in depth)
 *
 * Every transition writes an append-only OrderEvent + an AuditLogEntry.
 *
 * Implementation Plan §6.6, §14.4.
 */

import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { Order, OrderStatus, PrismaClient } from "@prisma/client";

import { formatOrderRef } from "../../common/order-ref";
import { PrismaService } from "../../common/prisma.service";
import { CarrierPackagingRegistryService } from "../../common/services/carrier-packaging-registry";
import { AuditService } from "../audit/audit.service";
import { orderShippedTemplate } from "../email/email-templates";
import { ShippoService } from "../integrations/shippo/shippo.service";
import { NotificationService } from "../notifications/notification.service";
import { WalletService } from "../wallet/wallet.service";

type Tx = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

export interface AdminOrderListInput {
  status?: OrderStatus;
  /**
   * "queue" (default): ALLOCATED → PACKED only — the operator's working
   * set.
   * "all": no status filter, show every order so post-shipment lookups
   * and history queries work.
   */
  view?: "queue" | "all";
  from?: Date | undefined;
  to?: Date | undefined;
  cursor?: string | undefined;
  limit: number;
}

const ALLOWED_TRANSITIONS: Record<string, OrderStatus[]> = {
  purchaseLabel: ["ALLOCATED"],
  // Migration 0037 — VENDOR_CARRIER orders have no Shippo label to
  // buy, so picking can start directly from ALLOCATED for that branch.
  // The mode-specific guard inside markHandedOff() / pick() enforces
  // which orders are eligible; the union here only widens the
  // transition's starting set.
  pick: ["LABEL_PURCHASED", "ALLOCATED"],
  pack: ["PICKING"],
  ship: ["PACKED"],
  // Migration 0037 — terminal hand-off for VENDOR_CARRIER orders.
  // Same starting state as `ship` (PACKED) but skips the
  // SKU-decrement / inventory-movement bookkeeping done inside
  // ship() since that flows through the carrier reassessment + label
  // refund cron, neither of which applies here.
  handedOff: ["PACKED"],
};

@Injectable()
export class AdminOrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly shippo: ShippoService,
    private readonly notifications: NotificationService,
    private readonly wallet: WalletService,
    // Phase T1 — resolves a Shippo carrier template's friendly label
    // for the admin order-detail projection (mirrors the vendor-side
    // projection in OrderService.getById). Without it the admin sees
    // "Custom (no preset)" for every packed order regardless of what
    // the warehouse actually selected.
    private readonly carrierRegistry: CarrierPackagingRegistryService,
  ) {}

  // ---------------------------------------------------------------------------
  // Force-cancel — admin escape hatch for stuck orders.
  //
  // The normal vendor-side cancel is tenant-scoped and limited to
  // DRAFT/SUBMITTED/ALLOCATED. Admins need a wider net for orders that get
  // stranded — most commonly: an order in ALLOCATED whose label can't be
  // purchased because the recipient's address is invalid at the carrier.
  // Until address validation catches everything pre-debit, admins need a
  // way to release inventory + refund the wallet in one click.
  //
  // What it does:
  //   - releases all line reservations back to inventory
  //   - refunds the full totalChargedCents to the vendor's wallet
  //   - sets status = CANCELLED with a clear `cancel_reason`
  //   - writes audit + order event entries tagged as ADMIN-originated
  //
  // What it refuses:
  //   - orders past LABEL_PURCHASED (label already bought = real carrier
  //     debit; needs the return flow, not cancel)
  //   - orders already CANCELLED / RETURNED / DELIVERED (idempotent no-op
  //     would be confusing; ConflictException makes the state explicit)
  // ---------------------------------------------------------------------------
  async forceCancel(
    id: string,
    actorId: string,
    reason: string,
  ): Promise<Order> {
    const FORCE_CANCELLABLE: OrderStatus[] = [
      "DRAFT",
      "SUBMITTED",
      "ALLOCATED",
      "LABEL_PURCHASED",
    ];

    return this.prisma.$transaction(async (tx): Promise<{ updated: Order; before: { status: OrderStatus; totalChargedCents: number } }> => {
      // SELECT ... FOR UPDATE to prevent racing transitions.
      const lockedRows = await tx.$queryRaw<
        Array<{ id: string; vendor_id: string; status: OrderStatus; total_charged_cents: number }>
      >(
        Prisma.sql`
          SELECT id, vendor_id, status, total_charged_cents
          FROM orders
          WHERE id = ${id}::uuid
          FOR UPDATE
        `,
      );
      const locked = lockedRows[0];
      if (!locked) throw new NotFoundException();
      if (!FORCE_CANCELLABLE.includes(locked.status)) {
        throw new ConflictException({
          message: `Order in status ${locked.status} cannot be force-cancelled. Use the return flow for delivered orders.`,
          code: "order_force_cancel_blocked",
        });
      }

      const before = await tx.order.findUniqueOrThrow({
        where: { id },
        include: { lines: true },
      });

      // Release inventory reservations.
      for (const line of before.lines) {
        await tx.sku.update({
          where: { id: line.skuId },
          data: {
            quantityAvailable: { increment: line.quantity },
            quantityReserved: { decrement: line.quantity },
          },
        });
        await tx.inventoryMovement.create({
          data: {
            vendorId: before.vendorId,
            skuId: line.skuId,
            type: "RELEASE",
            deltaAvailable: line.quantity,
            deltaReserved: -line.quantity,
            referenceType: "order",
            referenceId: id,
            actorId,
            reason: `admin-force-cancel: ${reason}`,
          },
        });
        await tx.orderLine.update({
          where: { id: line.id },
          data: { allocationStatus: "CANCELLED" },
        });
      }

      // Refund the wallet for whatever was charged. Type REVERSAL keeps the
      // ledger trail clean — same path the vendor self-cancel uses.
      if (before.totalChargedCents > 0) {
        await this.wallet.credit(
          {
            vendorId: before.vendorId,
            amountCents: before.totalChargedCents,
            type: "REVERSAL",
            description: `Admin force-cancel of order ${id.slice(0, 8)}: ${reason}`,
            referenceType: "order",
            referenceId: id,
            actorId,
          },
          tx as unknown as Parameters<typeof this.wallet.credit>[1],
        );
      }

      const updated = await tx.order.update({
        where: { id },
        data: {
          status: "CANCELLED",
          // OTHER is the catch-all in the schema enum — we put the human
          // explanation in cancelNote, prefixed so it's grep-able for
          // support workflows.
          cancelReason: "OTHER",
          cancelNote: `ADMIN_FORCE_CANCEL: ${reason}`,
          cancelledAt: new Date(),
        },
      });

      await tx.orderEvent.create({
        data: {
          orderId: id,
          type: "order.force_cancelled",
          description: `Force-cancelled by admin: ${reason}`,
          source: "ADMIN",
          actorId,
        },
      });

      return {
        updated,
        before: { status: before.status, totalChargedCents: before.totalChargedCents },
      };
    }).then(async ({ updated, before }) => {
      // Audit log lives outside the transaction (its own service handles
      // its own persistence). Best-effort — failing the audit shouldn't
      // un-refund the vendor.
      await this.audit.log({
        actorId,
        action: "order.force_cancelled",
        resourceType: "order",
        resourceId: id,
        beforeState: { status: before.status, totalChargedCents: before.totalChargedCents },
        afterState: { status: "CANCELLED", reason },
      }).catch(() => undefined);
      return updated;
    });
  }

  // ---------------------------------------------------------------------------
  // Read — operator queue
  // ---------------------------------------------------------------------------

  async list(input: AdminOrderListInput) {
    // Filter precedence:
    //   1. Explicit `status` → exact match (e.g. "show me all SHIPPED orders").
    //   2. `view=all`        → no filter, every order regardless of status.
    //   3. Default           → operator queue (ALLOCATED → PACKED).
    const where: Prisma.OrderWhereInput = input.status
      ? { status: input.status }
      : input.view === "all"
        ? {}
        : { status: { in: ["ALLOCATED", "LABEL_PURCHASED", "PICKING", "PACKED"] } };

    // Date-range filter on order creation time (mirrors the audit-log viewer).
    if (input.from || input.to) {
      where.createdAt = {
        ...(input.from ? { gte: input.from } : {}),
        ...(input.to ? { lte: input.to } : {}),
      };
    }

    const orders = await this.prisma.order.findMany({
      where,
      include: {
        lines: true,
        vendor: { select: { id: true, businessName: true, country: true } },
      },
      take: input.limit + 1,
      orderBy: { createdAt: "desc" },
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    });

    let nextCursor: string | null = null;
    if (orders.length > input.limit) {
      const next = orders.pop();
      nextCursor = next?.id ?? null;
    }
    return { items: orders, nextCursor };
  }

  async get(id: string) {
    // Cast through `unknown` — the Prisma client in the sandbox may
    // not have `packagingOption` on the include yet (delegate not
    // regenerated for migration 0043 in every env). In CI the include
    // resolves; runtime Postgres returns the relation just fine.
    const includeArg = {
      lines: true,
      events: { orderBy: { occurredAt: "asc" } },
      vendor: { select: { id: true, businessName: true } },
      packagingOption: true,
    } as unknown as Parameters<typeof this.prisma.order.findUnique>[0]["include"];

    const order = await this.prisma.order.findUnique({
      where: { id },
      include: includeArg,
    });
    if (!order) throw new NotFoundException();

    // Phase T1 — Enrich the raw Prisma row with two computed fields
    // the admin detail page requires but Prisma doesn't expose
    // directly:
    //
    //   1. `packagingLabel` — friendly name of the box the operator
    //      picked. Reads through, in order: the library preset's
    //      label (if a preset was chosen), the Shippo carrier
    //      template's registered label (Option A carrier picks), or
    //      null for pure ad-hoc/custom packaging. Mirrors the
    //      vendor-facing projection in OrderService.getById so the
    //      admin and vendor see the same string.
    //
    //   2. `workflowVersion` — surfaced as a top-level number so the
    //      admin frontend can branch the next-step panel on it (v2
    //      orders finish differently than the legacy v1 ladder). The
    //      Prisma cast is defensive against a sandbox client that
    //      predates migration 0041's column add; runtime Postgres
    //      always returns it (DB default = 1).
    const raw = order as unknown as {
      workflowVersion?: number;
      parcelTemplate?: string | null;
      packagingOption?: { label?: string | null } | null;
    };
    const packagingLabel =
      raw.packagingOption?.label ??
      (raw.parcelTemplate
        ? this.carrierRegistry.getByTemplate(raw.parcelTemplate)?.label ??
          null
        : null);
    const workflowVersion = raw.workflowVersion ?? 1;

    // Migration 0055 — vendor-selected label add-ons. Read via raw SQL so
    // the admin sees the true choice even when the sandbox Prisma client
    // predates the new columns (the `...order` spread would omit them).
    const addonRows = await this.prisma.$queryRaw<
      Array<{
        insurance_requested: boolean;
        signature_required: boolean;
        adult_signature_required: boolean;
        contains_alcohol: boolean;
        alcohol_recipient_type: string | null;
        contains_dry_ice: boolean;
        dry_ice_weight_oz: number | null;
        contains_lithium: boolean;
      }>
    >(Prisma.sql`
      SELECT insurance_requested, signature_required, adult_signature_required,
             contains_alcohol, alcohol_recipient_type, contains_dry_ice,
             dry_ice_weight_oz, contains_lithium
      FROM orders WHERE id = ${id}::uuid
    `);
    const addons = addonRows[0] ?? {
      insurance_requested: false,
      signature_required: false,
      adult_signature_required: false,
      contains_alcohol: false,
      alcohol_recipient_type: null,
      contains_dry_ice: false,
      dry_ice_weight_oz: null,
      contains_lithium: false,
    };

    return {
      ...order,
      packagingLabel,
      workflowVersion,
      insuranceRequested: addons.insurance_requested,
      signatureRequired: addons.signature_required,
      adultSignatureRequired: addons.adult_signature_required,
      containsAlcohol: addons.contains_alcohol,
      alcoholRecipientType: addons.alcohol_recipient_type,
      containsDryIce: addons.contains_dry_ice,
      dryIceWeightOz: addons.dry_ice_weight_oz,
      containsLithium: addons.contains_lithium,
    };
  }

  // ---------------------------------------------------------------------------
  // Transitions
  // ---------------------------------------------------------------------------

  async purchaseLabel(id: string, actorId: string) {
    return this.transition(id, actorId, "purchaseLabel", async (tx, order) => {
      // Buy the label from the carrier. The rateProviderRef + ratePurchasedRef
      // were saved at order create time so we have everything we need.
      if (!order.rateProviderRef || !order.ratePurchasedRef) {
        throw new ConflictException({
          message: "Order is missing rate references; cannot purchase label.",
          code: "order_label_missing_rate",
        });
      }
      const label = await this.shippo.purchaseLabel({
        shipmentId: order.rateProviderRef,
        rateId: order.ratePurchasedRef,
        insuranceCents: order.insuranceFeeCents,
      });

      // Defensive: the order already has `carrier` + `carrierService` set
      // from the chosen quote at create time. If the Shippo client falls
      // back to "Unknown" (transient rate-lookup failure post-purchase),
      // keep the pre-existing values rather than overwriting good data.
      const useLabelCarrier = label.carrier && label.carrier !== "Unknown";
      const effectiveCarrier = useLabelCarrier ? label.carrier : order.carrier;
      const effectiveCarrierService = useLabelCarrier
        ? `${label.carrier} ${label.service}`
        : order.carrierService;

      const updated = await tx.order.update({
        where: { id },
        data: {
          status: "LABEL_PURCHASED",
          ...(effectiveCarrier ? { carrier: effectiveCarrier } : {}),
          ...(effectiveCarrierService ? { carrierService: effectiveCarrierService } : {}),
          trackingNumber: label.trackingNumber,
          labelUrl: label.labelUrl,
          labelPurchasedAt: new Date(),
        },
      });

      await tx.orderEvent.create({
        data: {
          orderId: id,
          type: "carrier.label_purchased",
          description: `Label purchased: ${label.trackingNumber} (${effectiveCarrier ?? "carrier"})`,
          source: "ADMIN",
          actorId,
          metadata: { trackingNumber: label.trackingNumber, labelUrl: label.labelUrl },
        },
      });
      return updated;
    });
  }

  async pick(id: string, actorId: string) {
    return this.transition(id, actorId, "pick", async (tx, order) => {
      // Migration 0037 — the ALLOWED_TRANSITIONS union widened to accept
      // ALLOCATED on top of LABEL_PURCHASED so VENDOR_CARRIER orders can
      // start picking without a Shippo label. Block PLATFORM_SHIP orders
      // from skipping the label-buy step that way: they must reach
      // LABEL_PURCHASED first or the rest of the pipeline (carrier
      // reassessment, tracking webhook) has no rate to anchor on.
      const mode = (order as unknown as { fulfillmentMode?: string }).fulfillmentMode;
      if (mode === "PLATFORM_SHIP" && order.status === "ALLOCATED") {
        throw new ConflictException({
          message: "Buy the carrier label before picking starts on this order.",
          code: "order_label_required",
        });
      }
      const updated = await tx.order.update({
        where: { id },
        data: { status: "PICKING", pickingStartedAt: new Date() },
      });
      await tx.orderEvent.create({
        data: {
          orderId: id,
          type: "order.picking_started",
          description: "Picking started.",
          source: "ADMIN",
          actorId,
        },
      });
      return updated;
    });
  }

  async pack(id: string, actorId: string) {
    return this.transition(id, actorId, "pack", async (tx) => {
      const updated = await tx.order.update({
        where: { id },
        data: { status: "PACKED", packedAt: new Date() },
      });
      await tx.orderEvent.create({
        data: {
          orderId: id,
          type: "order.packed",
          description: "Order packed.",
          source: "ADMIN",
          actorId,
        },
      });
      return updated;
    });
  }

  async ship(id: string, actorId: string) {
    const updated = await this.transition(id, actorId, "ship", async (tx, order) => {
      // Migration 0037 — VENDOR_CARRIER orders own no Shippo label and
      // emit no tracking webhooks; advancing them through `ship` would
      // create a SHIPPED row the reassessment + delivered-webhook cron
      // can never close out. Force operators down the markHandedOff
      // path instead.
      const mode = (order as unknown as { fulfillmentMode?: string }).fulfillmentMode;
      if (mode === "VENDOR_CARRIER") {
        throw new ConflictException({
          message:
            "This order uses the vendor's own carrier — use the Mark handed off action, not Ship.",
          code: "order_wrong_fulfillment_mode",
        });
      }
      // Mark the order lines as SHIPPED + decrement reserved counts.
      const lines = await tx.orderLine.findMany({ where: { orderId: id } });
      for (const line of lines) {
        await tx.sku.update({
          where: { id: line.skuId },
          data: { quantityReserved: { decrement: line.quantity } },
        });
        await tx.inventoryMovement.create({
          data: {
            vendorId: line.vendorId,
            skuId: line.skuId,
            type: "SHIP",
            deltaAvailable: 0,
            deltaReserved: -line.quantity,
            referenceType: "order",
            referenceId: id,
            actorId,
          },
        });
        await tx.orderLine.update({
          where: { id: line.id },
          data: { allocationStatus: "SHIPPED" },
        });
      }

      const o = await tx.order.update({
        where: { id },
        data: { status: "SHIPPED", shippedAt: new Date() },
      });
      await tx.orderEvent.create({
        data: {
          orderId: id,
          type: "order.shipped",
          description: "Handed to carrier.",
          source: "ADMIN",
          actorId,
        },
      });
      return o;
    });

    // Side-effect after the transaction commits — notification + email parity.
    // Failures here MUST NOT roll back the carrier hand-off above.
    if (updated.trackingNumber && updated.carrier) {
      // The portal-facing identifier is the platform-assigned, sequential
      // order number ("#1625"). external_reference is the vendor's own
      // bookkeeping id and is only surfaced as a secondary label.
      const ref = formatOrderRef(updated.orderNumber);
      const tpl = orderShippedTemplate({
        orderRef: ref,
        carrier: updated.carrier,
        trackingNumber: updated.trackingNumber,
        orderId: updated.id,
      });
      await this.notifications.emit({
        vendorId: updated.vendorId,
        type: "order.shipped",
        severity: "INFO",
        title: `Order ${ref} shipped`,
        body: `${updated.carrier} picked it up. Tracking: ${updated.trackingNumber}.`,
        href: `/orders/${updated.id}`,
        email: { subject: tpl.subject, html: tpl.html, text: tpl.text },
      });
    }
    return updated;
  }

  /**
   * Migration 0037 — terminal hand-off for VENDOR_CARRIER orders.
   *
   * Same starting state as `ship` (PACKED) but skips the Shippo /
   * tracking-webhook side of the pipeline. The vendor's chosen
   * carrier owns delivery and any tracking from this point on; the
   * platform just decrements `quantityReserved` (the parcel has
   * physically left the warehouse) and stamps `handed_off_at`.
   *
   * Refuses to advance PLATFORM_SHIP orders — those have a real
   * Shippo label and must go through `ship()` so the carrier
   * reassessment cron + delivered-webhook path stays intact.
   */
  async markHandedOff(id: string, actorId: string) {
    const updated = await this.transition(id, actorId, "handedOff", async (tx, order) => {
      // Mode guard. Cast the column out of the Order row through an
      // intermediate `unknown` because the generated Prisma client
      // doesn't surface fulfillmentMode until `prisma generate` runs
      // on the deploy machine (same pattern used by other migration-
      // 0037 spots in this file).
      const mode = (order as unknown as { fulfillmentMode?: string }).fulfillmentMode;
      if (mode !== "VENDOR_CARRIER") {
        throw new ConflictException({
          message:
            "This order ships on a USA Errands label — use the Ship action, not Mark handed off.",
          code: "order_wrong_fulfillment_mode",
        });
      }

      // Decrement reserved (the units have left the warehouse) and
      // flag each line as shipped. Same bookkeeping as ship() — the
      // wallet has already been debited at create time, so the only
      // thing left is inventory.
      const lines = await tx.orderLine.findMany({ where: { orderId: id } });
      for (const line of lines) {
        await tx.sku.update({
          where: { id: line.skuId },
          data: { quantityReserved: { decrement: line.quantity } },
        });
        await tx.inventoryMovement.create({
          data: {
            vendorId: line.vendorId,
            skuId: line.skuId,
            type: "SHIP",
            deltaAvailable: 0,
            deltaReserved: -line.quantity,
            referenceType: "order",
            referenceId: id,
            actorId,
          },
        });
        await tx.orderLine.update({
          where: { id: line.id },
          data: { allocationStatus: "SHIPPED" },
        });
      }

      const o = await tx.order.update({
        where: { id },
        // HANDED_OFF + handedOffAt are added in migration 0037; cast
        // through `unknown` until Prisma client regenerates.
        data: ({
          status: "HANDED_OFF",
          handedOffAt: new Date(),
        } as unknown) as Parameters<typeof tx.order.update>[0]["data"],
      });
      await tx.orderEvent.create({
        data: {
          orderId: id,
          type: "order.handed_off",
          description: "Handed to vendor's carrier.",
          source: "ADMIN",
          actorId,
        },
      });
      return o;
    });

    // Fire the same vendor notification as ship() but with copy that
    // makes clear this is the vendor-carrier path — there's no
    // platform-side tracking to surface in the body. Failures here do
    // NOT roll back the transaction above.
    const ref = formatOrderRef(updated.orderNumber);
    const carrierName =
      (updated as unknown as { vendorCarrierName?: string | null }).vendorCarrierName ??
      updated.carrier ??
      "your carrier";
    const tracking =
      (updated as unknown as { vendorTrackingNumber?: string | null }).vendorTrackingNumber ??
      updated.trackingNumber ??
      null;
    await this.notifications.emit({
      vendorId: updated.vendorId,
      type: "order.shipped",
      severity: "INFO",
      title: `Order ${ref} handed off`,
      body: tracking
        ? `Handed to ${carrierName}. Tracking: ${tracking}.`
        : `Handed to ${carrierName}.`,
      href: `/orders/${updated.id}`,
    }).catch(() => undefined);
    return updated;
  }

  // ---------------------------------------------------------------------------

  /** Wraps a transition: lock the order, validate state, run the body, audit. */
  private async transition<T>(
    id: string,
    actorId: string,
    name: keyof typeof ALLOWED_TRANSITIONS,
    body: (tx: Tx, order: Order) => Promise<T>,
  ): Promise<T> {
    const allowed = ALLOWED_TRANSITIONS[name]!;

    const result = await this.prisma.$transaction(async (tx) => {
      // Lock the row.
      const lockedRows = await tx.$queryRaw<Array<{ id: string; status: OrderStatus }>>(
        Prisma.sql`SELECT id, status FROM orders WHERE id = ${id}::uuid FOR UPDATE`,
      );
      const locked = lockedRows[0];
      if (!locked) throw new NotFoundException();
      if (!allowed.includes(locked.status)) {
        throw new ConflictException({
          message: `Order in ${locked.status} cannot be transitioned via ${name}. Allowed: ${allowed.join(", ")}.`,
          code: "order_invalid_transition",
        });
      }

      const order = await tx.order.findUniqueOrThrow({ where: { id } });
      return body(tx, order);
    });

    await this.audit.log({
      actorId,
      action: `order.admin.${name}`,
      resourceType: "order",
      resourceId: id,
    });

    return result;
  }
}
