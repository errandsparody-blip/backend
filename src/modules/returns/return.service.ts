/**
 * ReturnService — vendor-side RMA creation + admin receive/inspect.
 *
 * Implementation Plan §6.7.
 *
 * Critical guarantees:
 *
 *   1. A return can only be created against an order in DELIVERED or
 *      EXCEPTION status. Pending/in-transit orders go through cancel, not RMA.
 *
 *   2. requestedQty per line must not exceed the order line's quantity (a
 *      vendor cannot return more than they ordered).
 *
 *   3. On RESTOCKED, the restocked qty is added back to the SKU's available
 *      bucket via InventoryMovement of type RETURN. Damaged / disposed qty
 *      does NOT come back to inventory.
 *
 *   4. The refund is paid via wallet.credit() with type REVERSAL — atomic
 *      against the inventory movements. Either everything happens or nothing.
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomBytes } from "node:crypto";
import type { PrismaClient, Return, ReturnStatus } from "@prisma/client";

import { loadFeeSchedule } from "../../common/fees";
import { formatOrderRef } from "../../common/order-ref";
import { PrismaService } from "../../common/prisma.service";
import type {
  CreateReturnInput,
  FinalizeReturnInput,
  InspectReturnInput,
  InstructReturnInput,
  ListReturnsInput,
  ReceiveReturnInput,
} from "../../common/schemas/return.schema";
import { AuditService } from "../audit/audit.service";
import { returnAuthorizedTemplate } from "../email/email-templates";
import { NotificationService } from "../notifications/notification.service";
import { WalletService } from "../wallet/wallet.service";

type Tx = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

@Injectable()
export class ReturnService {
  private readonly logger = new Logger(ReturnService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly wallet: WalletService,
    private readonly notifications: NotificationService,
  ) {}

  // ===========================================================================
  // Vendor — create / read / cancel
  // ===========================================================================

  async create(vendorId: string, actorId: string, input: CreateReturnInput): Promise<Return> {
    // Tenant-scoped order load.
    const order = await this.prisma.order.findFirst({
      where: { id: input.orderId, vendorId },
      include: { lines: true },
    });
    if (!order) throw new NotFoundException("Order not found.");

    // Eligibility is mode-aware.
    //   * PLATFORM_SHIP: USA Errands bought the Shippo label, so we get a
    //     real delivery signal — require DELIVERED (or EXCEPTION for a
    //     delivery problem). A customer can't return a package that
    //     hasn't arrived.
    //   * VENDOR_CARRIER ("own label"): there is NO Shippo tracking for
    //     these, so we never observe delivery. HANDED_OFF (packed +
    //     shipped on the vendor's carrier) is the earliest sane point to
    //     allow a return; the vendor/customer judges actual receipt.
    const vc = order as unknown as {
      fulfillmentMode?: string | null;
      handedOffAt?: Date | null;
    };
    const isVendorCarrier = vc.fulfillmentMode === "VENDOR_CARRIER";
    const returnableStatuses = isVendorCarrier
      ? ["HANDED_OFF", "DELIVERED", "EXCEPTION"]
      : ["DELIVERED", "EXCEPTION"];
    if (!returnableStatuses.includes(order.status)) {
      throw new ConflictException({
        message: isVendorCarrier
          ? `Returns can be opened once an order has been handed to your carrier. Current status: ${order.status}.`
          : `Returns can only be created for delivered orders. Current status: ${order.status}.`,
        code: "return_order_not_returnable",
      });
    }

    // NOTE (Returns v2): there is intentionally NO platform-enforced
    // return time window. The age limit is the vendor's own policy, not
    // USA Errands' — a return may be opened whenever, regardless of how
    // old the order is. (The returns_window_days config row is retained
    // but no longer consulted.)

    // Validate every requested line: must belong to the order, requestedQty ≤ ordered qty.
    const linesById = new Map(order.lines.map((l) => [l.id, l]));
    for (const r of input.lines) {
      const ol = linesById.get(r.orderLineId);
      if (!ol) {
        throw new BadRequestException({
          message: `Order line ${r.orderLineId} is not part of this order.`,
          code: "return_invalid_order_line",
        });
      }
      if (r.requestedQty > ol.quantity) {
        throw new BadRequestException({
          message: `Cannot return ${r.requestedQty} of line ${r.orderLineId}: only ${ol.quantity} were ordered.`,
          code: "return_qty_exceeds_order",
        });
      }
    }

    const rmaCode = this.generateRmaCode();

    // Create the return + lines in a single transaction. Status starts
    // at REQUESTED ("a return is on its way"). The customer ships the
    // return themselves, so we record the vendor-supplied inbound
    // tracking + expected delivery date and do NOT buy a label.
    //
    // New columns (inbound tracking / expected date / attachments) live
    // in the DB but the checked-in Prisma client may lag the migration,
    // so the create payload is cast through `unknown` — Railway's
    // `prisma generate` on deploy aligns the two.
    const created = await this.prisma.$transaction(async (tx) => {
      const ret = await tx.return.create({
        data: {
          vendorId,
          orderId: order.id,
          rmaCode,
          status: "REQUESTED",
          reason: input.reason,
          createdBy: actorId,
          ...({
            inboundCarrier: input.inboundCarrier ?? null,
            inboundTracking: input.inboundTracking,
            expectedDeliveryDate: input.expectedDeliveryDate,
            attachmentUrls: input.attachmentUrls ?? [],
          } as Record<string, unknown>),
          lines: {
            create: input.lines.map((l) => ({
              orderLineId: l.orderLineId,
              skuId: linesById.get(l.orderLineId)!.skuId,
              requestedQty: l.requestedQty,
            })),
          },
        } as unknown as Prisma.ReturnCreateInput,
        include: { lines: true },
      });
      return ret;
    });

    await this.audit.log({
      actorId,
      action: "return.created",
      resourceType: "return",
      resourceId: created.id,
      afterState: {
        rmaCode,
        orderId: order.id,
        lineCount: input.lines.length,
        reason: input.reason,
        inboundTracking: input.inboundTracking,
      },
    });

    // Notify the vendor + email that the return was registered and is on
    // its way to us. After-tx, best-effort.
    const tpl = returnAuthorizedTemplate({
      rmaCode: created.rmaCode,
      orderRef: formatOrderRef(order.orderNumber),
      trackingNumber: input.inboundTracking,
      inboundLabelUrl: null,
    });
    await this.notifications.emit({
      vendorId,
      type: "return.requested",
      severity: "INFO",
      title: `Return ${created.rmaCode} registered`,
      body: `We'll expect it via ${input.inboundCarrier ?? "your carrier"} (tracking ${input.inboundTracking}) and inspect it on arrival.`,
      href: "/returns",
      email: { subject: tpl.subject, html: tpl.html, text: tpl.text },
    });

    return created;
  }

  async list(vendorId: string, input: ListReturnsInput) {
    const where: Prisma.ReturnWhereInput = { vendorId };
    // Cast for the stale Prisma client: the enum union in the Zod schema
    // includes INSTRUCTED/DONATED before the generated client is
    // regenerated on deploy.
    if (input.status) where.status = input.status as unknown as ReturnStatus;

    const items = await this.prisma.return.findMany({
      where,
      include: { lines: true },
      take: input.limit + 1,
      orderBy: { createdAt: "desc" },
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    });

    let nextCursor: string | null = null;
    if (items.length > input.limit) {
      const next = items.pop();
      nextCursor = next?.id ?? null;
    }
    return { items, nextCursor };
  }

  async get(vendorId: string, id: string) {
    const ret = await this.prisma.return.findFirst({
      where: { id, vendorId },
      include: { lines: true },
    });
    if (!ret) throw new NotFoundException();
    return ret;
  }

  async cancel(vendorId: string, actorId: string, id: string) {
    const ret = await this.prisma.return.findFirst({ where: { id, vendorId } });
    if (!ret) throw new NotFoundException();
    if (!["REQUESTED", "AUTHORIZED"].includes(ret.status)) {
      throw new ConflictException({
        message: `Cannot cancel a return in ${ret.status}.`,
        code: "return_not_cancellable",
      });
    }
    const updated = await this.prisma.return.update({
      where: { id },
      data: { status: "CANCELLED", resolvedAt: new Date() },
      include: { lines: true },
    });
    await this.audit.log({
      actorId,
      action: "return.cancelled",
      resourceType: "return",
      resourceId: id,
      beforeState: { status: ret.status },
    });
    return updated;
  }

  // ===========================================================================
  // Admin — receive + inspect
  // ===========================================================================

  async adminReceive(actorId: string, id: string, input: ReceiveReturnInput) {
    return this.prisma.$transaction(async (tx) => {
      const ret = await this.lockReturn(tx, id);
      if (!["REQUESTED", "AUTHORIZED", "IN_TRANSIT"].includes(ret.status)) {
        throw new ConflictException({
          message: `Cannot receive a return in ${ret.status}.`,
          code: "return_not_receivable",
        });
      }

      const lines = await tx.returnLine.findMany({ where: { returnId: id } });
      const linesById = new Map(lines.map((l) => [l.id, l]));

      for (const r of input.lines) {
        const line = linesById.get(r.returnLineId);
        if (!line) {
          throw new BadRequestException(`Return line ${r.returnLineId} is not part of this return.`);
        }
        if (r.receivedQty > line.requestedQty) {
          throw new BadRequestException({
            message: `Received qty (${r.receivedQty}) exceeds requested (${line.requestedQty}) on line ${r.returnLineId}.`,
            code: "return_overreceive",
          });
        }
        await tx.returnLine.update({
          where: { id: r.returnLineId },
          data: { receivedQty: r.receivedQty },
        });
      }

      const updated = await tx.return.update({
        where: { id },
        data: { status: "RECEIVED", receivedAt: new Date() },
        include: { lines: true },
      });
      await this.audit.log({
        actorId,
        action: "return.received",
        resourceType: "return",
        resourceId: id,
      });
      return updated;
    });
  }

  /**
   * Admin inspection (Returns v2). Records the CONDITION of the received
   * items and the PHOTOS USA Errands took, then moves the return to
   * INSPECTED and asks the vendor for handling instructions. It does NOT
   * decide disposition and moves no money — the vendor instructs next
   * (submitInstructions) and the fee is charged at finalize.
   */
  async adminInspect(actorId: string, id: string, input: InspectReturnInput) {
    const result = await this.prisma.$transaction(async (tx) => {
      const ret = await this.lockReturn(tx, id);
      if (ret.status !== "RECEIVED") {
        throw new ConflictException({
          message: `Cannot inspect a return in ${ret.status}. Expected RECEIVED.`,
          code: "return_not_inspectable",
        });
      }

      // Persist photos + condition and advance to INSPECTED. New columns
      // (received_photo_urls) are written via a cast payload for the
      // stale-client pattern; INSPECTED is an existing enum value.
      const updated = await tx.return.update({
        where: { id },
        data: {
          status: "INSPECTED",
          inspectorNotes: input.conditionNotes,
          inspectedAt: new Date(),
          ...({ receivedPhotoUrls: input.receivedPhotoUrls } as Record<string, unknown>),
        } as unknown as Prisma.ReturnUpdateInput,
        include: { lines: true },
      });

      await this.audit.log({
        actorId,
        action: "return.inspected",
        resourceType: "return",
        resourceId: id,
        afterState: {
          status: "INSPECTED",
          photoCount: input.receivedPhotoUrls.length,
        },
      });

      return { updated, vendorId: ret.vendorId, rmaCode: ret.rmaCode };
    });

    // Notify the vendor that condition + photos are ready and we need
    // their handling instructions. Best-effort, after-tx.
    await this.notifications.emit({
      vendorId: result.vendorId,
      type: "return.inspected",
      severity: "INFO",
      title: `Return ${result.rmaCode} inspected — your instructions needed`,
      body: "We've inspected the returned items and shared photos. Tell us how to handle each item: restock, dispose, or donate.",
      href: `/returns/${result.updated.id}`,
    });

    return result.updated;
  }

  /**
   * Vendor disposition instructions (Returns v2). The vendor tells us,
   * per line, how to handle the received units — restock / dispose /
   * donate — with the three quantities summing to the received quantity.
   * Records the split on the lines and advances to INSTRUCTED. No
   * inventory or money moves yet; the admin applies it at finalize.
   */
  async submitInstructions(
    vendorId: string,
    actorId: string,
    id: string,
    input: InstructReturnInput,
  ) {
    // Tenant-scoped existence check before the lock.
    const owned = await this.prisma.return.findFirst({
      where: { id, vendorId },
      select: { id: true },
    });
    if (!owned) throw new NotFoundException();

    return this.prisma.$transaction(async (tx) => {
      const ret = await this.lockReturn(tx, id);
      if (ret.vendorId !== vendorId) throw new NotFoundException();
      if (ret.status !== "INSPECTED") {
        throw new ConflictException({
          message: `Instructions can only be given once a return is INSPECTED. Current status: ${ret.status}.`,
          code: "return_not_instructable",
        });
      }

      const lines = await tx.returnLine.findMany({ where: { returnId: id } });
      const linesById = new Map(lines.map((l) => [l.id, l]));

      // Every received line must be instructed exactly (split == received).
      const instructedIds = new Set(input.lines.map((l) => l.returnLineId));
      for (const line of lines) {
        if (line.receivedQty > 0 && !instructedIds.has(line.id)) {
          throw new BadRequestException({
            message: `Line ${line.id} has received units but no handling instruction.`,
            code: "return_line_uninstructed",
          });
        }
      }

      for (const r of input.lines) {
        const line = linesById.get(r.returnLineId);
        if (!line) {
          throw new BadRequestException({
            message: `Return line ${r.returnLineId} is not part of this return.`,
            code: "return_invalid_line",
          });
        }
        const split = r.restockQty + r.disposeQty + r.donateQty;
        if (split !== line.receivedQty) {
          throw new BadRequestException({
            message: `Instruction for line ${r.returnLineId} must account for all ${line.receivedQty} received unit(s) (got ${split}).`,
            code: "return_instruction_mismatch",
          });
        }
        // Store the vendor's chosen split on restocked/disposed/donated.
        // donatedQty is a new column → cast payload.
        await tx.returnLine.update({
          where: { id: r.returnLineId },
          data: {
            restockedQty: r.restockQty,
            disposedQty: r.disposeQty,
            ...({ donatedQty: r.donateQty } as Record<string, unknown>),
          } as unknown as Prisma.ReturnLineUpdateInput,
        });
      }

      // Advance to INSTRUCTED (new enum value → cast).
      const updated = await tx.return.update({
        where: { id },
        data: { status: "INSTRUCTED" as unknown as ReturnStatus },
        include: { lines: true },
      });

      await this.audit.log({
        actorId,
        action: "return.instructed",
        resourceType: "return",
        resourceId: id,
        afterState: { status: "INSTRUCTED" },
      });

      return updated;
    });
  }

  /**
   * Admin finalize (Returns v2). Applies the vendor's disposition:
   * restocked units go back to inventory; disposed/donated do not. Then
   * CHARGES the vendor the flat processing fee (config) plus any handling
   * cost — there is NO refund. The parent order flips to RETURNED.
   *
   * If the vendor hasn't instructed yet, finalize is blocked UNLESS a
   * `disposalOverrideReason` is supplied (legal/safety disposal), in
   * which case all received units are disposed.
   */
  async finalize(actorId: string, id: string, input: FinalizeReturnInput) {
    const feeCents = await this.loadProcessingFeeCents();

    const result = await this.prisma.$transaction(async (tx) => {
      const ret = await this.lockReturn(tx, id);

      const isOverride = !!input.disposalOverrideReason;
      const allowed = isOverride
        ? ["RECEIVED", "INSPECTED", "INSTRUCTED"]
        : ["INSTRUCTED"];
      if (!allowed.includes(ret.status)) {
        throw new ConflictException({
          message: isOverride
            ? `Cannot finalize a return in ${ret.status}.`
            : `A return needs the vendor's instructions before it can be finalized. Current status: ${ret.status}.`,
          code: "return_not_finalizable",
        });
      }

      const lines = await tx.returnLine.findMany({ where: { returnId: id } });

      let totalRestocked = 0;
      let totalDonated = 0;
      let totalDisposed = 0;

      for (const line of lines) {
        const lc = line as unknown as { donatedQty?: number };
        // On the legal/safety override path, dispose everything received.
        const restock = isOverride ? 0 : line.restockedQty;
        const donate = isOverride ? 0 : lc.donatedQty ?? 0;
        const dispose = isOverride ? line.receivedQty : line.disposedQty;

        if (isOverride) {
          await tx.returnLine.update({
            where: { id: line.id },
            data: {
              restockedQty: 0,
              disposedQty: line.receivedQty,
              ...({ donatedQty: 0 } as Record<string, unknown>),
            } as unknown as Prisma.ReturnLineUpdateInput,
          });
        }

        // Only restocked units return to available inventory.
        if (restock > 0) {
          await tx.sku.update({
            where: { id: line.skuId },
            data: { quantityAvailable: { increment: restock } },
          });
          await tx.inventoryMovement.create({
            data: {
              vendorId: ret.vendorId,
              skuId: line.skuId,
              type: "RETURN",
              deltaAvailable: restock,
              deltaReserved: 0,
              referenceType: "return",
              referenceId: id,
              actorId,
              reason: `Return ${ret.rmaCode} restock`,
            },
          });
        }

        totalRestocked += restock;
        totalDonated += donate;
        totalDisposed += dispose;
      }

      // Charge the vendor: flat processing fee + any handling cost. This
      // is the money for the WORK of receiving + checking — never a
      // refund. wallet.debit throws insufficient_funds if the wallet
      // can't cover it, rolling back the whole finalize (admin asks the
      // vendor to top up). Both debits compose in this transaction.
      const walletTx = tx as unknown as Parameters<typeof this.wallet.debit>[1];
      if (feeCents > 0) {
        await this.wallet.debit(
          {
            vendorId: ret.vendorId,
            amountCents: feeCents,
            type: "RETURN",
            description: `Return processing fee — ${ret.rmaCode}`,
            referenceType: "return",
            referenceId: id,
            actorId,
          },
          walletTx,
        );
      }
      if (input.handlingCostCents > 0) {
        await this.wallet.debit(
          {
            vendorId: ret.vendorId,
            amountCents: input.handlingCostCents,
            type: "RETURN",
            description: `Return handling cost — ${ret.rmaCode}`,
            referenceType: "return",
            referenceId: id,
            actorId,
          },
          walletTx,
        );
      }

      // Terminal status: restocked wins, else donated, else disposed.
      const next: ReturnStatus = (
        totalRestocked > 0 ? "RESTOCKED" : totalDonated > 0 ? "DONATED" : "DISPOSED"
      ) as ReturnStatus;

      const updated = await tx.return.update({
        where: { id },
        data: {
          status: next,
          resolvedAt: new Date(),
          ...({
            processingFeeCents: feeCents,
            handlingCostCents: input.handlingCostCents,
            ...(isOverride
              ? { inspectorNotes: `Legal/safety disposal: ${input.disposalOverrideReason}` }
              : {}),
          } as Record<string, unknown>),
        } as unknown as Prisma.ReturnUpdateInput,
        include: { lines: true },
      });

      // NOTE: the parent-order status flip (→ RETURNED) is intentionally
      // NOT done here. It's a secondary reflection of the return, and the
      // order status trigger can reject DELIVERED → RETURNED unless the
      // migration-0053 whitelist is present. Doing it inside this
      // transaction would roll back the WHOLE finalize (restock + fee +
      // disposition) on any trigger rejection — the "nothing processed"
      // failure. So we commit the return's inventory + money here and
      // flip the order best-effort AFTER commit (below).

      await this.audit.log({
        actorId,
        action: "return.finalized",
        resourceType: "return",
        resourceId: id,
        afterState: {
          status: next,
          processingFeeCents: feeCents,
          handlingCostCents: input.handlingCostCents,
          totalRestocked,
          totalDonated,
          totalDisposed,
          override: isOverride,
        },
      });

      return { updated, vendorId: ret.vendorId, rmaCode: ret.rmaCode, feeCents, next, orderId: ret.orderId };
    });

    // Best-effort: flip the parent order to RETURNED so the vendor sees it
    // on the order. Runs in its OWN transaction AFTER the finalize commit,
    // so a rejection here (e.g. the migration-0053 whitelist not yet
    // applied) can't undo the completed restock/fee. Recoverable: the
    // order stays DELIVERED/HANDED_OFF but the return is fully processed.
    try {
      await this.prisma.$transaction(async (tx) => {
        const order = await tx.order.findUnique({ where: { id: result.orderId } });
        if (order && (order.status === "DELIVERED" || order.status === "HANDED_OFF")) {
          await tx.order.update({ where: { id: order.id }, data: { status: "RETURNED" } });
          await tx.orderEvent.create({
            data: {
              orderId: order.id,
              type: "order.returned",
              description: `Return ${result.rmaCode} finalized (${result.next}).`,
              source: "ADMIN",
              actorId,
            },
          });
        }
      });
    } catch (err) {
      // The return itself is finalized; only the cosmetic order-status
      // flip failed. Log so ops can reconcile (usually means migration
      // 0053 needs applying).
      this.logger.warn(
        {
          msg: "return.finalize: parent order flip to RETURNED failed (return still finalized)",
          orderId: result.orderId,
          rmaCode: result.rmaCode,
          err: err instanceof Error ? err.message : String(err),
        },
      );
    }

    // Notify the vendor of the outcome + charge. No refund is ever sent.
    const totalCharged = result.feeCents + input.handlingCostCents;
    await this.notifications.emit({
      vendorId: result.vendorId,
      type: "return.finalized",
      severity: "INFO",
      title: `Return ${result.rmaCode} finalized (${result.next})`,
      body: `Processing complete. $${(totalCharged / 100).toFixed(2)} charged to your wallet for handling this return.`,
      href: `/returns/${result.updated.id}`,
    });

    return result.updated;
  }

  /** Admin single-return read (cross-vendor; RBAC is the boundary). */
  async adminGet(id: string) {
    const ret = await this.prisma.return.findFirst({
      where: { id },
      include: { lines: true },
    });
    if (!ret) throw new NotFoundException();
    return ret;
  }

  async adminList(input: ListReturnsInput) {
    const where: Prisma.ReturnWhereInput = {};
    // Cast for the stale Prisma client: the enum union in the Zod schema
    // includes INSTRUCTED/DONATED before the generated client is
    // regenerated on deploy.
    if (input.status) where.status = input.status as unknown as ReturnStatus;
    if (input.from || input.to) {
      where.createdAt = {
        ...(input.from ? { gte: input.from } : {}),
        ...(input.to ? { lte: input.to } : {}),
      };
    }
    const items = await this.prisma.return.findMany({
      where,
      include: { lines: true, order: { select: { id: true, externalReference: true, vendorId: true } } },
      take: input.limit + 1,
      orderBy: { createdAt: "desc" },
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    });
    let nextCursor: string | null = null;
    if (items.length > input.limit) {
      const next = items.pop();
      nextCursor = next?.id ?? null;
    }
    return { items, nextCursor };
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /** RMA code: RMA-XXXXXXXX (uppercase alphanumeric, 8 chars after the prefix). */
  private generateRmaCode(): string {
    const charset = "ABCDEFGHIJKLMNPQRSTUVWXYZ23456789"; // omit 0/O/1/I for legibility
    const buf = randomBytes(8);
    let out = "";
    for (let i = 0; i < 8; i++) {
      out += charset[buf[i]! % charset.length];
    }
    return `RMA-${out}`;
  }

  /**
   * Acquire a row lock on the return, then return it via the typed
   * client so callers get camelCase fields.
   *
   * IMPORTANT: `$queryRaw` returns RAW snake_case column names
   * (`vendor_id`, `order_id`, `rma_code`), NOT the Prisma camelCase
   * fields — so we must NOT read `.vendorId` / `.rmaCode` / `.orderId`
   * off a `SELECT *` result (they'd be `undefined`). We use the raw
   * query only to take the `FOR UPDATE` lock, then re-read with
   * `findUnique` so the returned object is a real, typed `Return`.
   */
  private async lockReturn(tx: Tx, id: string): Promise<Return> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT id FROM returns WHERE id = ${id}::uuid FOR UPDATE`,
    );
    if (!locked[0]) throw new NotFoundException();
    const row = await tx.return.findUnique({ where: { id } });
    if (!row) throw new NotFoundException();
    return row;
  }

  /**
   * Read the configurable return-window cutoff in days from the
   * configuration table. Defaults to 30 (matches FBA / Amazon norms)
   * if the row is absent or the value isn't a positive integer.
   *
   * Public so the order controller can compute `returnableUntil` on
   * the order GET response without re-implementing the lookup.
   */
  async getReturnWindowDays(): Promise<number> {
    return this.loadReturnWindowDays();
  }

  private async loadReturnWindowDays(): Promise<number> {
    const FALLBACK = 30;
    const MAX = 365;
    try {
      const row = await this.prisma.configuration.findUnique({
        where: { key: "returns_window_days" },
      });
      if (!row) return FALLBACK;
      const value = row.value as unknown;
      const days = typeof value === "number" ? value : Number(value);
      if (!Number.isInteger(days) || days < 1 || days > MAX) return FALLBACK;
      return days;
    } catch {
      // Defensive: a config-table outage shouldn't block returns.
      // Fall back to the safer 30-day default.
      return FALLBACK;
    }
  }

  /**
   * Public accessor for the processing fee (cents) so the admin UI can
   * show the exact charge in the finalize preview rather than a
   * hard-coded default.
   */
  async getProcessingFeeCents(): Promise<number> {
    return this.loadProcessingFeeCents();
  }

  /**
   * The return processing fee (cents) comes from the LIVE pricing source
   * — the `fee_schedule` config row's `returnsHandlingCents` — the same
   * schedule that drives fulfillment/storage/shipping pricing. This keeps
   * returns pricing in one editable place (admin → fee schedule) rather
   * than a separate config key. (The old `returns_processing_fee_cents`
   * row from migration 0052 is no longer read.)
   *
   * Falls back to 199 ($1.99) if the schedule is missing/invalid so a
   * config outage never drops the fee to zero.
   */
  private async loadProcessingFeeCents(): Promise<number> {
    const FALLBACK = 199; // $1.99 policy default
    const MAX = 100_000; // sanity ceiling ($1,000)
    try {
      const schedule = await loadFeeSchedule(this.prisma);
      const cents = schedule.returnsHandlingCents;
      if (!Number.isInteger(cents) || cents < 0 || cents > MAX) return FALLBACK;
      return cents;
    } catch {
      return FALLBACK;
    }
  }
}
