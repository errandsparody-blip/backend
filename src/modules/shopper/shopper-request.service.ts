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
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { PrismaService } from "../../common/prisma.service";
import type {
  AdminListShopperRequestsInput,
  AdminMarkPickedUpInput,
  AdminReleaseWithBuyerLabelInput,
  AdminSetShopperShippingInput,
  AdminShipShopperInput,
  AdminUpdateShopperLineInput,
  CreateShopperRequestInput,
  ShopperRequestStatus,
  ShopperShippingMethod,
  ShopperWireBankInstructions,
} from "../../common/schemas/shopper.schema";
import { AuditService } from "../audit/audit.service";
import {
  shopperCancelledTemplate,
  shopperDeliveredTemplate,
  shopperFollowupPaidTemplate,
  shopperIntakePaidTemplate,
} from "../email/email-templates";
import { EmailService } from "../email/email.service";
import { ShopperLedgerService } from "../wallet/shopper-ledger.service";

import { ShopperTokenService } from "./shopper-token.service";

// ---------------------------------------------------------------------------
// Cast helpers — see the long-form note in shopper-token.service.ts. Drop
// these once Railway runs `prisma generate` post-deploy.
// ---------------------------------------------------------------------------

export interface RequestRow {
  id: string;
  // Migration 0015 — short human-readable reference (SHP-000042). Generated
  // from a Postgres sequence at create time.
  reference: string;
  parentRequestId: string | null;
  buyerEmail: string;
  buyerName: string | null;
  // Migration 0023 — added for the wire/ID flow. Nullable so historical
  // rows don't blow up when read.
  buyerPhone: string | null;
  // Migration 0023 — payment rail this request is on.
  paymentMethod: "STRIPE" | "WIRE";
  // Migration 0023 — gov-ID review packet (only meaningful when WIRE).
  idVerificationStatus:
    | "NONE"
    | "PENDING_UPLOAD"
    | "UNDER_REVIEW"
    | "APPROVED"
    | "REJECTED";
  idDocumentUrl: string | null;
  idSelfieUrl: string | null;
  idRejectionReason: string | null;
  idVerifiedAt: Date | null;
  idVerifiedById: string | null;
  // Migration 0023 — wire-transfer proof packet.
  wireProofUrl: string | null;
  wireProofUploadedAt: Date | null;
  wireConfirmedAt: Date | null;
  wireConfirmedById: string | null;
  shippingAddress: Prisma.JsonValue | null;
  shippingMethod: ShopperShippingMethod | null;
  trackingNumber: string | null;
  carrier: string | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  itemsSubtotalCents: number;
  commissionRateBps: number;
  commissionCents: number;
  // Migration 0013 — U.S. sales tax estimated at intake, actual at procurement.
  estimatedTaxRateBps: number;
  estimatedTaxCents: number;
  actualTaxCents: number | null;
  // Migration 0014 — which state's rate was used.
  effectiveTaxState: string | null;
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
  // Migration 0012 — refund ids for the cancel-with-refund flow. Distinct from
  // followupStripeRefundId so we never overwrite the negative-followup refund.
  cancelIntakeRefundId: string | null;
  cancelFollowupRefundId: string | null;
  // Migration 0016 — packed parcel dimensions captured by warehouse staff.
  parcelLengthIn: number | null;
  parcelWidthIn: number | null;
  parcelHeightIn: number | null;
  parcelWeightOz: number | null;
  // Migration 0017 — freight rate snapshot + system-calculated cost. Lets
  // the receipt explain "weight × rate = $X · charged $Y".
  freightRateCentsPerLb: number | null;
  shippingCalculatedCents: number | null;
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
  // Migration 0016 — actual per-line weight in ounces, captured at receive.
  actualWeightOz: number | null;
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
   *
   * Formula:
   *   amount = (items_actual + actual_tax + shipping)
   *          - (items_subtotal + estimated_tax)
   *
   * Note that commission is NOT in this calculation — it was already paid
   * at intake and is non-refundable (we did the procurement work).
   */
  amountCents: number;
  itemsActualSubtotalCents: number;
  actualTaxCents: number;
  shippingCostCents: number;
  itemsSubtotalCents: number;
  estimatedTaxCents: number;
  /** Highest possible refund the platform can issue (intake_total_cents). */
  maxRefundCents: number;
}

const COMMISSION_BPS_CAP = 10_000;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class ShopperRequestService {
  private readonly logger = new Logger(ShopperRequestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly tokens: ShopperTokenService,
    private readonly shopperLedger: ShopperLedgerService,
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
    rates: {
      commissionBps: number;
      /** Tax bps for the state we'll actually ship to. */
      estimatedTaxBps: number;
      /**
       * 2-letter ISO of the state whose rate was used. Snapshot for audit
       * — survives operator tweaks to the rate map.
       */
      effectiveTaxState: string;
      /**
       * Migration 0023 — server-derived payment rail. Above the wire
       * threshold the request is created with `paymentMethod=WIRE`,
       * status `AWAITING_ID_VERIFICATION`, and we skip the Stripe
       * Checkout step entirely. Defaults to STRIPE so existing callers
       * stay on the original flow.
       */
      paymentMethod?: "STRIPE" | "WIRE";
    },
  ): Promise<RequestWithLines> {
    const { commissionBps, estimatedTaxBps, effectiveTaxState } = rates;
    const paymentMethod = rates.paymentMethod ?? "STRIPE";
    if (!Number.isInteger(commissionBps) || commissionBps < 0 || commissionBps > COMMISSION_BPS_CAP) {
      // Defence in depth: should already be validated upstream.
      throw new BadRequestException({
        message: "Commission rate is misconfigured.",
        code: "shopper_commission_misconfigured",
      });
    }
    if (!Number.isInteger(estimatedTaxBps) || estimatedTaxBps < 0 || estimatedTaxBps > COMMISSION_BPS_CAP) {
      throw new BadRequestException({
        message: "Estimated tax rate is misconfigured.",
        code: "shopper_estimated_tax_misconfigured",
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
    // Commission is on items only — we don't earn margin on the sales tax
    // we'll be passing through to the U.S. retailer.
    const commissionCents = Math.floor((itemsSubtotalCents * commissionBps) / COMMISSION_BPS_CAP);
    // Estimated U.S. sales tax. This is a buyer-protective estimate so the
    // intake total isn't dramatically lower than the actual cost. Reconciled
    // against `actualTaxCents` after admin completes procurement.
    const estimatedTaxCents = Math.floor(
      (itemsSubtotalCents * estimatedTaxBps) / COMMISSION_BPS_CAP,
    );
    const intakeTotalCents = itemsSubtotalCents + commissionCents + estimatedTaxCents;

    // Validate the optional parent reference BEFORE we open the
    // transaction. The parent must exist AND belong to the same buyer
    // email. We do this strict check so anyone who happens to know a
    // reference number (they appear in emails) can't link a fresh request
    // to a stranger's prior order.
    let parentRequestId: string | null = null;
    if (input.parentReference) {
      const parent = await (
        this.prisma as unknown as {
          shopperRequest: { findUnique: (args: unknown) => Promise<RequestRow | null> };
        }
      ).shopperRequest.findUnique({
        where: { reference: input.parentReference },
      });
      if (!parent) {
        throw new BadRequestException({
          message: `Previous order ${input.parentReference} not found. Check the reference and try again.`,
          code: "shopper_parent_not_found",
        });
      }
      // Lowercased on both sides — the schema field is already lowercase.
      if (parent.buyerEmail.toLowerCase() !== input.buyerEmail.toLowerCase()) {
        // Don't leak whether the reference exists; same generic copy as
        // the not-found case so an attacker can't email-enumerate.
        throw new BadRequestException({
          message: `Previous order ${input.parentReference} not found. Check the reference and try again.`,
          code: "shopper_parent_not_found",
        });
      }
      // The whole point of the parent link is so the warehouse can
      // ship the two orders together. Once the parent has shipped (or
      // hit any terminal state) that's no longer possible — surfacing
      // a clear error here is friendlier than letting the link succeed
      // and then quietly being unable to act on it. The buyer can
      // still place the order WITHOUT the link by removing the
      // reference and re-submitting.
      const parentTerminalStates: ShopperRequestStatus[] = [
        "SHIPPED",
        "DELIVERED",
        "CANCELLED",
        "REFUNDED",
      ];
      if (parentTerminalStates.includes(parent.status)) {
        throw new BadRequestException({
          message:
            `Previous order ${input.parentReference} has already shipped (status: ${parent.status.replace(/_/g, " ").toLowerCase()}), so we can't combine this new order with it. ` +
            `Submit this order on its own and we'll ship it separately.`,
          code: "shopper_parent_already_shipped",
          parentStatus: parent.status,
        });
      }
      parentRequestId = parent.id;
    }

    // Persist request + lines in a single transaction so we never end up
    // with a half-built request if a line insert fails. The reference is
    // pulled from the Postgres sequence in the same transaction so the
    // value is unique by construction (sequences are MVCC-safe).
    const created = await this.prisma.$transaction(async (tx) => {
      const refRows = (await tx.$queryRawUnsafe(
        `SELECT 'SHP-' || lpad(nextval('shopper_reference_seq')::text, 6, '0') AS reference`,
      )) as Array<{ reference: string }>;
      const reference = refRows[0]?.reference;
      if (!reference) {
        throw new Error("Failed to allocate shopper reference (sequence missing).");
      }

      // May 2026 — All-manual payment policy. ID verification is no
      // longer collected. WIRE-rail requests now jump straight to
      // AWAITING_WIRE_PAYMENT (semantically: "awaiting any manual
      // payment" — wire / ACH / Zelle / Cash App). The buyer thread
      // surfaces every active method from configuration and the buyer
      // picks one. The STRIPE branch is preserved for legacy callers
      // but is no longer reachable from the public controller.
      const initialStatus: ShopperRequestStatus =
        paymentMethod === "WIRE" ? "AWAITING_WIRE_PAYMENT" : "AWAITING_INTAKE_PAYMENT";

      const requestRow = await (
        tx as unknown as { shopperRequest: AnyPrismaShopperRequest }
      ).shopperRequest.create({
        data: {
          reference,
          parentRequestId,
          buyerEmail: input.buyerEmail,
          buyerName: input.buyerName ?? null,
          // Migration 0023 — phone is required at the Zod layer for new
          // requests but the column is nullable for back-compat. We coerce
          // an empty input back to null defensively.
          buyerPhone: input.buyerPhone && input.buyerPhone.length > 0 ? input.buyerPhone : null,
          shippingAddress: input.shippingAddress
            ? (input.shippingAddress as unknown as Prisma.InputJsonValue)
            : null,
          itemsSubtotalCents,
          commissionRateBps: commissionBps,
          commissionCents,
          estimatedTaxRateBps: estimatedTaxBps,
          estimatedTaxCents,
          effectiveTaxState,
          intakeTotalCents,
          status: initialStatus as unknown as never,
          // Cast — the generated Prisma client may not include the new
          // enum/column types until `prisma generate` runs post-deploy.
          paymentMethod: paymentMethod as unknown as never,
          idVerificationStatus: (paymentMethod === "WIRE"
            ? "PENDING_UPLOAD"
            : "NONE") as unknown as never,
          lines: {
            create: input.lines.map((line) => ({
              productUrl: line.productUrl,
              productNotes: line.productNotes ?? null,
              quantity: line.quantity,
              estimatedUnitPriceCents: line.estimatedUnitPriceCents,
              procurementStatus: "pending",
            })),
          },
        } as unknown as never,
        include: { lines: true },
      });
      return requestRow as unknown as RequestWithLines;
    });

    await this.audit.log({
      action: "shopper.request.create",
      resourceType: "shopper_request",
      resourceId: created.id,
      afterState: {
        reference: created.reference,
        parentRequestId: created.parentRequestId,
        buyerEmail: created.buyerEmail,
        itemsSubtotalCents,
        commissionCents,
        estimatedTaxCents,
        intakeTotalCents,
        commissionBps,
        estimatedTaxBps,
        effectiveTaxState,
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
    const isFirstPaymentTransition = row.status === "AWAITING_INTAKE_PAYMENT";
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

    // Migration 0019 — record the unified-finance ledger entries for the
    // items + commission on the intake-paid transition. The service is
    // idempotent on its own keys so a webhook replay doesn't double-write.
    // Best-effort: a failure here mustn't block the buyer's payment flow.
    void this.shopperLedger
      .recordIntakePaid({
        shopperRequestId: updated.id,
        reference: updated.reference,
        itemsCents: updated.itemsSubtotalCents,
        commissionCents: updated.commissionCents,
        occurredAt: updated.intakePaidAt ?? new Date(),
      })
      .catch((err: unknown) => {
        this.logger.error(
          { err: (err as Error).message, requestId: updated.id },
          "Failed to record shopper ledger entries on intake paid",
        );
      });

    // Buyer thank-you email — only on the actual transition (not on
    // duplicate webhook delivery for an already-PAID row). Idempotency
    // key keeps Resend from sending twice even if we accidentally do.
    if (isFirstPaymentTransition) {
      void this.notifyIntakePaid(updated).catch(() => undefined);
    }
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

  /**
   * Admin confirms the items have physically landed at the warehouse.
   * AWAITING_DELIVERY → READY_TO_SHIP. We don't auto-fire this on a
   * tracking webhook because most procurement happens via consumer
   * accounts (USPS to PO box, Amazon to warehouse, etc.) where we have
   * no programmatic tracking. Admin is the source of truth.
   */
  async markDeliveredToWarehouse(args: {
    requestId: string;
    actorId: string;
  }): Promise<RequestRow> {
    const before = await this.getById(args.requestId, { includeLines: false });
    // Accept either AWAITING_DELIVERY (the new happy-path) or PROCURING
    // (so admin can fast-forward without touching every line first when
    // they personally walked the items in).
    const allowed = ["AWAITING_DELIVERY", "PROCURING"] as ReadonlyArray<string>;
    if (!allowed.includes(before.status as string)) {
      throw new ConflictException({
        message: "Items can only be marked delivered to warehouse during procurement.",
        code: "shopper_warehouse_delivery_invalid_state",
        status: before.status,
      });
    }
    // Migration 0025 — branch on shipping method. PICKUP transitions to
    // READY_FOR_PICKUP (terminal-readiness for in-person handoff); every
    // other method continues to READY_TO_SHIP (buy/release a label). If
    // the method isn't set yet we refuse — without it we don't know
    // which downstream status to use, and once the request leaves
    // AWAITING_DELIVERY the shipping form is no longer reachable.
    //
    // Cast through `unknown` to ride out a stale Prisma client (the
    // BUYER_FREIGHT / READY_FOR_PICKUP enum values arrived in 0025a;
    // string comparison works at runtime regardless).
    const method = (before as unknown as { shippingMethod: string | null }).shippingMethod;
    if (!method) {
      throw new ConflictException({
        message:
          "Pick a shipping method first — we need to know whether this request goes to ready-to-ship or ready-for-pickup.",
        code: "shopper_warehouse_delivery_no_method",
      });
    }
    // Migration 0027 — refuse to advance until the buyer has paid the
    // shipping invoice (for freight-bearing methods). Zero-cost methods
    // (BUYER_FREIGHT, PICKUP) bypass automatically.
    this.assertShippingPaid(before, "warehouse_delivery");
    const nextStatus = method === "PICKUP" ? "READY_FOR_PICKUP" : "READY_TO_SHIP";
    return this.transition(args.requestId, {
      to: nextStatus as unknown as Parameters<typeof this.transition>[1]["to"],
      actorId: args.actorId,
      action: "shopper.warehouse.delivered",
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
    if (args.input.actualWeightOz !== undefined) {
      data.actualWeightOz = args.input.actualWeightOz;
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
        actualWeightOz: line.actualWeightOz,
      },
      afterState: data as Prisma.InputJsonValue,
    });

    // Migration 0021 — auto-transition PROCURING → AWAITING_DELIVERY once
    // every line has reached a terminal procurement state (purchased or
    // unavailable). This is the trigger that fires the buyer-facing
    // notification "your items have been purchased."
    //
    // The procurement-status enum is lowercase on the wire (Zod schema
    // serialises it that way for buyer-facing UI). Best-effort: if the
    // transition fails for any reason, the line update itself still
    // succeeded — admin can manually retry by saving another line.
    if (args.input.procurementStatus === "purchased" || args.input.procurementStatus === "unavailable") {
      void this.maybeAutoTransitionToAwaitingDelivery(args.requestId, args.actorId).catch(
        (err: unknown) => {
          this.logger.warn(
            { err: (err as Error).message, requestId: args.requestId },
            "Auto-transition to AWAITING_DELIVERY failed; admin can retry by saving another line.",
          );
        },
      );
    }

    return updated;
  }

  /**
   * Check whether every line on a PROCURING request is in a terminal
   * state (purchased or unavailable) and, if so, transition the request
   * to AWAITING_DELIVERY. Safe to call any time — refuses to transition
   * unless preconditions hold.
   */
  private async maybeAutoTransitionToAwaitingDelivery(
    requestId: string,
    actorId: string,
  ): Promise<void> {
    const row = await this.getById(requestId, { includeLines: true });
    if (row.status !== "PROCURING") return;
    const lines = (row as unknown as { lines?: Array<{ procurementStatus: string }> }).lines ?? [];
    if (lines.length === 0) return;
    const allTerminal = lines.every(
      (l) => l.procurementStatus === "purchased" || l.procurementStatus === "unavailable",
    );
    if (!allTerminal) return;

    await (
      this.prisma as unknown as { shopperRequest: AnyPrismaShopperRequest }
    ).shopperRequest.update({
      where: { id: requestId },
      // Cast the status string — the generated Prisma client may not yet
      // include AWAITING_DELIVERY until `prisma generate` is re-run.
      data: { status: "AWAITING_DELIVERY" as unknown as never },
    });

    await this.audit.log({
      actorId,
      action: "shopper.status.awaiting_delivery",
      resourceType: "shopper_request",
      resourceId: requestId,
      beforeState: { status: "PROCURING" },
      afterState: { status: "AWAITING_DELIVERY", trigger: "all_lines_terminal" },
    });
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
    /**
     * Per-method freight rate map (cents per pound). Loaded from the
     * `shopper_freight_rates` configuration row by the controller and
     * threaded in so the service stays free of DB-config lookups.
     */
    freightRates: Record<string, number>;
  }): Promise<RequestRow> {
    const before = await this.getById(args.requestId, { includeLines: false });
    // Migration 0021 — AWAITING_DELIVERY is the new home for the shipping
    // panel (after admin marks all lines PURCHASED, the request lands
    // there). PROCURING + AWAITING_RECONCILIATION remain accepted for
    // backward compatibility with in-flight requests created before the
    // redesign.
    const ALLOWED_STATES = [
      "PROCURING",
      "AWAITING_RECONCILIATION",
      "AWAITING_DELIVERY",
    ] as ReadonlyArray<string>;
    if (!ALLOWED_STATES.includes(before.status as string)) {
      throw new ConflictException({
        message: "Shipping cost can only be set during procurement or while awaiting delivery.",
        code: "shopper_shipping_invalid_state",
        status: before.status,
      });
    }

    // Resolve the effective method + weight for the calc. We accept
    // partial updates (e.g. admin saves shipping cost first, then comes
    // back for parcel dims), so fall back to whatever the row already
    // has when this PATCH doesn't override it.
    const effectiveMethod =
      (args.input.shippingMethod ?? before.shippingMethod) as
        | ShopperShippingMethod
        | null;
    const effectiveWeightOz =
      args.input.parcelWeightOz !== undefined
        ? args.input.parcelWeightOz
        : before.parcelWeightOz;

    // Methods that DON'T charge freight: BUYER_FREIGHT (buyer's own label
    // on the box) and PICKUP (no shipping at all). For these we zero the
    // cost + rate + calc regardless of what the form sent, so the receipt
    // never shows a phantom freight line.
    const NO_FREIGHT_METHODS: ShopperShippingMethod[] = ["BUYER_FREIGHT", "PICKUP"];
    const skipFreight = !!(effectiveMethod && NO_FREIGHT_METHODS.includes(effectiveMethod));

    // Look up the per-lb rate for the resolved method. Skip-freight
    // methods get 0; everything else uses the configured rate. An
    // unrecognised value would fail Zod validation upstream anyway.
    const ratePerLb = skipFreight
      ? 0
      : effectiveMethod && Number.isFinite(args.freightRates[effectiveMethod])
        ? args.freightRates[effectiveMethod]!
        : 0;

    // Compute system shipping cost: weight (lb) × rate (cents/lb).
    // `Math.round` so the cents land as an integer; truncating with
    // floor would systematically under-charge by sub-cent amounts.
    const calculatedCents =
      !skipFreight && effectiveWeightOz != null && effectiveWeightOz > 0
        ? Math.round((effectiveWeightOz / 16) * ratePerLb)
        : 0;

    // Decide what to actually charge based on the override flag.
    let chargedCents: number;
    if (skipFreight) {
      // Buyer-supplied label or pickup — buyer pays carrier (or nothing).
      chargedCents = 0;
    } else if (args.input.useCalculated) {
      // Use the system number. Refuse if the inputs needed to compute
      // it aren't ready — better than silently charging $0.
      if (!effectiveMethod) {
        throw new BadRequestException({
          message: "Pick a shipping method before using auto-calculated cost.",
          code: "shopper_shipping_no_method",
        });
      }
      chargedCents = calculatedCents;
    } else {
      // Override path. Schema's refine() guarantees shippingCostCents is
      // present when useCalculated is false AND the method charges freight.
      chargedCents = args.input.shippingCostCents!;
    }

    const data: Record<string, unknown> = {
      shippingCostCents: chargedCents,
      shippingCalculatedCents: calculatedCents,
      // Always snapshot the rate that was active at this save — even if
      // admin overrode, the receipt needs to explain how the system
      // number was reached. Null only if no method is set yet OR the
      // method doesn't charge freight (in which case the rate is N/A).
      freightRateCentsPerLb: skipFreight || !effectiveMethod ? null : ratePerLb,
    };
    if (args.input.shippingMethod !== undefined) {
      data.shippingMethod = args.input.shippingMethod;
    }
    if (args.input.actualTaxCents !== undefined) {
      data.actualTaxCents = args.input.actualTaxCents;
    }
    if (args.input.parcelLengthIn !== undefined) data.parcelLengthIn = args.input.parcelLengthIn;
    if (args.input.parcelWidthIn !== undefined) data.parcelWidthIn = args.input.parcelWidthIn;
    if (args.input.parcelHeightIn !== undefined) data.parcelHeightIn = args.input.parcelHeightIn;
    if (args.input.parcelWeightOz !== undefined) data.parcelWeightOz = args.input.parcelWeightOz;
    // Migration 0021 — admin can update destination from the shipping
    // panel. We persist as JSON (Prisma `Json` column) so the receipt and
    // label can both read it back without an extra join.
    if (args.input.shippingAddress !== undefined) {
      data.shippingAddress = args.input.shippingAddress as Prisma.InputJsonValue;
    }
    // Migration 0025 — method-specific fields. Buyer label only attaches
    // to BUYER_FREIGHT; pickup name + scheduled date only to PICKUP.
    if (args.input.buyerLabelUrl !== undefined) {
      data.buyerLabelUrl = args.input.buyerLabelUrl;
    }
    if (args.input.pickupName !== undefined) {
      data.pickupName = args.input.pickupName;
    }
    if (args.input.pickupScheduledAt !== undefined) {
      data.pickupScheduledAt = args.input.pickupScheduledAt;
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
        actualTaxCents: before.actualTaxCents,
        freightRateCentsPerLb: before.freightRateCentsPerLb,
        shippingCalculatedCents: before.shippingCalculatedCents,
      },
      afterState: data as Prisma.InputJsonValue,
    });
    return updated;
  }

  /**
   * Compute the follow-up plan from the current row. Pure function over
   * the loaded request; doesn't mutate. Returns null only if a required
   * actual is missing — caller should treat that as "not ready yet".
   *
   * `actualTaxCents` is treated as 0 if not yet entered — for purchases in
   * tax-free states (Oregon, Delaware, etc.) admin can leave it null and
   * the math correctly cancels against the estimated tax buyer paid at
   * intake (we owe them a refund of the full estimate).
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

    const actualTaxCents = row.actualTaxCents ?? 0;
    // Buyer paid items_subtotal + estimated_tax at intake (commission is
    // out of scope for reconciliation — non-refundable service fee).
    // Reconciliation compares "what they paid for items + tax" vs "what
    // we actually paid for items + tax + shipping".
    const intakePaidForItemsAndTax = row.itemsSubtotalCents + row.estimatedTaxCents;
    const actualForItemsTaxShipping =
      itemsActualSubtotalCents + actualTaxCents + row.shippingCostCents;
    const amountCents = actualForItemsTaxShipping - intakePaidForItemsAndTax;
    return {
      amountCents,
      itemsActualSubtotalCents,
      actualTaxCents,
      shippingCostCents: row.shippingCostCents,
      itemsSubtotalCents: row.itemsSubtotalCents,
      estimatedTaxCents: row.estimatedTaxCents,
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
        actualTaxCents: plan.actualTaxCents,
        shippingCostCents: plan.shippingCostCents,
        estimatedTaxCents: plan.estimatedTaxCents,
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

    // Buyer thank-you for the follow-up payment. Same idempotency rationale
    // as the intake-paid email — only fires when we actually transitioned.
    void this.notifyFollowupPaid(updated).catch(() => undefined);
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
  // Shipping invoice (migration 0027)
  //
  // The shipping invoice is a separate Stripe Checkout session created when
  // admin saves the shipping form for a freight-bearing method (cost > 0).
  // It gates the downstream warehouse-delivery / ship / release actions
  // until the buyer pays — the implicit "awaiting buyer to pay shipping"
  // state lives entirely in the (shippingCostCents > 0) ∧ (shippingPaidAt
  // IS NULL) tuple rather than a new status enum value so the rest of the
  // machine stays simple.
  // =========================================================================

  /**
   * Persist the Stripe Checkout session id + intent id + pay URL for the
   * shipping invoice. Best-effort — caller has already validated the
   * Stripe call succeeded. The session url is the one buyers click; we
   * cache it so the admin UI and the buyer thread can both surface it
   * without re-issuing a Checkout call.
   */
  async attachShippingSession(args: {
    requestId: string;
    sessionId: string;
    intentId: string | null;
    url: string;
  }): Promise<void> {
    await (
      this.prisma as unknown as { shopperRequest: AnyPrismaShopperRequest }
    ).shopperRequest.update({
      where: { id: args.requestId },
      data: {
        shippingInvoiceSessionId: args.sessionId,
        shippingInvoiceIntentId: args.intentId,
        shippingInvoiceUrl: args.url,
      },
    });
  }

  /**
   * Mark the shipping invoice as paid. Idempotent on the (requestId,
   * stripeIntentId) tuple so the webhook can fire as many times as
   * Stripe wants. Does NOT advance the status enum — the row simply
   * stops being gated by `shippingPaidAt IS NULL`, freeing admin to
   * call the downstream warehouse-delivery / ship / release / pickup
   * actions.
   */
  async markShippingPaid(args: {
    requestId: string;
    stripeIntentId: string;
    paidAt?: Date;
  }): Promise<RequestRow> {
    const row = await this.getById(args.requestId, { includeLines: false });
    // Cast around stale Prisma client — migration 0027's columns may not
    // be in the generated types yet on this build.
    const rowAny = row as unknown as {
      shippingPaidAt: Date | null;
      shippingInvoiceIntentId: string | null;
    };
    if (rowAny.shippingPaidAt && rowAny.shippingInvoiceIntentId === args.stripeIntentId) {
      return row; // Idempotent webhook replay.
    }
    const now = args.paidAt ?? new Date();
    const updated = await (
      this.prisma as unknown as { shopperRequest: AnyPrismaShopperRequest }
    ).shopperRequest.update({
      where: { id: args.requestId },
      data: {
        shippingPaidAt: now,
        shippingInvoiceIntentId: args.stripeIntentId,
      },
    });
    await this.audit.log({
      action: "shopper.shipping.paid",
      resourceType: "shopper_request",
      resourceId: args.requestId,
      afterState: { stripeIntentId: args.stripeIntentId, paidAt: now.toISOString() },
    });
    return updated;
  }

  /**
   * Gate helper for the four downstream actions (warehouse-delivery,
   * ship, release-with-buyer-label, mark-picked-up). Throws a 409 when
   * the request is on a freight-bearing method with a positive shipping
   * cost and the buyer hasn't paid the shipping invoice yet.
   *
   * Methods with `shippingCostCents === 0` (BUYER_FREIGHT, PICKUP, or
   * pre-0027 rows where shipping was zero-rated) bypass the gate
   * entirely — there's no invoice to wait for. Historical rows created
   * before migration 0027 with `shippingPaidAt = NULL` are treated as
   * paid for backward compatibility (we can't retroactively know
   * whether they paid; admin would have already shipped them).
   */
  private assertShippingPaid(row: RequestRow, action: string): void {
    const cost = (row as unknown as { shippingCostCents: number | null }).shippingCostCents ?? 0;
    if (cost <= 0) return; // Freight-free method — no invoice required.
    const paidAt = (row as unknown as { shippingPaidAt: Date | null }).shippingPaidAt;
    if (paidAt) return;
    throw new ConflictException({
      message:
        "Buyer hasn't paid the shipping invoice yet. Wait for the payment to clear before continuing.",
      code: "shopper_shipping_not_paid",
      action,
      shippingCostCents: cost,
    });
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
    // Migration 0027 — gate on shipping-invoice payment.
    this.assertShippingPaid(row, "ship");
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

  /**
   * Migration 0025 — release a BUYER_FREIGHT shipment.
   *
   * Identical state transition as markShipped (READY_TO_SHIP → SHIPPED)
   * but the tracking + carrier come from the buyer's prepaid label
   * rather than our Shippo purchase. Kept as a separate method so the
   * audit log distinguishes "we shipped on our carrier" from "we
   * released on the buyer's label" — both are SHIPPED rows but the
   * accounting/freight handling differs.
   *
   * We require the row to actually be on BUYER_FREIGHT to use this
   * path; PLATFORM_FREIGHT and BUYER_FORWARDER must go through
   * markShipped (which buys the label via Shippo). The buyer label URL
   * must be set before this is called — that's how the form prevents
   * "ship without label uploaded".
   */
  async releaseWithBuyerLabel(args: {
    requestId: string;
    input: AdminReleaseWithBuyerLabelInput;
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
    // Cast through unknown because the generated Prisma client may still
    // be stale (migration 0025a hasn't been picked up locally). The
    // string comparison is safe — runtime values match the enum.
    const method = (row as unknown as { shippingMethod: string | null }).shippingMethod;
    const buyerLabelUrl = (row as unknown as { buyerLabelUrl: string | null }).buyerLabelUrl;
    if (method !== "BUYER_FREIGHT") {
      throw new ConflictException({
        message:
          "This action is only valid for BUYER_FREIGHT requests. Use 'Ship' for platform / forwarder freight.",
        code: "shopper_ship_wrong_method",
        shippingMethod: method,
      });
    }
    if (!buyerLabelUrl) {
      throw new ConflictException({
        message: "Upload the buyer's shipping label before releasing.",
        code: "shopper_buyer_label_missing",
      });
    }
    // Migration 0027 — gate on shipping-invoice payment. BUYER_FREIGHT is
    // zero-cost so this is effectively a no-op for the happy path; kept
    // as defence-in-depth in case admin manually set a non-zero cost.
    this.assertShippingPaid(row, "release_with_buyer_label");
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
      action: "shopper.released_with_buyer_label",
      resourceType: "shopper_request",
      resourceId: args.requestId,
      afterState: {
        carrier: args.input.carrier,
        trackingNumber: args.input.trackingNumber,
        buyerLabelUrl,
      },
    });
    return updated;
  }

  /**
   * Migration 0025 — record an in-person pickup.
   *
   * Only valid for PICKUP-method requests in READY_FOR_PICKUP state.
   * Transitions to DELIVERED (terminal) and stamps pickupCompletedAt
   * so the receipt can show "Picked up on …" instead of "Shipped on …".
   * We deliberately don't write carrier/trackingNumber — there's no
   * carrier in this flow.
   */
  async markPickedUp(args: {
    requestId: string;
    input: AdminMarkPickedUpInput;
    actorId: string;
  }) {
    const row = await this.getById(args.requestId, { includeLines: false });
    // Cast around the stale Prisma client — migration 0025a's new enum
    // values (BUYER_FREIGHT, READY_FOR_PICKUP) aren't in the generated
    // types yet. Runtime values match the schema.
    const method = (row as unknown as { shippingMethod: string | null }).shippingMethod;
    const status = (row as unknown as { status: string }).status;
    if (method !== "PICKUP") {
      throw new ConflictException({
        message: "Only PICKUP-method requests can be marked picked up.",
        code: "shopper_pickup_wrong_method",
        shippingMethod: method,
      });
    }
    if (status !== "READY_FOR_PICKUP") {
      throw new ConflictException({
        message: "Request is not ready for pickup yet.",
        code: "shopper_pickup_invalid_state",
        status,
      });
    }
    // Migration 0027 — PICKUP is zero-cost so the gate is normally a
    // no-op; defence-in-depth in case admin manually charged shipping.
    this.assertShippingPaid(row, "mark_picked_up");
    const now = new Date();
    const updated = await (
      this.prisma as unknown as { shopperRequest: AnyPrismaShopperRequest }
    ).shopperRequest.update({
      // Same string-cast for the new enum value; the column accepts it
      // at the DB level once migration 0025a is applied.
      where: { id: args.requestId, status: "READY_FOR_PICKUP" as never },
      data: {
        status: "DELIVERED",
        pickupCompletedAt: now,
        deliveredAt: now,
      },
    });
    await this.audit.log({
      actorId: args.actorId,
      action: "shopper.picked_up",
      resourceType: "shopper_request",
      resourceId: args.requestId,
      afterState: {
        pickupCompletedAt: now,
        note: args.input.note ?? null,
      },
    });
    // Security audit L-1 — terminal state, revoke active magic-links.
    void this.tokens.revokeAllForRequest(args.requestId).catch(() => undefined);
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
    // Buyer delivery confirmation. Best-effort.
    void this.notifyDelivered(updated).catch(() => undefined);
    // Security audit L-1 — revoke any active magic-link tokens on
    // terminal state. The buyer can still receive a fresh link by
    // contacting support if they need to reopen the thread; what we
    // close is the ambient "anyone with this URL can read the order"
    // exposure.
    void this.tokens.revokeAllForRequest(args.requestId).catch(() => undefined);
    return updated;
  }

  // =========================================================================
  // Cancellation
  // =========================================================================

  /**
   * Cancel a request. The controller is responsible for issuing any Stripe
   * refunds and passing the resulting refund ids in here so we can persist
   * them on the row — that way support can correlate our cancel record
   * with the Stripe refunds without grepping audit timestamps.
   *
   * `refundedAmountCents` is the actual cents that moved back to the buyer
   * (sum of intake refund + followup refund). Used purely for the audit
   * row's afterState — the row itself stores ids, not amounts.
   */
  async cancel(args: {
    requestId: string;
    reason: string;
    // Actor is the user id when admin-initiated; null when the cancel comes
    // from a Stripe webhook (no human in the loop). Audit log allows null.
    actorId: string | null;
    intakeRefundId?: string | null;
    followupRefundId?: string | null;
    refundedAmountCents?: number;
  }) {
    const row = await this.getById(args.requestId, { includeLines: false });
    if (row.status === "DELIVERED" || row.status === "CANCELLED" || row.status === "REFUNDED") {
      throw new ConflictException({
        message: "Cannot cancel a completed or already cancelled request.",
        code: "shopper_cancel_invalid_state",
        status: row.status,
      });
    }
    // Refund happened iff at least one refund id was issued OR the caller
    // recorded a positive refunded amount. Status splits accordingly:
    // REFUNDED is the terminal state when money moved back; CANCELLED is
    // for "no payment ever happened" (or admin chose not to refund).
    const refundIssued =
      !!args.intakeRefundId ||
      !!args.followupRefundId ||
      (args.refundedAmountCents != null && args.refundedAmountCents > 0);
    const newStatus: ShopperRequestStatus = refundIssued ? "REFUNDED" : "CANCELLED";
    const updateData: Record<string, unknown> = { status: newStatus };
    if (args.intakeRefundId) updateData.cancelIntakeRefundId = args.intakeRefundId;
    if (args.followupRefundId) updateData.cancelFollowupRefundId = args.followupRefundId;

    const updated = await (
      this.prisma as unknown as { shopperRequest: AnyPrismaShopperRequest }
    ).shopperRequest.update({
      where: { id: args.requestId },
      data: updateData,
    });
    await this.audit.log({
      actorId: args.actorId,
      action: refundIssued ? "shopper.refunded" : "shopper.cancelled",
      resourceType: "shopper_request",
      resourceId: args.requestId,
      beforeState: { status: row.status },
      afterState: {
        status: newStatus,
        reason: args.reason,
        intakeRefundId: args.intakeRefundId ?? null,
        followupRefundId: args.followupRefundId ?? null,
        refundedAmountCents: args.refundedAmountCents ?? 0,
      },
    });
    // Security audit L-1 — terminal state, revoke active magic-links so
    // the cancelled request can no longer be reopened from a bookmarked
    // URL or forwarded email.
    void this.tokens.revokeAllForRequest(args.requestId).catch(() => undefined);
    // Buyer cancel/refund email. Best-effort. The reason field IS shown to
    // the buyer — admin sees this warning in the UI before clicking cancel.
    void this.notifyCancelled(updated, {
      reason: args.reason,
      refundedAmountCents: args.refundedAmountCents ?? 0,
    }).catch(() => undefined);
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

  // -------------------------------------------------------------------------
  // Buyer email notifications. Each mints a fresh magic-link token (we don't
  // store plaintext) so the email always contains a working URL, and uses a
  // stable idempotency key so Resend de-dupes if a webhook double-fires.
  // -------------------------------------------------------------------------

  private async notifyIntakePaid(row: RequestRow): Promise<void> {
    const issued = await this.tokens.issue(row.id);
    const tpl = shopperIntakePaidTemplate({
      reference: row.reference,
      threadToken: issued.plaintext,
      intakeTotalCents: row.intakeTotalCents,
    });
    await this.email.send({
      to: row.buyerEmail,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      idempotencyKey: `shopper:intake_paid_email:${row.id}`,
      type: "shopper.intake_paid",
    });
  }

  private async notifyFollowupPaid(row: RequestRow): Promise<void> {
    const issued = await this.tokens.issue(row.id);
    const amount = row.followupAmountCents ?? 0;
    const tpl = shopperFollowupPaidTemplate({
      reference: row.reference,
      threadToken: issued.plaintext,
      amountCents: amount > 0 ? amount : 0,
    });
    await this.email.send({
      to: row.buyerEmail,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      idempotencyKey: `shopper:followup_paid_email:${row.id}`,
      type: "shopper.followup_paid",
    });
  }

  private async notifyDelivered(row: RequestRow): Promise<void> {
    const issued = await this.tokens.issue(row.id);
    const tpl = shopperDeliveredTemplate({
      reference: row.reference,
      threadToken: issued.plaintext,
    });
    await this.email.send({
      to: row.buyerEmail,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      idempotencyKey: `shopper:delivered_email:${row.id}`,
      type: "shopper.delivered",
    });
  }

  private async notifyCancelled(
    row: RequestRow,
    args: { reason: string; refundedAmountCents: number },
  ): Promise<void> {
    const issued = await this.tokens.issue(row.id);
    const tpl = shopperCancelledTemplate({
      reference: row.reference,
      threadToken: issued.plaintext,
      reason: args.reason,
      refundedAmountCents: args.refundedAmountCents,
    });
    await this.email.send({
      to: row.buyerEmail,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      // Idempotency key uses status so repeated cancel→reactivate→cancel
      // would still send, but a single cancel never duplicates.
      idempotencyKey: `shopper:cancelled_email:${row.id}:${row.status}`,
      type: "shopper.cancelled",
    });
  }

  // =========================================================================
  // Migration 0023 — wire-transfer / ID-verification state machine.
  //
  // Lifecycle (only relevant to paymentMethod = WIRE rows):
  //
  //   AWAITING_ID_VERIFICATION
  //        │  buyer uploads ID document + selfie
  //        ▼
  //   ID_UNDER_REVIEW
  //        │  admin approves                ──► QUOTE_SENT
  //        │  admin rejects (reason)        ──► AWAITING_ID_VERIFICATION
  //        ▼
  //   QUOTE_SENT (= bank instructions revealed to buyer)
  //        │  buyer wires + uploads proof
  //        ▼
  //   WIRE_PROOF_UPLOADED → WIRE_UNDER_REVIEW (alias; we go straight to UNDER_REVIEW)
  //        │  admin confirms                ──► WIRE_CONFIRMED → PURCHASE_APPROVED → PROCURING
  //        │  admin rejects (reason)        ──► AWAITING_WIRE_PAYMENT
  //        ▼
  //   PURCHASE_APPROVED → PROCURING (rejoins existing pipeline)
  //
  // Each transition is a single `where: { id, status: <expected> }` Prisma
  // update so two admins clicking at once produce ONE state change and the
  // loser sees a 409, not a corrupt row.
  // =========================================================================

  /**
   * Buyer-side action — they uploaded ID + selfie via presigned R2 PUTs and
   * are now telling the server the URLs. Validates the request is on the
   * WIRE rail and at a state where re-upload is permitted (PENDING_UPLOAD
   * or REJECTED — the buyer may need to re-submit after a rejection).
   *
   * On success the status moves to ID_UNDER_REVIEW and the ID-verification
   * status flips to UNDER_REVIEW. No email here — the admin sees the queue.
   */
  async submitIdUploads(args: {
    requestId: string;
    idDocumentUrl: string;
    idSelfieUrl: string;
  }): Promise<RequestRow> {
    const before = await this.getById(args.requestId, { includeLines: false });
    if (before.paymentMethod !== "WIRE") {
      throw new BadRequestException({
        message: "This request doesn't require ID verification.",
        code: "shopper_id_not_required",
      });
    }
    // The buyer can submit/replace uploads while waiting for their first
    // review OR after a rejection asking them to try again. Once we approve
    // (or the request progresses past the ID stage entirely) the upload is
    // locked — they can't replace an approved ID without admin intervention.
    const allowed = ["AWAITING_ID_VERIFICATION", "ID_UNDER_REVIEW"];
    if (
      !allowed.includes(before.status as string) &&
      before.idVerificationStatus !== "REJECTED"
    ) {
      throw new ConflictException({
        message: "ID can no longer be re-submitted at this stage.",
        code: "shopper_id_locked",
        status: before.status,
        idVerificationStatus: before.idVerificationStatus,
      });
    }

    const updated = await (
      this.prisma as unknown as { shopperRequest: AnyPrismaShopperRequest }
    ).shopperRequest.update({
      where: { id: args.requestId },
      data: {
        idDocumentUrl: args.idDocumentUrl,
        idSelfieUrl: args.idSelfieUrl,
        idVerificationStatus: "UNDER_REVIEW" as unknown as never,
        // Snap status forward only if we're still waiting on the upload.
        // A buyer fixing a rejection stays on the ID review track.
        status: ("ID_UNDER_REVIEW" as unknown) as never,
        // Clear any previous rejection reason — admin will write a new one
        // if they reject this fresh submission.
        idRejectionReason: null,
      },
    });

    await this.audit.log({
      action: "shopper.id.submit",
      resourceType: "shopper_request",
      resourceId: args.requestId,
      beforeState: {
        status: before.status,
        idVerificationStatus: before.idVerificationStatus,
      },
      afterState: {
        status: "ID_UNDER_REVIEW",
        idVerificationStatus: "UNDER_REVIEW",
        idDocumentUrl: args.idDocumentUrl,
        idSelfieUrl: args.idSelfieUrl,
      },
    });

    return updated;
  }

  /**
   * Admin approves the buyer's ID. Moves the request to QUOTE_SENT — the
   * thread page starts rendering bank-transfer instructions and the buyer
   * gets a "your ID has been approved, here's how to pay" email.
   *
   * Note: we don't email from this method — the controller composes the
   * email after this returns so it can include the chat thread message
   * link with a freshly issued token.
   */
  async approveIdVerification(args: {
    requestId: string;
    actorId: string;
    /**
     * Migration 0026 — optional per-request bank instructions. When
     * present, persisted alongside the approval and used by the
     * buyer-facing thread response in preference to the global config.
     * The Zod schema in the controller guarantees `accountNumber` is
     * non-empty when this object is provided.
     */
    bankInstructions?: ShopperWireBankInstructions;
  }): Promise<RequestRow> {
    const before = await this.getById(args.requestId, { includeLines: false });
    if (before.paymentMethod !== "WIRE") {
      throw new BadRequestException({
        message: "This request isn't on the wire-transfer track.",
        code: "shopper_id_not_required",
      });
    }
    if (before.idVerificationStatus !== "UNDER_REVIEW") {
      throw new ConflictException({
        message: "ID is not currently under review.",
        code: "shopper_id_not_under_review",
        idVerificationStatus: before.idVerificationStatus,
      });
    }

    // Build the persisted data object up-front so the audit log can
    // capture exactly what changed (including bank instructions when
    // provided — sensitive field, so the audit trail is the only
    // historical record).
    const updateData: Record<string, unknown> = {
      idVerificationStatus: "APPROVED",
      idVerifiedAt: new Date(),
      idVerifiedById: args.actorId,
      idRejectionReason: null,
      status: "QUOTE_SENT",
    };
    if (args.bankInstructions) {
      updateData.wireBankInstructions =
        args.bankInstructions as unknown as Prisma.InputJsonValue;
    }

    const updated = await (
      this.prisma as unknown as { shopperRequest: AnyPrismaShopperRequest }
    ).shopperRequest.update({
      where: { id: args.requestId, status: "ID_UNDER_REVIEW" as unknown as never },
      data: updateData as never,
    }).catch((err) => {
      if (this.isPrismaNotFound(err)) {
        throw new ConflictException({
          message: "Status changed while you were approving. Refresh and try again.",
          code: "shopper_id_status_conflict",
        });
      }
      throw err;
    });

    await this.audit.log({
      actorId: args.actorId,
      action: "shopper.id.approved",
      resourceType: "shopper_request",
      resourceId: args.requestId,
      beforeState: { status: before.status, idVerificationStatus: before.idVerificationStatus },
      afterState: {
        status: "QUOTE_SENT",
        idVerificationStatus: "APPROVED",
        // Audit the account number so finance can later answer
        // "what did we tell this buyer to wire to?" without digging
        // through chat history.
        bankInstructions: args.bankInstructions ?? null,
      },
    });

    return updated;
  }

  /**
   * Admin rejects the ID. The reason is shown to the buyer so they know
   * what to fix; we never reject silently. Status returns to
   * AWAITING_ID_VERIFICATION so the buyer's uploader is re-enabled.
   */
  async rejectIdVerification(args: {
    requestId: string;
    reason: string;
    actorId: string;
  }): Promise<RequestRow> {
    const before = await this.getById(args.requestId, { includeLines: false });
    if (before.paymentMethod !== "WIRE") {
      throw new BadRequestException({
        message: "This request isn't on the wire-transfer track.",
        code: "shopper_id_not_required",
      });
    }
    if (before.idVerificationStatus !== "UNDER_REVIEW") {
      throw new ConflictException({
        message: "ID is not currently under review.",
        code: "shopper_id_not_under_review",
        idVerificationStatus: before.idVerificationStatus,
      });
    }

    const updated = await (
      this.prisma as unknown as { shopperRequest: AnyPrismaShopperRequest }
    ).shopperRequest.update({
      where: { id: args.requestId, status: "ID_UNDER_REVIEW" as unknown as never },
      data: {
        idVerificationStatus: "REJECTED" as unknown as never,
        idRejectionReason: args.reason,
        idVerifiedAt: null,
        idVerifiedById: null,
        status: "AWAITING_ID_VERIFICATION" as unknown as never,
      },
    }).catch((err) => {
      if (this.isPrismaNotFound(err)) {
        throw new ConflictException({
          message: "Status changed while you were rejecting. Refresh and try again.",
          code: "shopper_id_status_conflict",
        });
      }
      throw err;
    });

    await this.audit.log({
      actorId: args.actorId,
      action: "shopper.id.rejected",
      resourceType: "shopper_request",
      resourceId: args.requestId,
      beforeState: { status: before.status, idVerificationStatus: before.idVerificationStatus },
      afterState: {
        status: "AWAITING_ID_VERIFICATION",
        idVerificationStatus: "REJECTED",
        rejectionReason: args.reason,
      },
    });

    return updated;
  }

  /**
   * Buyer uploaded their wire-transfer proof. Validates that the request
   * is in a state where a wire proof makes sense (QUOTE_SENT or
   * AWAITING_WIRE_PAYMENT after a rejected proof). Moves the status to
   * WIRE_UNDER_REVIEW so the admin queue picks it up.
   */
  async submitWireProof(args: {
    requestId: string;
    wireProofUrl: string;
  }): Promise<RequestRow> {
    const before = await this.getById(args.requestId, { includeLines: false });
    if (before.paymentMethod !== "WIRE") {
      throw new BadRequestException({
        message: "This request isn't on the wire-transfer track.",
        code: "shopper_wire_not_applicable",
      });
    }
    if (before.idVerificationStatus !== "APPROVED") {
      throw new BadRequestException({
        message: "ID must be verified before submitting wire proof.",
        code: "shopper_wire_id_not_verified",
      });
    }
    const allowed = ["QUOTE_SENT", "AWAITING_WIRE_PAYMENT", "WIRE_PROOF_UPLOADED", "WIRE_UNDER_REVIEW"];
    if (!allowed.includes(before.status as string)) {
      throw new ConflictException({
        message: "Wire proof can only be uploaded after we've sent your quote.",
        code: "shopper_wire_proof_invalid_state",
        status: before.status,
      });
    }

    const updated = await (
      this.prisma as unknown as { shopperRequest: AnyPrismaShopperRequest }
    ).shopperRequest.update({
      where: { id: args.requestId },
      data: {
        wireProofUrl: args.wireProofUrl,
        wireProofUploadedAt: new Date(),
        wireConfirmedAt: null,
        wireConfirmedById: null,
        status: "WIRE_UNDER_REVIEW" as unknown as never,
      },
    });

    await this.audit.log({
      action: "shopper.wire.proof_submitted",
      resourceType: "shopper_request",
      resourceId: args.requestId,
      beforeState: { status: before.status },
      afterState: {
        status: "WIRE_UNDER_REVIEW",
        wireProofUrl: args.wireProofUrl,
      },
    });

    return updated;
  }

  /**
   * Admin confirms the wire payment landed. The request transitions
   * WIRE_UNDER_REVIEW → WIRE_CONFIRMED → PURCHASE_APPROVED → PROCURING in
   * a single conceptual step. We collapse the intermediate statuses into
   * a single audit-logged transition with a short window where the row is
   * briefly in WIRE_CONFIRMED — useful if the wire ledger lookup fails so
   * admin sees exactly where we got stuck.
   */
  async confirmWirePayment(args: {
    requestId: string;
    actorId: string;
  }): Promise<RequestRow> {
    const before = await this.getById(args.requestId, { includeLines: false });
    if (before.paymentMethod !== "WIRE") {
      throw new BadRequestException({
        message: "This request isn't on the wire-transfer track.",
        code: "shopper_wire_not_applicable",
      });
    }
    if (before.status !== "WIRE_UNDER_REVIEW" && before.status !== "WIRE_PROOF_UPLOADED") {
      throw new ConflictException({
        message: "Wire payment is not currently under review.",
        code: "shopper_wire_not_under_review",
        status: before.status,
      });
    }

    const updated = await (
      this.prisma as unknown as { shopperRequest: AnyPrismaShopperRequest }
    ).shopperRequest.update({
      where: { id: args.requestId },
      data: {
        wireConfirmedAt: new Date(),
        wireConfirmedById: args.actorId,
        // Snap straight to PROCURING — the WIRE_CONFIRMED / PURCHASE_APPROVED
        // statuses are conceptually intermediate. The audit log captures the
        // full chain so finance can reconstruct the moment money landed.
        // intakePaidAt is reused to mirror the STRIPE-rail timestamp; downstream
        // consumers (receipts, reports) read that field uniformly.
        intakePaidAt: new Date(),
        status: "PROCURING" as unknown as never,
      },
    });

    await this.audit.log({
      actorId: args.actorId,
      action: "shopper.wire.confirmed",
      resourceType: "shopper_request",
      resourceId: args.requestId,
      beforeState: { status: before.status },
      afterState: {
        status: "PROCURING",
        wireConfirmedAt: new Date().toISOString(),
        // Chain of intermediate statuses we collapsed through, for audit
        // forensics ("what did finance see at every step?").
        chain: ["WIRE_CONFIRMED", "PURCHASE_APPROVED", "PROCURING"],
      },
    });

    return updated;
  }

  /**
   * Admin rejects the wire proof — the screenshot didn't match the
   * statement, the amount is short, the reference is wrong, etc. Status
   * returns to AWAITING_WIRE_PAYMENT so the buyer can resubmit. The
   * rejection reason is exposed to the buyer.
   */
  async rejectWireProof(args: {
    requestId: string;
    reason: string;
    actorId: string;
  }): Promise<RequestRow> {
    const before = await this.getById(args.requestId, { includeLines: false });
    if (before.paymentMethod !== "WIRE") {
      throw new BadRequestException({
        message: "This request isn't on the wire-transfer track.",
        code: "shopper_wire_not_applicable",
      });
    }
    if (before.status !== "WIRE_UNDER_REVIEW" && before.status !== "WIRE_PROOF_UPLOADED") {
      throw new ConflictException({
        message: "Wire payment is not currently under review.",
        code: "shopper_wire_not_under_review",
        status: before.status,
      });
    }

    const updated = await (
      this.prisma as unknown as { shopperRequest: AnyPrismaShopperRequest }
    ).shopperRequest.update({
      where: { id: args.requestId },
      data: {
        // Keep the URL on the row — the admin can compare future uploads
        // against the rejected one if there's any dispute. We don't store
        // the rejection reason in a dedicated column; it lives in the
        // chat message the controller posts so the buyer sees it inline.
        status: "AWAITING_WIRE_PAYMENT" as unknown as never,
      },
    });

    await this.audit.log({
      actorId: args.actorId,
      action: "shopper.wire.rejected",
      resourceType: "shopper_request",
      resourceId: args.requestId,
      beforeState: { status: before.status },
      afterState: {
        status: "AWAITING_WIRE_PAYMENT",
        rejectionReason: args.reason,
      },
    });

    return updated;
  }
}
