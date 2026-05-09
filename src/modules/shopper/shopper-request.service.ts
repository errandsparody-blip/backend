/**
 * ShopperRequestService — orchestrator for the Personal Shopper feature.
 *
 * Lifecycle (status transitions):
 *
 *   AWAITING_INTAKE_PAYMENT
 *        │  Stripe Checkout completes (intake)
 *        ▼
 *   PAID
 *        │  Admin starts procurement
 *        ▼
 *   PROCURING
 *        │  Admin updates per-line actuals + sets shipping cost
 *        ▼
 *   AWAITING_RECONCILIATION
 *        │  Admin sends follow-up — three branches:
 *        │     · positive delta → buyer pays via Checkout → READY_TO_SHIP
 *        │     · negative delta → admin issues Stripe refund   → READY_TO_SHIP
 *        │     · zero delta     → no payment, jump straight    → READY_TO_SHIP
 *        ▼
 *   READY_TO_SHIP
 *        │  Admin attaches carrier + tracking
 *        ▼
 *   SHIPPED
 *        │  Carrier marks delivered (manual or webhook)
 *        ▼
 *   DELIVERED   (terminal)
 *
 *   Side-paths: CANCELLED (with optional refund) / REFUNDED.
 *
 * Money invariants (all integer cents, never float):
 *   - intake_total_cents = items_subtotal_cents + commission_cents
 *   - commission_cents   = floor(items_subtotal_cents * commission_rate_bps / 10_000)
 *   - followup_amount    = (items_actual_subtotal + shipping_cost) - items_subtotal
 *                          (signed; positive = buyer pays, negative = admin refunds)
 *
 * Concurrency:
 *   - Status transitions check current status inside the same `update`
 *     using `where: { id, status: <expected> }`. A row that's already moved
 *     produces a P2025 (record not found), which we map to a 409 Conflict.
 *     This avoids the optimistic vs pessimistic locking trap and uses
 *     Postgres' single-statement atomicity.
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { PrismaService } from "../../common/prisma.service";
import type {
  AdminListShopperRequestsInput,
  AdminSetShopperShippingInput,
  AdminShipShopperInput,
  AdminUpdateShopperLineInput,
  CreateShopperRequestInput,
  ShopperRequestStatus,
  ShopperShippingMethod,
} from "../../common/schemas/shopper.schema";
import { AuditService } from "../audit/audit.service";

// ---------------------------------------------------------------------------
// Cast helpers — see the long-form note in shopper-token.service.ts. Drop
// these once Railway runs `prisma generate` post-deploy.
// ---------------------------------------------------------------------------

export interface RequestRow {
  id: string;
  buyerEmail: string;
  buyerName: string | null;
  shippingAddress: Prisma.JsonValue | null;
  shippingMethod: ShopperShippingMethod | null;
  trackingNumber: string | null;
  carrier: string | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  itemsSubtotalCents: number;
  commissionRateBps: number;
  commissionCents: number;
  intakeTotalCents: number;
  intakeStripeSessionId: string | null;
  intakeStripeIntentId: string | null;
  intakePaidAt: Date | null;
  itemsActualSubtotalCents: number | null;
  shippingCostCents: number | null;
  followupAmountCents: number | null;
  followupStripeSessionId: string | null;
  followupStripeIntentId: string | null;
  followupStripeRefundId: string | null;
  followupResolvedAt: Date | null;
  status: ShopperRequestStatus;
  assignedAdminId: string | null;
  internalNotes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface LineRow {
  id: string;
  requestId: string;
  productUrl: string;
  productTitle: string | null;
  productNotes: string | null;
  quantity: number;
  estimatedUnitPriceCents: number;
  actualUnitPriceCents: number | null;
  procurementStatus: string | null;
  procurementNotes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RequestWithLines extends RequestRow {
  lines: LineRow[];
}

interface AnyPrismaShopperRequest {
  create: (args: unknown) => Promise<RequestRow>;
  findUnique: (args: unknown) => Promise<RequestWithLines | RequestRow | null>;
  findMany: (args: unknown) => Promise<RequestWithLines[]>;
  update: (args: unknown) => Promise<RequestRow>;
  count: (args: unknown) => Promise<number>;
}
interface AnyPrismaShopperRequestLine {
  findUnique: (args: unknown) => Promise<LineRow | null>;
  update: (args: unknown) => Promise<LineRow>;
  findMany: (args: unknown) => Promise<LineRow[]>;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ShopperRequestSnapshot = RequestWithLines;

export interface ListShopperRequestsResult {
  items: RequestWithLines[];
  nextCursor: string | null;
}

export interface FollowupPlan {
  /**
   * Signed delta (cents). Positive = buyer pays, negative = admin refunds,
   * zero = nothing to settle.
   */
  amountCents: number;
  itemsActualSubtotalCents: number;
  shippingCostCents: number;
  itemsSubtotalCents: number;
  /** Highest possible refund the platform can issue (intake_total_cents). */
  maxRefundCents: number;
}

const COMMISSION_BPS_CAP = 10_000;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class ShopperRequestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // =========================================================================
  // Create
  // =========================================================================

  /**
   * Create a brand-new request from buyer intake.
   *
   * `commissionBps` is snapshotted onto the row so historical audits stay
   * accurate even if the global rate moves. The caller is responsible for
   * loading it from the configuration table.
   */
  async create(
    input: CreateShopperRequestInput,
    commissionBps: number,
  ): Promise<RequestWithLines> {
    if (!Number.isInteger(commissionBps) || commissionBps < 0 || commissionBps > COMMISSION_BPS_CAP) {
      // Defence in depth: should already be validated upstream.
      throw new BadRequestException({
        message: "Commission rate is misconfigured.",
        code: "shopper_commission_misconfigured",
      });
    }

    // Money math — integer cents only. Compute then sanity-check.
    const itemsSubtotalCents = input.lines.reduce(
      (sum, line) => sum + line.estimatedUnitPriceCents * line.quantity,
      0,
    );
    if (itemsSubtotalCents <= 0) {
      throw new BadRequestException({
        message: "Total must be greater than zero.",
        code: "shopper_subtotal_invalid",
      });
    }
    const commissionCents = Math.floor((itemsSubtotalCents * commissionBps) / COMMISSION_BPS_CAP);
    const intakeTotalCents = itemsSubtotalCents + commissionCents;

    // Persist request + lines in a single transaction so we never end up
    // with a half-built request if a line insert fails.
    const created = await this.prisma.$transaction(async (tx) => {
      const requestRow = await (
        tx as unknown as { shopperRequest: AnyPrismaShopperRequest }
      ).shopperRequest.create({
        data: {
          buyerEmail: input.buyerEmail,
          buyerName: input.buyerName ?? null,
          shippingAddress: input.shippingAddress
            ? (input.shippingAddress as unknown as Prisma.InputJsonValue)
            : null,
          itemsSubtotalCents,
          commissionRateBps: commissionBps,
          commissionCents,
          intakeTotalCents,
          status: "AWAITING_INTAKE_PAYMENT",
          lines: {
            create: input.lines.map((line) => ({
              productUrl: line.productUrl,
              productNotes: line.productNotes ?? null,
              quantity: line.quantity,
              estimatedUnitPriceCents: line.estimatedUnitPriceCents,
              procurementStatus: "pending",
            })),
          },
        },
        include: { lines: true },
      });
      return requestRow as unknown as RequestWithLines;
    });

    await this.audit.log({
      action: "shopper.request.create",
      resourceType: "shopper_request",
      resourceId: created.id,
      afterState: {
        buyerEmail: created.buyerEmail,
        itemsSubtotalCents,
        commissionCents,
        intakeTotalCents,
        commissionBps,
        lineCount: input.lines.length,
      },
    });

    return created;
  }

  // =========================================================================
  // Read
  // =========================================================================

  async getById(id: string, options: { includeLines?: boolean } = {}): Promise<RequestWithLines> {
    const row = await (
      this.prisma as unknown as { shopperRequest: AnyPrismaShopperRequest }
    ).shopperRequest.findUnique({
      where: { id },
      include: { lines: options.includeLines !== false ? { orderBy: { createdAt: "asc" } } : false },
    });
    if (!row) {
      throw new NotFoundException({
        message: "Shopper request not found.",
        code: "shopper_request_not_found",
      });
    }
    return row as RequestWithLines;
  }

  /**
   * Admin queue listing with cursor pagination.
   * - `view: "queue"` (default in controller) restricts to in-flight statuses.
   * - `view: "all"` returns every row.
   * - `status` overrides view if both supplied.
   */
  async list(input: AdminListShopperRequestsInput): Promise<ListShopperRequestsResult> {
    const where: Record<string, unknown> = {};
    if (input.status) {
      where.status = input.status;
    } else if (input.view === "all") {
      // no status filter
    } else {
      where.status = {
        in: [
          "AWAITING_INTAKE_PAYMENT",
          "PAID",
          "PROCURING",
          "AWAITING_RECONCILIATION",
          "READY_TO_SHIP",
          "SHIPPED",
        ],
      };
    }
    if (input.search) {
      // Email or buyer name partial match. Both are case-sensitive in the index;
      // we lowercase incoming email at the schema level and use `contains` here.
      const q = input.search.trim();
      where.OR = [
        { buyerEmail: { contains: q.toLowerCase() } },
        { buyerName: { contains: q, mode: "insensitive" } },
      ];
    }

    const limit = Math.min(Math.max(input.limit, 1), 100);
    const findArgs: Record<string, unknown> = {
      where,
      include: { lines: { orderBy: { createdAt: "asc" } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    };
    if (input.cursor) {
      findArgs.cursor = { id: input.cursor };
      findArgs.skip = 1;
    }

    const rows = await (
      this.prisma as unknown as { shopperRequest: AnyPrismaShopperRequest }
    ).shopperRequest.findMany(findArgs);

    let nextCursor: string | null = null;
    if (rows.length > limit) {
      const next = rows.pop();
      nextCursor = next ? next.id : null;
    }
    return { items: rows, nextCursor };
  }

  // =========================================================================
  // Stripe + status transitions
  // =========================================================================

  /**
   * Attach a Stripe Checkout session to an intake. Used the moment we
   * create the session, before the buyer pays.
   */
  async attachIntakeSession(
    requestId: string,
    sessionId: string,
    intentId?: string | null,
  ): Promise<void> {
    await this.transition(requestId, {
      // No status change here, just metadata.
      data: {
        intakeStripeSessionId: sessionId,
        intakeStripeIntentId: intentId ?? null,
      },
    });
  }

  /**
   * Mark the intake as paid. Idempotent: re-running with the same
   * intent id is a no-op so the webhook is safe to replay.
   */
  async markIntakePaid(args: {
    requestId: string;
    stripeIntentId: string;
    paidAt?: Date;
  }): Promise<RequestRow> {
    const row = await this.getById(args.requestId, { includeLines: false });
    if (row.status !== "AWAITING_INTAKE_PAYMENT" && row.status !== "PAID") {
      // The webhook fired after the request had already moved on — usually
      // a race with admin manual marking. Don't bounce the status backward.
      return row;
    }
    if (row.intakePaidAt && row.intakeStripeIntentId === args.stripeIntentId) {
      return row; // Already settled by an earlier webhook — idempotent path.
    }
    const updated = await (
      this.prisma as unknown as { shopperRequest: AnyPrismaShopperRequest }
    ).shopperRequest.update({
      where: { id: args.requestId },
      data: {
        status: "PAID",
        intakePaidAt: args.paidAt ?? new Date(),
        intakeStripeIntentId: args.stripeIntentId,
      },
    });
    await this.audit.log({
      action: "shopper.intake.paid",
      resourceType: "shopper_request",
      resourceId: args.requestId,
      afterState: { stripeIntentId: args.stripeIntentId },
    });
    return updated;
  }

  /** Admin starts procurement — flips PAID → PROCURING. */
  async startProcurement(args: { requestId: string; actorId: string }): Promise<RequestRow> {
    return this.transition(args.requestId, {
      from: "PAID",
      to: "PROCURING",
      actorId: args.actorId,
      action: "shopper.procurement.start",
    });
  }

  // =========================================================================
  // Per-line reconciliation (admin)
  // =========================================================================

  async updateLine(args: {
    requestId: string;
    lineId: string;
    input: AdminUpdateShopperLineInput;
    actorId: string;
  }): Promise<LineRow> {
    const line = await (
      this.prisma as unknown as { shopperRequestLine: AnyPrismaShopperRequestLine }
    ).shopperRequestLine.findUnique({ where: { id: args.lineId } });
    if (!line || line.requestId !== args.requestId) {
      throw new NotFoundException({
        message: "Line not found on this request.",
        code: "shopper_line_not_found",
      });
    }
    // Build the partial in a way Prisma accepts (don't include `undefined`s
    // because Prisma treats them as no-ops, which is fine, but we want
    // explicit `null` clears for actualUnitPriceCents).
    const data: Record<string, unknown> = {};
    if (args.input.actualUnitPriceCents !== undefined) {
      data.actualUnitPriceCents = args.input.actualUnitPriceCents;
    }
    if (args.input.procurementStatus !== undefined) {
      data.procurementStatus = args.input.procurementStatus;
    }
    if (args.input.procurementNotes !== undefined) {
      data.procurementNotes = args.input.procurementNotes;
    }
    if (args.input.productTitle !== undefined) {
      data.productTitle = args.input.productTitle;
    }
    const updated = await (
      this.prisma as unknown as { shopperRequestLine: AnyPrismaShopperRequestLine }
    ).shopperRequestLine.update({
      where: { id: args.lineId },
      data,
    });
    await this.audit.log({
      actorId: args.actorId,
      action: "shopper.line.update",
      resourceType: "shopper_request_line",
      resourceId: args.lineId,
      beforeState: {
        actualUnitPriceCents: line.actualUnitPriceCents,
        procurementStatus: line.procurementStatus,
      },
      afterState: data as Prisma.InputJsonValue,
    });
    return updated;
  }

  // =========================================================================
  // Shipping cost + reconciliation
  // =========================================================================

  /**
   * Set the shipping cost (and optionally the method). Called when admin
   * has a real number from the carrier. Doesn't transition status — the
   * follow-up step (sendFollowup) is what does that.
   */
  async setShipping(args: {
    requestId: string;
    input: AdminSetShopperShippingInput;
    actorId: string;
  }): Promise<RequestRow> {
    const before = await this.getById(args.requestId, { includeLines: false });
    if (before.status !== "PROCURING" && before.status !== "AWAITING_RECONCILIATION") {
      throw new ConflictException({
        message: "Shipping cost can only be set during procurement.",
        code: "shopper_shipping_invalid_state",
        status: before.status,
      });
    }
    const data: Record<string, unknown> = {
      shippingCostCents: args.input.shippingCostCents,
    };
    if (args.input.shippingMethod !== undefined) {
      data.shippingMethod = args.input.shippingMethod;
    }
    const updated = await (
      this.prisma as unknown as { shopperRequest: AnyPrismaShopperRequest }
    ).shopperRequest.update({
      where: { id: args.requestId },
      data,
    });
    await this.audit.log({
      actorId: args.actorId,
      action: "shopper.shipping.set",
      resourceType: "shopper_request",
      resourceId: args.requestId,
      beforeState: {
        shippingCostCents: before.shippingCostCents,
        shippingMethod: before.shippingMethod,
      },
      afterState: data as Prisma.InputJsonValue,
    });
    return updated;
  }

  /**
   * Compute the follow-up plan from the current row. Pure function over
   * the loaded request; doesn't mutate. Returns null only if any actuals
   * are missing — caller should treat that as "not ready yet".
   */
  computeFollowup(row: RequestWithLines): FollowupPlan | null {
    if (row.shippingCostCents == null) return null;

    let itemsActualSubtotalCents = 0;
    for (const line of row.lines) {
      // A line marked "unavailable" with zero actual price is fine — the
      // buyer doesn't pay for what we couldn't get. Substitutions land
      // through the same field too.
      const actual = line.actualUnitPriceCents;
      if (actual == null) {
        return null; // Some line still missing actual — not ready.
      }
      itemsActualSubtotalCents += actual * line.quantity;
    }

    const total = itemsActualSubtotalCents + row.shippingCostCents;
    const amountCents = total - row.itemsSubtotalCents;
    return {
      amountCents,
      itemsActualSubtotalCents,
      shippingCostCents: row.shippingCostCents,
      itemsSubtotalCents: row.itemsSubtotalCents,
      // We can never refund more than the buyer paid in total at intake.
      maxRefundCents: row.intakeTotalCents,
    };
  }

  /**
   * Snapshot the actual-items subtotal + recomputed follow-up and move the
   * request to AWAITING_RECONCILIATION. Called from the controller right
   * before it hands control off to either Stripe Checkout (positive delta),
   * Stripe Refund (negative), or the no-payment shortcut (zero).
   */
  async finalizeReconciliation(args: {
    requestId: string;
    actorId: string;
  }): Promise<{ row: RequestRow; plan: FollowupPlan }> {
    const current = await this.getById(args.requestId);
    if (current.status !== "PROCURING") {
      throw new ConflictException({
        message: "Reconciliation already started or request not in procurement.",
        code: "shopper_reconcile_invalid_state",
        status: current.status,
      });
    }
    const plan = this.computeFollowup(current);
    if (!plan) {
      throw new BadRequestException({
        message: "All lines must have an actual price (or be marked unavailable with $0) and shipping cost must be set.",
        code: "shopper_reconcile_incomplete",
      });
    }
    // Refund cap defence — should never trigger given the math but worth a check.
    if (-plan.amountCents > plan.maxRefundCents) {
      throw new BadRequestException({
        message: "Refund would exceed the original intake. Contact engineering.",
        code: "shopper_refund_overflow",
      });
    }

    const row = await (
      this.prisma as unknown as { shopperRequest: AnyPrismaShopperRequest }
    ).shopperRequest.update({
      where: { id: args.requestId, status: "PROCURING" },
      data: {
        status: "AWAITING_RECONCILIATION",
        itemsActualSubtotalCents: plan.itemsActualSubtotalCents,
        followupAmountCents: plan.amountCents,
      },
    }).catch((err) => {
      // P2025 = record-not-found for the matched (id + status) tuple. Means
      // someone else already advanced the row. Translate to a 409.
      if (this.isPrismaNotFound(err)) {
        throw new ConflictException({
          message: "Reconciliation already started by another admin.",
          code: "shopper_reconcile_conflict",
        });
      }
      throw err;
    });

    await this.audit.log({
      actorId: args.actorId,
      action: "shopper.reconciliation.finalize",
      resourceType: "shopper_request",
      resourceId: args.requestId,
      afterState: {
        followupAmountCents: plan.amountCents,
        itemsActualSubtotalCents: plan.itemsActualSubtotalCents,
        shippingCostCents: plan.shippingCostCents,
      },
    });
    return { row, plan };
  }

  /** Attach a follow-up Checkout session id (positive delta). */
  async attachFollowupSession(requestId: string, sessionId: string, intentId?: string | null) {
    await (
      this.prisma as unknown as { shopperRequest: AnyPrismaShopperRequest }
    ).shopperRequest.update({
      where: { id: requestId },
      data: {
        followupStripeSessionId: sessionId,
        followupStripeIntentId: intentId ?? null,
      },
    });
  }

  /** Mark the follow-up payment as collected and advance to READY_TO_SHIP. */
  async markFollowupPaid(args: { requestId: string; stripeIntentId: string; paidAt?: Date }) {
    const row = await this.getById(args.requestId, { includeLines: false });
    if (row.followupResolvedAt && row.followupStripeIntentId === args.stripeIntentId) {
      return row; // Idempotent webhook replay.
    }
    if (row.status !== "AWAITING_RECONCILIATION") {
      // Either not at the right step (likely a stale webhook) or already advanced.
      return row;
    }
    const updated = await (
      this.prisma as unknown as { shopperRequest: AnyPrismaShopperRequest }
    ).shopperRequest.update({
      where: { id: args.requestId, status: "AWAITING_RECONCILIATION" },
      data: {
        status: "READY_TO_SHIP",
        followupResolvedAt: args.paidAt ?? new Date(),
        followupStripeIntentId: args.stripeIntentId,
      },
    });
    await this.audit.log({
      action: "shopper.followup.paid",
      resourceType: "shopper_request",
      resourceId: args.requestId,
      afterState: { stripeIntentId: args.stripeIntentId },
    });
    return updated;
  }

  /** Record a Stripe Refund id and advance to READY_TO_SHIP (negative delta). */
  async markFollowupRefunded(args: {
    requestId: string;
    stripeRefundId: string;
    actorId?: string | null;
  }) {
    const row = await this.getById(args.requestId, { includeLines: false });
    if (row.status !== "AWAITING_RECONCILIATION") {
      return row;
    }
    const updated = await (
      this.prisma as unknown as { shopperRequest: AnyPrismaShopperRequest }
    ).shopperRequest.update({
      where: { id: args.requestId, status: "AWAITING_RECONCILIATION" },
      data: {
        status: "READY_TO_SHIP",
        followupResolvedAt: new Date(),
        followupStripeRefundId: args.stripeRefundId,
      },
    });
    await this.audit.log({
      actorId: args.actorId ?? null,
      action: "shopper.followup.refunded",
      resourceType: "shopper_request",
      resourceId: args.requestId,
      afterState: { stripeRefundId: args.stripeRefundId },
    });
    return updated;
  }

  /** Skip the follow-up payment when delta is exactly zero. */
  async markFollowupSkipped(args: { requestId: string; actorId: string }) {
    const row = await this.getById(args.requestId, { includeLines: false });
    if (row.status !== "AWAITING_RECONCILIATION") {
      throw new ConflictException({
        message: "Request is not awaiting reconciliation.",
        code: "shopper_followup_invalid_state",
      });
    }
    if (row.followupAmountCents !== 0) {
      throw new BadRequestException({
        message: "Follow-up cannot be skipped when there is a balance to settle.",
        code: "shopper_followup_balance_pending",
        amountCents: row.followupAmountCents,
      });
    }
    const updated = await (
      this.prisma as unknown as { shopperRequest: AnyPrismaShopperRequest }
    ).shopperRequest.update({
      where: { id: args.requestId, status: "AWAITING_RECONCILIATION" },
      data: { status: "READY_TO_SHIP", followupResolvedAt: new Date() },
    });
    await this.audit.log({
      actorId: args.actorId,
      action: "shopper.followup.skipped_zero",
      resourceType: "shopper_request",
      resourceId: args.requestId,
    });
    return updated;
  }

  // =========================================================================
  // Shipping
  // =========================================================================

  async markShipped(args: {
    requestId: string;
    input: AdminShipShopperInput;
    actorId: string;
  }) {
    const row = await this.getById(args.requestId, { includeLines: false });
    if (row.status !== "READY_TO_SHIP") {
      throw new ConflictException({
        message: "Request is not ready to ship.",
        code: "shopper_ship_invalid_state",
        status: row.status,
      });
    }
    const updated = await (
      this.prisma as unknown as { shopperRequest: AnyPrismaShopperRequest }
    ).shopperRequest.update({
      where: { id: args.requestId, status: "READY_TO_SHIP" },
      data: {
        status: "SHIPPED",
        carrier: args.input.carrier,
        trackingNumber: args.input.trackingNumber,
        shippedAt: new Date(),
      },
    });
    await this.audit.log({
      actorId: args.actorId,
      action: "shopper.shipped",
      resourceType: "shopper_request",
      resourceId: args.requestId,
      afterState: { carrier: args.input.carrier, trackingNumber: args.input.trackingNumber },
    });
    return updated;
  }

  async markDelivered(args: { requestId: string; actorId?: string | null; deliveredAt?: Date }) {
    const row = await this.getById(args.requestId, { includeLines: false });
    if (row.status !== "SHIPPED") {
      // Stale webhook or admin double-click. Don't bounce backward.
      return row;
    }
    const updated = await (
      this.prisma as unknown as { shopperRequest: AnyPrismaShopperRequest }
    ).shopperRequest.update({
      where: { id: args.requestId, status: "SHIPPED" },
      data: { status: "DELIVERED", deliveredAt: args.deliveredAt ?? new Date() },
    });
    await this.audit.log({
      actorId: args.actorId ?? null,
      action: "shopper.delivered",
      resourceType: "shopper_request",
      resourceId: args.requestId,
    });
    return updated;
  }

  // =========================================================================
  // Cancellation
  // =========================================================================

  /**
   * Cancel a request. Whether to refund is the caller's call — the
   * controller verifies against intake_paid_at and issues the actual
   * Stripe Refund. We record the audit + flip status here.
   */
  async cancel(args: {
    requestId: string;
    reason: string;
    actorId: string;
    refundIssued: boolean;
  }) {
    const row = await this.getById(args.requestId, { includeLines: false });
    if (row.status === "DELIVERED" || row.status === "CANCELLED" || row.status === "REFUNDED") {
      throw new ConflictException({
        message: "Cannot cancel a completed or already cancelled request.",
        code: "shopper_cancel_invalid_state",
        status: row.status,
      });
    }
    // Enum split: REFUNDED is its own terminal state when money moved back.
    const newStatus: ShopperRequestStatus = args.refundIssued ? "REFUNDED" : "CANCELLED";
    const updated = await (
      this.prisma as unknown as { shopperRequest: AnyPrismaShopperRequest }
    ).shopperRequest.update({
      where: { id: args.requestId },
      data: { status: newStatus },
    });
    await this.audit.log({
      actorId: args.actorId,
      action: args.refundIssued ? "shopper.refunded" : "shopper.cancelled",
      resourceType: "shopper_request",
      resourceId: args.requestId,
      beforeState: { status: row.status },
      afterState: { status: newStatus, reason: args.reason },
    });
    return updated;
  }

  // =========================================================================
  // Internal — generic transition helper
  // =========================================================================

  private async transition(
    requestId: string,
    args: {
      from?: ShopperRequestStatus;
      to?: ShopperRequestStatus;
      actorId?: string;
      action?: string;
      data?: Record<string, unknown>;
    },
  ): Promise<RequestRow> {
    const where: Record<string, unknown> = { id: requestId };
    if (args.from) where.status = args.from;
    const data: Record<string, unknown> = { ...(args.data ?? {}) };
    if (args.to) data.status = args.to;
    const updated = await (
      this.prisma as unknown as { shopperRequest: AnyPrismaShopperRequest }
    ).shopperRequest
      .update({ where, data })
      .catch((err) => {
        if (this.isPrismaNotFound(err)) {
          throw new ConflictException({
            message: "Status changed by another admin.",
            code: "shopper_status_conflict",
            expected: args.from,
          });
        }
        throw err;
      });
    if (args.action) {
      await this.audit.log({
        actorId: args.actorId ?? null,
        action: args.action,
        resourceType: "shopper_request",
        resourceId: requestId,
        afterState: args.to ? { status: args.to } : undefined,
      });
    }
    return updated;
  }

  private isPrismaNotFound(err: unknown): boolean {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      return err.code === "P2025";
    }
    return false;
  }
}
