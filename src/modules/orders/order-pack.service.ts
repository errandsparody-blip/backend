/**
 * OrderPackService — Fulfillment v2 transition machine (Migration 0042).
 *
 * Extracted from OrderService for SRP: OrderService owns the *submit*
 * lifecycle (v1 quote-then-debit, v2 fee-only-at-submit); this service
 * owns the *post-submit* v2 lifecycle where the warehouse packs the
 * order and the shipping charge is committed later.
 *
 *   Lifecycle owned here (workflowVersion=2 only):
 *
 *     PENDING_PACKING          ─┐  recordPack()  ─→  PACKING_COMPLETED
 *     PACKING_COMPLETED        ─┤  fetchRates()  ─→  AWAITING_SHIPPING_SELECTION
 *     AWAITING_SHIPPING_SELECTION ┤  selectRate() ─→  SHIPPING_PAID           (wallet covers)
 *                                 │                 └→ AWAITING_WALLET_FUNDING (wallet short)
 *     AWAITING_WALLET_FUNDING  ─┘  selectRate() (retry) — same two outcomes
 *
 *   From SHIPPING_PAID the existing label-purchase pipeline takes over
 *   (LABEL_PURCHASED → PICKING → PACKED → SHIPPED → …). Legacy (v1)
 *   orders NEVER enter this service — every method rejects them.
 *
 * SECURITY INVARIANTS
 *   1. Every mutation is wrapped in a transaction with `SELECT … FOR
 *      UPDATE` on the order row. Two concurrent selectRate() calls
 *      cannot both succeed and double-debit the wallet.
 *   2. Wallet debit is composed with the status write in the SAME
 *      transaction (WalletService.debit accepts an outer tx). Either
 *      both succeed or both roll back — the ledger and the order row
 *      cannot diverge.
 *   3. All state assertions are re-checked INSIDE the transaction
 *      after the FOR UPDATE lock, so a pre-flight read that saw
 *      "PACKING_COMPLETED" cannot be used to write over a row that
 *      raced to CANCELLED. Pre-flight reads exist only for the
 *      NotFoundException path (mirrors OrderService.cancel).
 *   4. workflowVersion is verified on EVERY entry point. A v1 order
 *      calling any of these paths returns 409 (order_wrong_workflow)
 *      rather than silently corrupting a legacy row.
 *   5. Dimension inputs are validated by Zod at the controller layer
 *      before they reach this service, but the service ALSO asserts
 *      strictly positive numbers as a defense in depth.
 *   6. Idempotency: recordPack rejects a second write with 409
 *      order_already_packed. selectRate on a row already SHIPPING_PAID
 *      returns the current state without a second debit.
 *   7. Audit trail: every state transition produces an audit-log row
 *      with before/after JSON.
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, type OrderStatus } from "@prisma/client";

import { loadConfig } from "../../common/config";
import { formatOrderRef } from "../../common/order-ref";
import { PrismaService } from "../../common/prisma.service";
import { CarrierPackagingRegistryService } from "../../common/services/carrier-packaging-registry";
import { PackagingLibraryService } from "../../common/services/packaging-library.service";
import { AuditService } from "../audit/audit.service";
import { NotificationService } from "../notifications/notification.service";
import {
  ShippoService,
  type CustomsDeclaration,
  type LabelResponse,
  type ShippingRate,
} from "../integrations/shippo/shippo.service";
import { WalletService } from "../wallet/wallet.service";

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

export interface RecordPackInput {
  lengthIn: number;
  widthIn: number;
  heightIn: number;
  weightOz: number;
  notes?: string | undefined;
  /**
   * Migration 0043 — optional packaging library preset. When present,
   * `lengthIn` / `widthIn` / `heightIn` are IGNORED and the preset's
   * dimensions win (source of truth = the library). `weightOz` is
   * treated as GOODS weight; the preset's `tareWeightOz` is added on
   * top to arrive at the parcel weight sent to Shippo.
   */
  packagingOptionId?: string | undefined;
  /**
   * Migration 0049 / Phase N — direct carrier packaging template
   * (Option A in the spec). Provided when the operator selected from
   * the "Carrier packaging" tab in the pack modal. Mutually
   * exclusive with `packagingOptionId` from the pack UI, but the
   * server accepts both: if `packagingOptionId` is set AND the
   * resolved library preset has its own `shippoTemplate`, that value
   * flows through. Direct `shippoTemplate` on the input wins over the
   * library preset when both are provided.
   *
   * Validated against KNOWN_CARRIER_TEMPLATES so a spoofed value can't
   * reach the Shippo rate request.
   */
  shippoTemplate?: string | undefined;
}

export interface PackResult {
  orderId: string;
  status: OrderStatus;
  packedLengthIn: number;
  packedWidthIn: number;
  packedHeightIn: number;
  packedWeightOz: number;
  packedAt: string;
  packedByUserId: string;
  packingNotes: string | null;
  /** Set only when a library preset was selected. */
  packagingOptionId: string | null;
  /**
   * Migration 0049 / Phase N — Shippo carrier template that will be
   * passed to `parcel.template` on the rate request. Set when the
   * operator chose a carrier template directly OR chose a library
   * preset whose shippo_template is non-null. NULL for pure ad-hoc /
   * custom packaging (weight-based rates).
   */
  parcelTemplate: string | null;
}

export interface RateOption {
  rateProviderRef: string;
  shipmentProviderRef: string;
  carrier: string;
  service: string;
  costCents: number;
  estimatedDeliveryDays: number;
  fetchedAt: string;
}

export interface FetchRatesResult {
  orderId: string;
  status: OrderStatus;
  options: RateOption[];
}

/**
 * Phase P-C — internal discriminated union returned by the selectRate
 * transaction body. Not exported: the public shape is
 * `SelectRateOutcome` below, computed AFTER the label-purchase step.
 */
type DebitInnerResult =
  | {
      committed: "SHIPPING_PAID";
      vendorId: string;
      balanceAfterCents: number;
      shippingCostCents: number;
      shipmentProviderRef: string;
      rateProviderRef: string;
      carrier: string;
      service: string;
    }
  | {
      outcome: "AWAITING_WALLET_FUNDING";
      walletBalanceCents: number;
      requiredCents: number;
      carrier: string;
      service: string;
      rateProviderRef: string;
    };

export type SelectRateOutcome =
  | {
      /**
       * Phase P-C — happy path. Wallet debited AND label purchased in
       * one selectRate call, per spec Step 7 ("Purchase label through
       * Shippo … will be the last step to completing an order
       * fulfillment request"). Order status advances to LABEL_PURCHASED.
       */
      outcome: "LABEL_PURCHASED";
      balanceAfterCents: number;
      shippingCostCents: number;
      carrier: string;
      service: string;
      rateProviderRef: string;
      trackingNumber: string;
      labelUrl: string;
    }
  | {
      /**
       * Wallet was short. Order sits in AWAITING_WALLET_FUNDING until
       * vendor tops up and operator retries. No wallet activity, no
       * label purchase attempted.
       */
      outcome: "AWAITING_WALLET_FUNDING";
      walletBalanceCents: number;
      requiredCents: number;
      carrier: string;
      service: string;
      rateProviderRef: string;
    };

// ---------------------------------------------------------------------------

@Injectable()
export class OrderPackService {
  private readonly logger = new Logger(OrderPackService.name);
  private readonly cfg = loadConfig();
  private readonly warehouseOrigin = {
    state: this.cfg.WAREHOUSE_FROM_STATE,
    postalCode: this.cfg.WAREHOUSE_FROM_ZIP,
    country: "US",
  } as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly wallet: WalletService,
    private readonly shippo: ShippoService,
    // Migration 0043 — resolves a selected preset's dimensions and
    // tare weight at recordPack. Injected via the @Global()
    // PackagingLibraryModule.
    private readonly packagingLibrary: PackagingLibraryService,
    // Migration 0049 / Phase N — validates carrier-template inputs and
    // (in Phase N4b) fills in the canonical dims when the operator
    // picked a carrier template directly.
    private readonly carrierRegistry: CarrierPackagingRegistryService,
    // VENDOR_CARRIER hand-off — notifies the vendor when their own-carrier
    // order is packed + handed off (parity with the legacy
    // AdminOrderService.markHandedOff notification). NotificationModule
    // is already imported by OrderModule.
    private readonly notifications: NotificationService,
  ) {}

  // =========================================================================
  // Read helpers
  // =========================================================================

  /**
   * Admin pack queue — orders sitting in PENDING_PACKING, oldest first.
   * Limited to workflowVersion=2 by definition (only v2 orders enter
   * PENDING_PACKING). Vendor is joined for the queue label.
   */
  async listPackQueue(input: { limit: number }): Promise<
    Array<{
      id: string;
      orderNumber: number;
      vendorBusinessName: string;
      lineCount: number;
      submittedAt: string | null;
      recipientName: string;
      shipCity: string;
      shipState: string;
    }>
  > {
    const rows = await this.prisma.order.findMany({
      where: {
        status: "PENDING_PACKING" as OrderStatus,
      },
      orderBy: { createdAt: "asc" },
      take: input.limit,
      include: {
        vendor: { select: { businessName: true } },
        _count: { select: { lines: true } },
      },
    });
    return rows.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      vendorBusinessName: o.vendor?.businessName ?? "—",
      lineCount: o._count.lines,
      submittedAt: o.submittedAt?.toISOString() ?? null,
      recipientName: o.recipientName,
      shipCity: o.shipCity,
      shipState: o.shipState,
    }));
  }

  /**
   * Admin rate-picker queue — orders where the warehouse packed and
   * the admin needs to pick a carrier. Includes rows stuck in
   * AWAITING_WALLET_FUNDING so admins can re-fetch or re-attempt the
   * selection once the vendor tops up.
   */
  async listRateQueue(input: { limit: number }): Promise<
    Array<{
      id: string;
      orderNumber: number;
      status: OrderStatus;
      vendorBusinessName: string;
      packedAt: string | null;
      lineCount: number;
    }>
  > {
    const targetStatuses: OrderStatus[] = [
      "PACKING_COMPLETED" as OrderStatus,
      "AWAITING_SHIPPING_SELECTION" as OrderStatus,
      "AWAITING_WALLET_FUNDING" as OrderStatus,
    ];
    const rows = await this.prisma.order.findMany({
      where: { status: { in: targetStatuses } },
      orderBy: { updatedAt: "asc" },
      take: input.limit,
      include: {
        vendor: { select: { businessName: true } },
        _count: { select: { lines: true } },
      },
    });
    // Defensive exclusion: VENDOR_CARRIER ("use my own carrier") orders
    // have no platform label to buy, so they must never appear in the
    // rate picker. recordPack already diverts them straight to
    // HANDED_OFF, so in normal operation none reach these statuses — but
    // filter here too so any order left in PACKING_COMPLETED from before
    // this fix can't strand an operator on the label-purchase screen.
    // (fulfillmentMode is read via cast for the stale-Prisma-client
    // pattern used elsewhere in this codebase.)
    const visible = rows.filter(
      (o) =>
        (o as unknown as { fulfillmentMode?: string | null }).fulfillmentMode !==
        "VENDOR_CARRIER",
    );
    return visible.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      status: o.status,
      vendorBusinessName: o.vendor?.businessName ?? "—",
      packedAt: o.packedAt?.toISOString() ?? null,
      lineCount: o._count.lines,
    }));
  }

  /**
   * Cached rate options for an order. Read-only; the picker calls this
   * on render, and calls fetchRates only when the vendor clicks
   * "refresh rates".
   */
  async listRateOptions(orderId: string): Promise<RateOption[]> {
    // Cast through unknown — the Prisma client hasn't been regenerated
    // for the new table in the sandbox. In CI (post `prisma generate`)
    // the property exists on the delegate.
    const prismaAny = this.prisma as unknown as {
      orderShippingRateOption: {
        findMany: (args: {
          where: { orderId: string };
          orderBy: { costCents: "asc" | "desc" };
        }) => Promise<
          Array<{
            rateProviderRef: string;
            shipmentProviderRef: string;
            carrier: string;
            service: string;
            costCents: number;
            estimatedDeliveryDays: number;
            fetchedAt: Date;
          }>
        >;
      };
    };
    const rows = await prismaAny.orderShippingRateOption.findMany({
      where: { orderId },
      orderBy: { costCents: "asc" },
    });
    return rows.map((r) => ({
      rateProviderRef: r.rateProviderRef,
      shipmentProviderRef: r.shipmentProviderRef,
      carrier: r.carrier,
      service: r.service,
      costCents: r.costCents,
      estimatedDeliveryDays: r.estimatedDeliveryDays,
      fetchedAt: r.fetchedAt.toISOString(),
    }));
  }

  // =========================================================================
  // WRITE — recordPack
  // =========================================================================

  async recordPack(
    orderId: string,
    actorId: string,
    input: RecordPackInput,
  ): Promise<PackResult> {
    this.assertPositiveDims(input);

    // Migration 0043 — if a preset was selected, its dims override the
    // operator-typed values and its tare weight is added to the goods
    // weight to arrive at the parcel weight. Resolve BEFORE the
    // transaction — the packaging library is read-only from this path
    // and can be looked up outside the lock.
    let effectiveLength = input.lengthIn;
    let effectiveWidth = input.widthIn;
    let effectiveHeight = input.heightIn;
    let effectiveWeightOz = input.weightOz;
    let packagingOptionId: string | null = null;
    // Phase N — Shippo carrier template. Resolved from one of three
    // sources, in priority order:
    //   1. Explicit `input.shippoTemplate` (Option A — Carrier tab).
    //   2. Library preset's own `shippoTemplate` column (a library
    //      preset that maps to a Shippo template, e.g. seeded USPS
    //      flat-rate presets).
    //   3. NULL — plain weight-based rates at fetchRates.
    // Validated against the static registry so a client can't sneak
    // in a bogus string that later 500s the Shippo call.
    let parcelTemplate: string | null = null;
    if (input.shippoTemplate) {
      if (!this.carrierRegistry.isKnown(input.shippoTemplate)) {
        throw new BadRequestException({
          message: `Unknown Shippo carrier template: ${input.shippoTemplate}.`,
          code: "carrier_template_unknown",
        });
      }
      parcelTemplate = input.shippoTemplate;
      // Auto-populate dims from the carrier registry when only a
      // template was passed (Option A UX: operator enters weight only).
      // Client-supplied dims are still permitted (and used as the
      // wire values) but the template is the authoritative pricing
      // signal downstream.
      const entry = this.carrierRegistry.getByTemplate(input.shippoTemplate);
      if (entry) {
        effectiveLength = entry.lengthIn;
        effectiveWidth = entry.widthIn;
        effectiveHeight = entry.heightIn;
        effectiveWeightOz = input.weightOz + entry.tareWeightOz;
      }
    }
    if (input.packagingOptionId) {
      const preset = await this.packagingLibrary.getById(input.packagingOptionId);
      if (!preset) {
        throw new BadRequestException({
          message: "Selected packaging option no longer exists.",
          code: "packaging_option_not_found",
        });
      }
      if (!preset.isActive) {
        throw new BadRequestException({
          message: "Selected packaging option is inactive. Pick a different one or enter dimensions manually.",
          code: "packaging_option_inactive",
        });
      }
      effectiveLength = preset.lengthIn;
      effectiveWidth = preset.widthIn;
      effectiveHeight = preset.heightIn;
      effectiveWeightOz = input.weightOz + preset.tareWeightOz;
      packagingOptionId = preset.id;
      // Library preset carries its own shippoTemplate (e.g. the
      // seeded USPS presets in migration 0049). Only apply it if the
      // caller didn't already supply an explicit template — direct
      // Option-A selection wins over the library's implicit choice.
      const presetTemplate = (preset as unknown as { shippoTemplate?: string | null })
        .shippoTemplate;
      if (parcelTemplate === null && presetTemplate) {
        parcelTemplate = presetTemplate;
      }
    }

    // Pre-flight for the NotFoundException path — mirrors
    // OrderService.cancel. Authoritative check happens inside the
    // transaction after FOR UPDATE.
    const exists = await this.prisma.order.findFirst({
      where: { id: orderId },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException();

    let result: PackResult;
    try {
      result = await this.prisma.$transaction(async (tx) => {
      const lockedRows = await tx.$queryRaw<
        Array<{
          id: string;
          status: OrderStatus;
          workflow_version: number;
          packed_at: Date | null;
          fulfillment_mode: string | null;
        }>
      >(Prisma.sql`
        SELECT id, status, workflow_version, packed_at, fulfillment_mode
        FROM orders
        WHERE id = ${orderId}::uuid
        FOR UPDATE
      `);
      const locked = lockedRows[0];
      if (!locked) throw new NotFoundException();

      if (locked.workflow_version !== 2) {
        throw new ConflictException({
          message: "This order was submitted under the legacy fulfillment flow and does not use the pack step.",
          code: "order_wrong_workflow",
        });
      }
      if (locked.status !== ("PENDING_PACKING" as OrderStatus)) {
        throw new ConflictException({
          message: `Order in status ${locked.status} cannot be packed. Expected PENDING_PACKING.`,
          code: "order_not_pending_packing",
        });
      }
      // NOTE: we do NOT block on `packed_at !== null` here. An order that
      // was "sent back to pack queue" (sendToPackQueue) is legitimately
      // back in PENDING_PACKING but still carries its previous pack
      // columns — so the operator can see/adjust the old dimensions and
      // RE-PACK. recordPack overwrites the pack columns below. The
      // PENDING_PACKING status check above is the real single-pack guard:
      // once this runs, status advances to PACKING_COMPLETED, so a second
      // concurrent call is rejected by that check (all inside FOR UPDATE).

      const now = new Date();
      const notes = input.notes?.trim();
      const notesValue = notes && notes.length > 0 ? notes : null;

      // VENDOR_CARRIER ("use my own carrier") — the vendor brought their
      // own label; there is NO platform label to buy. Instead of
      // sending the order into the rate picker (PACKING_COMPLETED), we
      // record the pack dimensions AND complete the order in one step:
      // status jumps straight to HANDED_OFF, mirroring the legacy
      // AdminOrderService.markHandedOff bookkeeping (decrement reserved,
      // mark lines shipped, write SHIP movements, stamp handed_off_at).
      // The PENDING_PACKING → HANDED_OFF edge is a forward transition
      // (ranks 1.5 → 7.5) so the state-machine trigger allows it.
      if (locked.fulfillment_mode === "VENDOR_CARRIER") {
        await tx.$executeRaw(Prisma.sql`
          UPDATE orders
             SET status = 'HANDED_OFF'::"OrderStatus",
                 packed_length_in = ${effectiveLength},
                 packed_width_in  = ${effectiveWidth},
                 packed_height_in = ${effectiveHeight},
                 packed_weight_oz = ${effectiveWeightOz},
                 packed_at        = ${now},
                 packed_by_user_id = ${actorId}::uuid,
                 packing_notes    = ${notesValue},
                 packaging_option_id = ${packagingOptionId ? Prisma.sql`${packagingOptionId}::uuid` : Prisma.sql`NULL`},
                 parcel_template  = ${parcelTemplate ?? null},
                 handed_off_at    = ${now},
                 updated_at       = NOW()
           WHERE id = ${orderId}::uuid
        `);

        // Inventory bookkeeping: the parcel has physically left the
        // warehouse on the vendor's carrier. Decrement reserved and
        // mark each line shipped, one SHIP movement per line — exactly
        // as markHandedOff does. The wallet was already debited (the
        // fulfillment fee) at submit; nothing further to charge.
        const orderLines = await tx.orderLine.findMany({
          where: { orderId },
        });
        for (const line of orderLines) {
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
              referenceId: orderId,
              actorId,
            },
          });
          await tx.orderLine.update({
            where: { id: line.id },
            data: { allocationStatus: "SHIPPED" },
          });
        }

        await tx.orderEvent.create({
          data: {
            orderId,
            type: "order.handed_off",
            description: "Packed and handed to vendor's own carrier.",
            source: "ADMIN",
            actorId,
          },
        });

        return {
          orderId,
          status: "HANDED_OFF" as OrderStatus,
          packedLengthIn: effectiveLength,
          packedWidthIn: effectiveWidth,
          packedHeightIn: effectiveHeight,
          packedWeightOz: effectiveWeightOz,
          packedAt: now.toISOString(),
          packedByUserId: actorId,
          packingNotes: notesValue,
          packagingOptionId,
          parcelTemplate,
        };
      }

      // packagingOptionId / parcelTemplate are passed as either a
      // bound value (with a type cast when needed) or literal NULL.
      // The ternary keeps Prisma's parameter binding clean and avoids
      // needing conditional SQL variants of the whole UPDATE.
      await tx.$executeRaw(Prisma.sql`
        UPDATE orders
           SET status = 'PACKING_COMPLETED'::"OrderStatus",
               packed_length_in = ${effectiveLength},
               packed_width_in  = ${effectiveWidth},
               packed_height_in = ${effectiveHeight},
               packed_weight_oz = ${effectiveWeightOz},
               packed_at        = ${now},
               packed_by_user_id = ${actorId}::uuid,
               packing_notes    = ${notesValue},
               packaging_option_id = ${packagingOptionId ? Prisma.sql`${packagingOptionId}::uuid` : Prisma.sql`NULL`},
               parcel_template  = ${parcelTemplate ?? null},
               updated_at       = NOW()
         WHERE id = ${orderId}::uuid
      `);

      return {
        orderId,
        status: "PACKING_COMPLETED" as OrderStatus,
        packedLengthIn: effectiveLength,
        packedWidthIn: effectiveWidth,
        packedHeightIn: effectiveHeight,
        packedWeightOz: effectiveWeightOz,
        packedAt: now.toISOString(),
        packedByUserId: actorId,
        packingNotes: notesValue,
        packagingOptionId,
        parcelTemplate,
      };
    });
    } catch (err) {
      // Business-level errors thrown inside the transaction are already
      // Nest HttpException subclasses — pass those through so the client
      // sees the intended 4xx code. Only wrap what's left, which is
      // usually a Prisma raw-SQL failure (P2010) or an unknown Prisma
      // error (missing column, missing enum literal — both symptoms of
      // migrations being behind in the current environment).
      if (
        err instanceof BadRequestException ||
        err instanceof ConflictException ||
        err instanceof NotFoundException
      ) {
        throw err;
      }
      // Extract as much detail as we can without leaking internals.
      // Prisma known-request errors carry a `code` string (e.g. "P2010")
      // and a `meta` object with the Postgres error code + message.
      // Log the FULL error server-side so ops can correlate, but keep
      // the client-facing response tight.
      const prismaCode =
        typeof err === "object" && err !== null && "code" in err
          ? String((err as { code?: unknown }).code ?? "")
          : "";
      const pgCode =
        typeof err === "object" &&
        err !== null &&
        "meta" in err &&
        typeof (err as { meta?: { code?: unknown } }).meta === "object"
          ? String((err as { meta?: { code?: unknown } }).meta?.code ?? "")
          : "";
      this.logger.error(
        {
          msg: "recordPack: raw SQL failure",
          orderId,
          prismaCode,
          pgCode,
          err: err instanceof Error ? err.message : String(err),
        },
        err instanceof Error ? err.stack : undefined,
      );
      // Extract any constraint / trigger identifier from the Prisma
      // meta.message. Postgres surfaces the failing constraint or
      // trigger-raised text like:
      //   `new row for relation "orders" violates check constraint "orders_packed_dims_positive"`
      // or, for our state-machine trigger:
      //   `order_status_unknown: PENDING_PACKING -> PACKING_COMPLETED`
      // Both patterns are useful diagnostics — surface them inline so
      // ops can read them from the response body without pulling logs.
      const pgMessage =
        typeof err === "object" &&
        err !== null &&
        "meta" in err &&
        typeof (err as { meta?: { message?: unknown } }).meta === "object"
          ? String((err as { meta?: { message?: unknown } }).meta?.message ?? "")
          : "";
      const constraintMatch = pgMessage.match(/constraint "([^"]+)"/);
      const triggerMatch = pgMessage.match(/order_status_[a-z_]+/);
      const detail = constraintMatch?.[1] ?? triggerMatch?.[0] ?? "";

      // Embed the codes in the `message` string itself so they survive
      // the ProblemJSON global filter (which only echoes a fixed field
      // set). Ops can grep for "pack_write_failed" AND immediately see
      // whether it's a P2010 raw-SQL failure, a P2022 missing column, a
      // Postgres 42703 (undefined column), 42P01 (undefined table),
      // 22P02 (invalid enum literal or check violation), etc. — without
      // pulling logs. When available, the constraint / trigger name is
      // appended so the exact rule that fired is visible in the browser.
      const suffix = [
        prismaCode ? `prisma=${prismaCode}` : null,
        pgCode ? `pg=${pgCode}` : null,
        detail ? `at=${detail}` : null,
      ]
        .filter(Boolean)
        .join(" ");
      const message = suffix
        ? `Could not record pack — a database write failed [${suffix}]. This usually means database migrations have not been applied in this environment.`
        : "Could not record pack — a database write failed. This usually means database migrations have not been applied in this environment.";
      throw new InternalServerErrorException({
        message,
        code: "pack_write_failed",
      });
    }

    const handedOff = result.status === ("HANDED_OFF" as OrderStatus);

    await this.audit.log({
      actorId,
      action: handedOff ? "order.packed_and_handed_off" : "order.packed",
      resourceType: "order",
      resourceId: orderId,
      beforeState: { status: "PENDING_PACKING" } as unknown as Prisma.InputJsonValue,
      afterState: {
        status: result.status,
        packedLengthIn: result.packedLengthIn,
        packedWidthIn: result.packedWidthIn,
        packedHeightIn: result.packedHeightIn,
        packedWeightOz: result.packedWeightOz,
        packagingOptionId: result.packagingOptionId,
        parcelTemplate: result.parcelTemplate,
      } as unknown as Prisma.InputJsonValue,
    });

    // VENDOR_CARRIER orders are complete at pack time — notify the vendor
    // their order was handed to their carrier (parity with the legacy
    // markHandedOff notification). Best-effort; a failure here must not
    // undo the committed hand-off.
    if (handedOff) {
      try {
        const order = await this.prisma.order.findUnique({
          where: { id: orderId },
          select: {
            vendorId: true,
            orderNumber: true,
            carrier: true,
            trackingNumber: true,
          },
        });
        if (order) {
          const vc = order as unknown as {
            vendorCarrierName?: string | null;
            vendorTrackingNumber?: string | null;
          };
          const carrierName =
            vc.vendorCarrierName ?? order.carrier ?? "your carrier";
          const tracking =
            vc.vendorTrackingNumber ?? order.trackingNumber ?? null;
          const ref = formatOrderRef(order.orderNumber);
          await this.notifications.emit({
            vendorId: order.vendorId,
            type: "order.shipped",
            severity: "INFO",
            title: `Order ${ref} handed off`,
            body: tracking
              ? `Packed and handed to ${carrierName}. Tracking: ${tracking}.`
              : `Packed and handed to ${carrierName}.`,
            href: `/orders/${orderId}`,
          });
        }
      } catch (err) {
        this.logger.error(
          {
            msg: "recordPack: vendor-carrier hand-off notification failed",
            orderId,
            err: err instanceof Error ? err.message : String(err),
          },
          err instanceof Error ? err.stack : undefined,
        );
      }
    }

    return result;
  }

  // =========================================================================
  // WRITE — updatePackDetails (Phase P-D)
  //
  // Post-pack edit path: warehouse operator noticed a dim was mis-
  // measured or the wrong packaging was picked, wants to correct
  // without cancelling and re-packing from zero. Allowed only BEFORE
  // the label is bought — once we've handed the vendor's money to
  // Shippo, the pack details are frozen.
  //
  // Same input shape and same resolution logic as recordPack (carrier
  // template + library preset override client dims; tare added
  // server-side). Difference:
  //   * Guards on status ∈ {PACKING_COMPLETED,
  //     AWAITING_SHIPPING_SELECTION, AWAITING_WALLET_FUNDING} —
  //     everything BEFORE LABEL_PURCHASED.
  //   * Does NOT touch status. The state-machine trigger from
  //     migration 0048 rejects backwards transitions (e.g.
  //     AWAITING_SHIPPING_SELECTION → PACKING_COMPLETED) as
  //     check_violation, so we can't revert. Instead:
  //   * DROPS cached rate options in order_shipping_rate_options.
  //     The picker sees an empty rate list and prompts the operator
  //     to re-fetch — functionally equivalent to a status revert
  //     without tripping the trigger.
  // =========================================================================

  async updatePackDetails(
    orderId: string,
    actorId: string,
    input: RecordPackInput,
  ): Promise<PackResult> {
    this.assertPositiveDims(input);

    // Resolve carrier template + library preset the same way recordPack
    // does. Duplication is intentional — extracting a shared helper
    // would couple two subtly different SRP concerns (create vs edit).
    let effectiveLength = input.lengthIn;
    let effectiveWidth = input.widthIn;
    let effectiveHeight = input.heightIn;
    let effectiveWeightOz = input.weightOz;
    let packagingOptionId: string | null = null;
    let parcelTemplate: string | null = null;
    if (input.shippoTemplate) {
      if (!this.carrierRegistry.isKnown(input.shippoTemplate)) {
        throw new BadRequestException({
          message: `Unknown Shippo carrier template: ${input.shippoTemplate}.`,
          code: "carrier_template_unknown",
        });
      }
      parcelTemplate = input.shippoTemplate;
      const entry = this.carrierRegistry.getByTemplate(input.shippoTemplate);
      if (entry) {
        effectiveLength = entry.lengthIn;
        effectiveWidth = entry.widthIn;
        effectiveHeight = entry.heightIn;
        effectiveWeightOz = input.weightOz + entry.tareWeightOz;
      }
    }
    if (input.packagingOptionId) {
      const preset = await this.packagingLibrary.getById(input.packagingOptionId);
      if (!preset) {
        throw new BadRequestException({
          message: "Selected packaging option no longer exists.",
          code: "packaging_option_not_found",
        });
      }
      if (!preset.isActive) {
        throw new BadRequestException({
          message: "Selected packaging option is inactive.",
          code: "packaging_option_inactive",
        });
      }
      effectiveLength = preset.lengthIn;
      effectiveWidth = preset.widthIn;
      effectiveHeight = preset.heightIn;
      effectiveWeightOz = input.weightOz + preset.tareWeightOz;
      packagingOptionId = preset.id;
      const presetTemplate = (preset as unknown as {
        shippoTemplate?: string | null;
      }).shippoTemplate;
      if (parcelTemplate === null && presetTemplate) {
        parcelTemplate = presetTemplate;
      }
    }

    const exists = await this.prisma.order.findFirst({
      where: { id: orderId },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException();

    const now = new Date();
    const notes = input.notes?.trim();
    const notesValue = notes && notes.length > 0 ? notes : null;

    let result: PackResult;
    try {
      result = await this.prisma.$transaction(async (tx) => {
        const lockedRows = await tx.$queryRaw<
          Array<{
            id: string;
            status: OrderStatus;
            workflow_version: number;
          }>
        >(Prisma.sql`
          SELECT id, status, workflow_version
          FROM orders
          WHERE id = ${orderId}::uuid
          FOR UPDATE
        `);
        const locked = lockedRows[0];
        if (!locked) throw new NotFoundException();

        if (locked.workflow_version !== 2) {
          throw new ConflictException({
            message:
              "Legacy orders don't use the v2 pack-details edit path.",
            code: "order_wrong_workflow",
          });
        }

        // Guard: no edits after the label has been bought — the
        // vendor's money went to the carrier and the box is on its
        // way. Anything past LABEL_PURCHASED (PICKING, PACKED,
        // SHIPPED, etc.) is off-limits.
        const editable: OrderStatus[] = [
          "PACKING_COMPLETED" as OrderStatus,
          "AWAITING_SHIPPING_SELECTION" as OrderStatus,
          "AWAITING_WALLET_FUNDING" as OrderStatus,
        ];
        if (!editable.includes(locked.status)) {
          throw new ConflictException({
            message: `Pack details cannot be edited after status ${locked.status}. The label has already been purchased.`,
            code: "pack_details_locked",
          });
        }

        // Drop cached rate options — dims changed, rates are stale.
        // The picker will see an empty rate list and prompt for a
        // re-fetch, which is functionally equivalent to a status
        // revert without tripping the state-machine trigger from
        // migration 0048 (which rejects backwards transitions like
        // AWAITING_SHIPPING_SELECTION → PACKING_COMPLETED as
        // ERRCODE=check_violation / pg=23514).
        await tx.$executeRaw(Prisma.sql`
          DELETE FROM order_shipping_rate_options
          WHERE order_id = ${orderId}::uuid
        `);

        // Update pack columns in place; leave `status` alone. The
        // combination "empty rate cache + updated pack columns" is
        // what signals the operator to re-fetch rates before picking
        // one. No status write means no trigger interaction.
        await tx.$executeRaw(Prisma.sql`
          UPDATE orders
             SET packed_length_in = ${effectiveLength},
                 packed_width_in  = ${effectiveWidth},
                 packed_height_in = ${effectiveHeight},
                 packed_weight_oz = ${effectiveWeightOz},
                 packed_at        = ${now},
                 packed_by_user_id = ${actorId}::uuid,
                 packing_notes    = ${notesValue},
                 packaging_option_id = ${packagingOptionId ? Prisma.sql`${packagingOptionId}::uuid` : Prisma.sql`NULL`},
                 parcel_template  = ${parcelTemplate ?? null},
                 updated_at       = NOW()
           WHERE id = ${orderId}::uuid
        `);

        return {
          orderId,
          // Status was NOT changed. Echo back whatever the row was
          // sitting in so the caller doesn't need to re-read the row.
          status: locked.status,
          packedLengthIn: effectiveLength,
          packedWidthIn: effectiveWidth,
          packedHeightIn: effectiveHeight,
          packedWeightOz: effectiveWeightOz,
          packedAt: now.toISOString(),
          packedByUserId: actorId,
          packingNotes: notesValue,
          packagingOptionId,
          parcelTemplate,
        };
      });
    } catch (err) {
      if (
        err instanceof BadRequestException ||
        err instanceof ConflictException ||
        err instanceof NotFoundException
      ) {
        throw err;
      }
      // Same defensive wrapping as recordPack. If a raw-SQL failure or
      // unknown Prisma error slips out, translate it before it hits
      // the client.
      const prismaCode =
        typeof err === "object" && err !== null && "code" in err
          ? String((err as { code?: unknown }).code ?? "")
          : "";
      this.logger.error(
        {
          msg: "updatePackDetails: raw SQL failure",
          orderId,
          prismaCode,
          err: err instanceof Error ? err.message : String(err),
        },
        err instanceof Error ? err.stack : undefined,
      );
      throw new BadRequestException({
        message: `Could not update pack details${prismaCode ? ` [prisma=${prismaCode}]` : ""}.`,
        code: "pack_update_failed",
      });
    }

    await this.audit.log({
      actorId,
      action: "order.pack_details_updated",
      resourceType: "order",
      resourceId: orderId,
      afterState: {
        packedLengthIn: result.packedLengthIn,
        packedWidthIn: result.packedWidthIn,
        packedHeightIn: result.packedHeightIn,
        packedWeightOz: result.packedWeightOz,
        packagingOptionId: result.packagingOptionId,
        parcelTemplate: result.parcelTemplate,
      } as unknown as Prisma.InputJsonValue,
    });

    return result;
  }

  // =========================================================================
  // WRITE — sendToPackQueue (regress to PENDING_PACKING)
  // =========================================================================
  //
  // Sends a packed-but-not-yet-shipped order back to the full pack flow
  // (/admin/pack) so the operator can re-pack with the complete toolset
  // — packaging presets, carrier templates, barcode scan — rather than
  // the restrictive dims/weight-only inline editor the rate picker used
  // to offer.
  //
  // This is a BACKWARDS status transition, legalised by the whitelist in
  // migration 0051:
  //
  //   PACKING_COMPLETED            → PENDING_PACKING
  //   AWAITING_SHIPPING_SELECTION  → PENDING_PACKING
  //   AWAITING_WALLET_FUNDING      → PENDING_PACKING
  //
  // Guards (mirroring updatePackDetails):
  //   * workflow_version = 2 (legacy orders never enter this service).
  //   * status ∈ the three editable pre-label statuses. Anything at or
  //     past SHIPPING_PAID is refused — the wallet is already committed
  //     to the carrier by then, so the pack details are frozen.
  //   * Cached rate options are dropped: they were priced against the
  //     old dimensions and are meaningless once the order re-enters the
  //     pack loop. recordPack() will move it forward to
  //     PACKING_COMPLETED again with fresh dims, and the operator
  //     re-fetches rates from there.
  // =========================================================================

  async sendToPackQueue(
    orderId: string,
    actorId: string,
  ): Promise<{ orderId: string; status: OrderStatus }> {
    const exists = await this.prisma.order.findFirst({
      where: { id: orderId },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException();

    let fromStatus: OrderStatus;
    try {
      fromStatus = await this.prisma.$transaction(async (tx) => {
        const lockedRows = await tx.$queryRaw<
          Array<{ id: string; status: OrderStatus; workflow_version: number }>
        >(Prisma.sql`
          SELECT id, status, workflow_version
          FROM orders
          WHERE id = ${orderId}::uuid
          FOR UPDATE
        `);
        const locked = lockedRows[0];
        if (!locked) throw new NotFoundException();

        if (locked.workflow_version !== 2) {
          throw new ConflictException({
            message: "Legacy orders don't use the v2 pack flow.",
            code: "order_wrong_workflow",
          });
        }

        // Idempotency: already sitting in the pack queue — nothing to do.
        if (locked.status === ("PENDING_PACKING" as OrderStatus)) {
          return locked.status;
        }

        const regressible: OrderStatus[] = [
          "PACKING_COMPLETED" as OrderStatus,
          "AWAITING_SHIPPING_SELECTION" as OrderStatus,
          "AWAITING_WALLET_FUNDING" as OrderStatus,
        ];
        if (!regressible.includes(locked.status)) {
          throw new ConflictException({
            message: `Order in status ${locked.status} cannot be sent back to the pack queue. The label has already been purchased.`,
            code: "pack_queue_regress_locked",
          });
        }

        // Drop cached rate options — they were priced against the old
        // dims and no longer apply once the order re-enters the pack
        // loop.
        await tx.$executeRaw(Prisma.sql`
          DELETE FROM order_shipping_rate_options
          WHERE order_id = ${orderId}::uuid
        `);

        // Regress to PENDING_PACKING. The migration-0051 whitelist lets
        // this specific backwards edge through the state-machine trigger.
        await tx.$executeRaw(Prisma.sql`
          UPDATE orders
             SET status = 'PENDING_PACKING'::"OrderStatus",
                 updated_at = NOW()
           WHERE id = ${orderId}::uuid
        `);

        return locked.status;
      });
    } catch (err) {
      if (
        err instanceof ConflictException ||
        err instanceof NotFoundException
      ) {
        throw err;
      }
      const prismaCode =
        typeof err === "object" && err !== null && "code" in err
          ? String((err as { code?: unknown }).code ?? "")
          : "";
      this.logger.error(
        {
          msg: "sendToPackQueue: raw SQL failure",
          orderId,
          prismaCode,
          err: err instanceof Error ? err.message : String(err),
        },
        err instanceof Error ? err.stack : undefined,
      );
      throw new BadRequestException({
        message: `Could not send order back to the pack queue${prismaCode ? ` [prisma=${prismaCode}]` : ""}.`,
        code: "pack_queue_regress_failed",
      });
    }

    await this.audit.log({
      actorId,
      action: "order.sent_to_pack_queue",
      resourceType: "order",
      resourceId: orderId,
      beforeState: { status: fromStatus } as unknown as Prisma.InputJsonValue,
      afterState: {
        status: "PENDING_PACKING",
      } as unknown as Prisma.InputJsonValue,
    });

    return { orderId, status: "PENDING_PACKING" as OrderStatus };
  }

  // =========================================================================
  // WRITE — fetchRates
  // =========================================================================

  async fetchRates(orderId: string, actorId: string): Promise<FetchRatesResult> {
    // Read the order (unlocked — the Shippo call is a network I/O we
    // don't want to hold a row lock across). We only take the row lock
    // for the *write* at the end. Between the two, the worst-case race
    // is a duplicate rate fetch — cheap and idempotent.
    const order = await this.prisma.order.findFirst({
      where: { id: orderId },
    });
    if (!order) throw new NotFoundException();

    if (
      (order as unknown as { workflowVersion: number }).workflowVersion !== 2
    ) {
      throw new ConflictException({
        message: "Legacy orders do not use pack-time rate fetching.",
        code: "order_wrong_workflow",
      });
    }

    // Defensive: VENDOR_CARRIER orders never buy a platform label, so
    // there are no rates to fetch. recordPack already completes them at
    // HANDED_OFF; this guard blocks a direct API call from routing one
    // into the label-purchase path.
    if (
      (order as unknown as { fulfillmentMode?: string | null }).fulfillmentMode ===
      "VENDOR_CARRIER"
    ) {
      throw new ConflictException({
        message:
          "This order uses the vendor's own carrier — there is no platform label to rate or buy.",
        code: "order_vendor_carrier_no_label",
      });
    }

    const allowed: OrderStatus[] = [
      "PACKING_COMPLETED" as OrderStatus,
      "AWAITING_SHIPPING_SELECTION" as OrderStatus,
      "AWAITING_WALLET_FUNDING" as OrderStatus,
    ];
    if (!allowed.includes(order.status)) {
      throw new ConflictException({
        message: `Order in status ${order.status} cannot fetch rates. Expected one of ${allowed.join(", ")}.`,
        code: "order_not_ready_for_rates",
      });
    }

    // Pack columns must exist — otherwise Shippo has nothing to price
    // against. The all-or-none DB check keeps these in sync, so if
    // packedAt is set the rest are too.
    const raw = order as unknown as {
      packedLengthIn: Prisma.Decimal | number | null;
      packedWidthIn: Prisma.Decimal | number | null;
      packedHeightIn: Prisma.Decimal | number | null;
      packedWeightOz: number | null;
      // Migration 0049 / Phase N — Shippo carrier template captured
      // at pack time. When set, it unlocks flat-rate / one-rate /
      // simple-rate pricing on this fetch.
      parcelTemplate: string | null;
    };
    if (
      raw.packedLengthIn === null ||
      raw.packedWidthIn === null ||
      raw.packedHeightIn === null ||
      raw.packedWeightOz === null
    ) {
      throw new ConflictException({
        message: "Order is not packed yet — no dimensions to price against.",
        code: "order_not_packed",
      });
    }

    // Vendor-selected add-ons (migration 0055). Read via raw SQL so this
    // works even when the local Prisma client hasn't been regenerated with
    // the new columns (Railway regenerates on deploy; local can lag).
    const addonRows = await this.prisma.$queryRaw<
      Array<{
        insurance_requested: boolean;
        signature_required: boolean;
        adult_signature_required: boolean;
      }>
    >(Prisma.sql`
      SELECT insurance_requested, signature_required, adult_signature_required
      FROM orders WHERE id = ${orderId}::uuid
    `);
    const addons = addonRows[0] ?? {
      insurance_requested: false,
      signature_required: false,
      adult_signature_required: false,
    };
    // Adult signature supersedes standard signature when both are set.
    const signatureConfirmation: "STANDARD" | "ADULT" | undefined = addons.adult_signature_required
      ? "ADULT"
      : addons.signature_required
        ? "STANDARD"
        : undefined;
    // International (non-US) shipments need a customs declaration built
    // from the order lines.
    const isInternational = (order.shipCountry ?? "US").toUpperCase() !== "US";
    const customs = isInternational ? await this.buildOrderCustoms(orderId) : undefined;

    const rateResponse = await this.shippo.getRates({
      fromAddress: this.warehouseOrigin,
      toAddress: {
        recipientName: order.recipientName,
        line1: order.shipAddressLine1,
        line2: order.shipAddressLine2 ?? undefined,
        city: order.shipCity,
        state: order.shipState,
        postalCode: order.shipPostalCode,
        country: order.shipCountry,
      },
      parcel: {
        lengthIn: this.decimalToNumber(raw.packedLengthIn),
        widthIn: this.decimalToNumber(raw.packedWidthIn),
        heightIn: this.decimalToNumber(raw.packedHeightIn),
        weightOz: raw.packedWeightOz,
        template: raw.parcelTemplate ?? undefined,
      },
      declaredValueCents: order.itemsDeclaredValueCents,
      insuranceRequested: addons.insurance_requested,
      signatureConfirmation,
      customs,
    });

    if (rateResponse.rates.length === 0) {
      throw new ConflictException({
        message: "No carrier rates were returned for the packed dimensions. Verify the box measurements and try again.",
        code: "order_no_rates_available",
      });
    }

    // Replace-and-insert inside a transaction so the picker always sees
    // a coherent list — never partially-written rows.
    const prismaAny = this.prisma as unknown as {
      $transaction: (
        cb: (tx: {
          $executeRaw: (q: Prisma.Sql) => Promise<number>;
          orderShippingRateOption: {
            createMany: (args: {
              data: Array<{
                orderId: string;
                rateProviderRef: string;
                shipmentProviderRef: string;
                carrier: string;
                service: string;
                costCents: number;
                estimatedDeliveryDays: number;
              }>;
            }) => Promise<{ count: number }>;
          };
        }) => Promise<void>,
      ) => Promise<void>;
    };

    await prismaAny.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`
        DELETE FROM order_shipping_rate_options WHERE order_id = ${orderId}::uuid
      `);
      // Deduplicate by rateProviderRef defensively — the DB unique
      // constraint would reject dupes, and Shippo shouldn't return
      // them, but a hardened service refuses to trust upstream.
      const seen = new Set<string>();
      const rows = rateResponse.rates
        .filter((r: ShippingRate) => {
          if (seen.has(r.rateId)) return false;
          seen.add(r.rateId);
          return true;
        })
        .map((r: ShippingRate) => ({
          orderId,
          rateProviderRef: r.rateId,
          shipmentProviderRef: r.shipmentId,
          carrier: r.carrier,
          service: r.service,
          costCents: r.costCents,
          estimatedDeliveryDays: r.estimatedDeliveryDays,
        }));
      if (rows.length > 0) {
        await tx.orderShippingRateOption.createMany({ data: rows });
      }
      await tx.$executeRaw(Prisma.sql`
        UPDATE orders
           SET status = 'AWAITING_SHIPPING_SELECTION'::"OrderStatus",
               updated_at = NOW()
         WHERE id = ${orderId}::uuid
      `);
    });

    await this.audit.log({
      actorId,
      action: "order.rates_fetched",
      resourceType: "order",
      resourceId: orderId,
      beforeState: { status: order.status } as unknown as Prisma.InputJsonValue,
      afterState: {
        status: "AWAITING_SHIPPING_SELECTION",
        rateCount: rateResponse.rates.length,
      } as unknown as Prisma.InputJsonValue,
    });

    return {
      orderId,
      status: "AWAITING_SHIPPING_SELECTION" as OrderStatus,
      options: (await this.listRateOptions(orderId)),
    };
  }

  // =========================================================================
  // WRITE — selectRate
  // =========================================================================

  async selectRate(
    orderId: string,
    actorId: string,
    rateProviderRef: string,
  ): Promise<SelectRateOutcome> {
    if (typeof rateProviderRef !== "string" || rateProviderRef.length === 0) {
      throw new BadRequestException({
        message: "rateProviderRef is required.",
        code: "invalid_input",
      });
    }

    const exists = await this.prisma.order.findFirst({
      where: { id: orderId },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException();

    // Whole path in a single transaction so the wallet debit and the
    // status update commit together. WalletService.debit accepts our
    // tx so its locks compose cleanly.
    // Phase P-C — two-phase commit shape:
    //   Phase 1 (transaction) → wallet debit + status = SHIPPING_PAID,
    //     OR downgrade to AWAITING_WALLET_FUNDING if wallet was short.
    //   Phase 2 (outside tx, only if Phase 1 committed SHIPPING_PAID) →
    //     Shippo label purchase; on success, promote to LABEL_PURCHASED
    //     and store tracking + label URL; on failure, compensate by
    //     refunding the wallet and reverting status so the operator
    //     can pick a different rate.
    // Shippo call cannot live inside the transaction — holding a DB
    // connection across a network round-trip is a well-known anti-
    // pattern that starves the pool under load.
    //
    // Defensive wrap: any raw-SQL / unknown Prisma error inside the tx
    // (missing column, schema drift, trigger raise) previously escaped
    // as a bare 500. Wrap in the same error-mapper pattern as
    // recordPack (Phase K1) so ops sees prismaCode / pgCode / trigger
    // name inline in the response body — no correlationId round-trip
    // needed to diagnose environment mismatches.
    let inner: DebitInnerResult;
    try {
      inner = await this.prisma.$transaction(async (tx) => {
      const lockedRows = await tx.$queryRaw<
        Array<{
          id: string;
          status: OrderStatus;
          workflow_version: number;
          vendor_id: string;
          fulfillment_mode: string | null;
        }>
      >(Prisma.sql`
        SELECT id, status, workflow_version, vendor_id, fulfillment_mode
        FROM orders
        WHERE id = ${orderId}::uuid
        FOR UPDATE
      `);
      const locked = lockedRows[0];
      if (!locked) throw new NotFoundException();

      if (locked.workflow_version !== 2) {
        throw new ConflictException({
          message: "Legacy orders do not use pack-time rate selection.",
          code: "order_wrong_workflow",
        });
      }

      // Defensive: VENDOR_CARRIER orders have no platform label to buy
      // and must never reach a wallet debit for shipping.
      if (locked.fulfillment_mode === "VENDOR_CARRIER") {
        throw new ConflictException({
          message:
            "This order uses the vendor's own carrier — there is no platform label to buy.",
          code: "order_vendor_carrier_no_label",
        });
      }

      const allowed: OrderStatus[] = [
        "AWAITING_SHIPPING_SELECTION" as OrderStatus,
        "AWAITING_WALLET_FUNDING" as OrderStatus,
      ];
      if (!allowed.includes(locked.status)) {
        throw new ConflictException({
          message: `Order in status ${locked.status} cannot select a rate. Expected AWAITING_SHIPPING_SELECTION or AWAITING_WALLET_FUNDING.`,
          code: "order_not_ready_for_selection",
        });
      }

      const chosenRows = await tx.$queryRaw<
        Array<{
          rate_provider_ref: string;
          shipment_provider_ref: string;
          carrier: string;
          service: string;
          cost_cents: number;
        }>
      >(Prisma.sql`
        SELECT rate_provider_ref, shipment_provider_ref, carrier, service, cost_cents
        FROM order_shipping_rate_options
        WHERE order_id = ${orderId}::uuid AND rate_provider_ref = ${rateProviderRef}
        LIMIT 1
      `);
      const chosen = chosenRows[0];
      if (!chosen) {
        throw new BadRequestException({
          message: "Chosen rate is no longer in the cache. Re-fetch rates and try again.",
          code: "rate_not_in_cache",
        });
      }

      const shippingCostCents = chosen.cost_cents;

      // Attempt the debit inside the same transaction. WalletService
      // throws ConflictException("insufficient_funds") if the balance
      // can't cover it — we catch that and downgrade the status to
      // AWAITING_WALLET_FUNDING instead of failing the whole call.
      try {
        const debit = await this.wallet.debit(
          {
            vendorId: locked.vendor_id,
            amountCents: shippingCostCents,
            type: "SHIPPING",
            description: `Shipping · ${chosen.carrier} ${chosen.service}`,
            referenceType: "order",
            referenceId: orderId,
            actorId,
          },
          tx as unknown as Parameters<typeof this.wallet.debit>[1],
        );

        // Advance to SHIPPING_PAID inside the SAME transaction as the
        // wallet debit. This intermediate status is committed even if
        // the label-purchase step (outside the transaction) fails —
        // the compensation path in the caller detects that and
        // refunds + reverts to AWAITING_SHIPPING_SELECTION for retry.
        // NOTE: `shipment_provider_ref` intentionally NOT written to the
        // orders row — that column exists only on
        // `order_shipping_rate_options` (migration 0042). Writing it
        // here previously produced Postgres 42703 (undefined_column)
        // which Prisma wraps as P2010 and Nest surfaces as a bare 500.
        // The value is carried in-memory via DebitInnerResult so Phase 2
        // (label purchase) can still reference it without a re-read.
        // If persistent audit becomes needed, add the column via a
        // future migration and re-introduce the write in the same PR.
        await tx.$executeRaw(Prisma.sql`
          UPDATE orders
             SET status = 'SHIPPING_PAID'::"OrderStatus",
                 shipping_cost_cents = ${shippingCostCents},
                 shipping_fee_cents  = ${shippingCostCents},
                 carrier             = ${chosen.carrier},
                 carrier_service     = ${chosen.service},
                 rate_provider_ref   = ${chosen.rate_provider_ref},
                 total_charged_cents = total_charged_cents + ${shippingCostCents},
                 updated_at = NOW()
           WHERE id = ${orderId}::uuid
        `);

        await this.audit.log({
          actorId,
          action: "order.shipping_paid",
          resourceType: "order",
          resourceId: orderId,
          beforeState: { status: locked.status } as unknown as Prisma.InputJsonValue,
          afterState: {
            status: "SHIPPING_PAID",
            shippingCostCents,
            carrier: chosen.carrier,
            service: chosen.service,
            rateProviderRef: chosen.rate_provider_ref,
          } as unknown as Prisma.InputJsonValue,
        });

        // Return the intermediate signal to the outer function, which
        // will now buy the label. We can't call Shippo inside a
        // transaction (holds a DB connection across a network I/O)
        // so the label purchase is a separate step composed with a
        // compensation path.
        return {
          committed: "SHIPPING_PAID" as const,
          vendorId: locked.vendor_id,
          balanceAfterCents: debit.balanceAfterCents,
          shippingCostCents,
          shipmentProviderRef: chosen.shipment_provider_ref,
          rateProviderRef: chosen.rate_provider_ref,
          carrier: chosen.carrier,
          service: chosen.service,
        };
      } catch (err: unknown) {
        // Only handle the insufficient-funds branch specially — any
        // other error (DB failure, network issue) must propagate.
        const isInsufficient =
          err instanceof ConflictException &&
          typeof (err.getResponse() as { code?: string }).code === "string" &&
          (err.getResponse() as { code?: string }).code === "insufficient_funds";
        if (!isInsufficient) throw err;

        // Read the wallet balance (unlocked — informational only) so
        // the response tells the admin exactly how short the vendor is.
        const walletSnap = await this.wallet.get(locked.vendor_id);

        await tx.$executeRaw(Prisma.sql`
          UPDATE orders
             SET status = 'AWAITING_WALLET_FUNDING'::"OrderStatus",
                 updated_at = NOW()
           WHERE id = ${orderId}::uuid
        `);

        await this.audit.log({
          actorId,
          action: "order.awaiting_wallet_funding",
          resourceType: "order",
          resourceId: orderId,
          beforeState: { status: locked.status } as unknown as Prisma.InputJsonValue,
          afterState: {
            status: "AWAITING_WALLET_FUNDING",
            shippingCostCents,
            walletBalanceCents: walletSnap.balanceCents,
            carrier: chosen.carrier,
            service: chosen.service,
          } as unknown as Prisma.InputJsonValue,
        });

        return {
          outcome: "AWAITING_WALLET_FUNDING" as const,
          walletBalanceCents: walletSnap.balanceCents,
          requiredCents: shippingCostCents,
          carrier: chosen.carrier,
          service: chosen.service,
          rateProviderRef: chosen.rate_provider_ref,
        };
      }
    });
    } catch (err) {
      this.throwWrappedRawSqlError(err, "selectRate.phase1", "select_rate_write_failed", orderId);
    }

    // ---- Phase 2 — wallet-short branch returns immediately -------------
    // Discriminate on the presence of the `outcome` key; TS narrows
    // `inner` to the SHIPPING_PAID variant below.
    if ("outcome" in inner) {
      return inner;
    }

    // ---- Phase 2a — SHIPPING_PAID: buy the label from Shippo -----------
    // Wallet was successfully debited and the DB row shows SHIPPING_PAID.
    // We now buy the label from Shippo, then persist LABEL_PURCHASED.
    //
    // TWO DISTINCT failure classes with OPPOSITE compensation semantics:
    //
    //   A. Shippo REFUSED the purchase (label was NOT bought). Compensate:
    //      credit the wallet back, revert status to
    //      AWAITING_SHIPPING_SELECTION so the operator can pick another
    //      rate. Any residual compensation failure is surfaced honestly
    //      in the error message rather than silently swallowed.
    //
    //   B. Shippo BOUGHT the label, but our DB write to record it
    //      failed. The vendor's money is already with the carrier and
    //      the label exists. Compensation would be WRONG here — refund
    //      + revert would create a "we bought a label we're not
    //      tracking" state on top of a legitimate purchase. We log
    //      HARD, throw a distinct error code, and hand off to a human
    //      for manual reconciliation (the audit trail + Shippo dashboard
    //      have the tracking number, we just failed to record it).

    // Vendor-requested insurance (migration 0055). When set, insure the
    // shipment for the order's declared value. Read via raw SQL so a stale
    // local Prisma client (missing the new columns) can't break the buy.
    const insRows = await this.prisma.$queryRaw<
      Array<{ insurance_requested: boolean; items_declared_value_cents: number }>
    >(Prisma.sql`
      SELECT insurance_requested, items_declared_value_cents
      FROM orders WHERE id = ${orderId}::uuid
    `);
    const insuranceCents =
      insRows[0]?.insurance_requested && (insRows[0]?.items_declared_value_cents ?? 0) > 0
        ? insRows[0].items_declared_value_cents
        : 0;

    let label: LabelResponse;
    try {
      label = await this.shippo.purchaseLabel({
        shipmentId: inner.shipmentProviderRef,
        rateId: inner.rateProviderRef,
        ...(insuranceCents > 0 ? { insuranceCents } : {}),
      });
    } catch (labelErr) {
      // ---- Class A — Shippo refused. Compensate. -----------------------
      const shippoDetail = this.extractErrorDetail(labelErr);
      this.logger.error(
        {
          msg: "selectRate: label purchase refused by Shippo — compensating",
          orderId,
          rateProviderRef: inner.rateProviderRef,
          shippoDetail,
        },
        labelErr instanceof Error ? labelErr.stack : undefined,
      );

      // Per-leg tracking. Refund and status-revert are independent
      // operations and either can fail (e.g. status revert needs
      // migration 0050 to be applied). We must NOT lie about which
      // legs succeeded — the operator needs to know precisely what
      // state the order is in so they don't try to pick again on top
      // of a partial refund.
      let refundOk = false;
      let statusRevertOk = false;
      let refundErr: string | undefined;
      let statusErr: string | undefined;

      try {
        await this.wallet.credit({
          vendorId: inner.vendorId,
          amountCents: inner.shippingCostCents,
          type: "REFUND",
          description: `Refund · label purchase failed for ${inner.carrier} ${inner.service}`,
          referenceType: "order",
          referenceId: orderId,
          actorId,
        });
        refundOk = true;
      } catch (err) {
        refundErr = this.extractErrorDetail(err);
        this.logger.error(
          {
            msg: "selectRate: WALLET REFUND FAILED during compensation — MANUAL RECONCILIATION REQUIRED",
            orderId,
            vendorId: inner.vendorId,
            debitedCents: inner.shippingCostCents,
            refundErr,
          },
          err instanceof Error ? err.stack : undefined,
        );
      }

      // Status revert — permitted by migration 0050
      // (SHIPPING_PAID → AWAITING_SHIPPING_SELECTION whitelist).
      // Absent that migration, the trigger raises 'check_violation'
      // and this leg fails; we report that honestly rather than
      // silently claiming success. Column note: no
      // `shipment_provider_ref` on `orders` (see Phase 1 UPDATE).
      try {
        await this.prisma.$transaction(async (tx) => {
          await tx.$executeRaw(Prisma.sql`
            UPDATE orders
               SET status = 'AWAITING_SHIPPING_SELECTION'::"OrderStatus",
                   shipping_cost_cents = 0,
                   shipping_fee_cents  = 0,
                   carrier             = NULL,
                   carrier_service     = NULL,
                   rate_provider_ref   = NULL,
                   total_charged_cents = total_charged_cents - ${inner.shippingCostCents},
                   updated_at = NOW()
             WHERE id = ${orderId}::uuid
          `);
        });
        statusRevertOk = true;
      } catch (err) {
        statusErr = this.extractErrorDetail(err);
        this.logger.error(
          {
            msg: "selectRate: STATUS REVERT FAILED during compensation — order stuck in SHIPPING_PAID",
            orderId,
            statusErr,
          },
          err instanceof Error ? err.stack : undefined,
        );
      }

      // Audit whatever state we ended in — best-effort so audit isn't
      // yet another failure mode that hides the truth.
      await this.audit
        .log({
          actorId,
          action: "order.label_purchase_failed",
          resourceType: "order",
          resourceId: orderId,
          beforeState: { status: "SHIPPING_PAID" } as unknown as Prisma.InputJsonValue,
          afterState: {
            status: statusRevertOk
              ? "AWAITING_SHIPPING_SELECTION"
              : "SHIPPING_PAID",
            refundOk,
            statusRevertOk,
            refundedCents: refundOk ? inner.shippingCostCents : 0,
            shippoDetail,
            ...(refundErr ? { refundErr } : {}),
            ...(statusErr ? { statusErr } : {}),
          } as unknown as Prisma.InputJsonValue,
        })
        .catch(() => undefined);

      // Compose an honest message. The Shippo reason ALWAYS leads so
      // the operator understands the underlying refusal. Then a
      // compensation-status trailer explains what state the order is
      // in and what the operator should do next.
      const head = `Label purchase refused for ${inner.carrier} ${inner.service}: ${shippoDetail}`;
      const trailer =
        refundOk && statusRevertOk
          ? "Wallet has been refunded and the order is back to Awaiting shipping selection — pick a different rate and try again."
          : refundOk && !statusRevertOk
            ? "Wallet has been refunded, but the order status could not be reverted (state-machine rejected the transition — verify migration 0050 has been applied). Contact support to unstick the order before picking again."
            : !refundOk && statusRevertOk
              ? "Order status was reverted, but the wallet refund FAILED. DO NOT re-attempt — contact support IMMEDIATELY to reconcile the vendor's balance."
              : "Both wallet refund and status revert FAILED. Order is stuck in SHIPPING_PAID with the vendor still charged. Contact support IMMEDIATELY.";

      throw new BadRequestException({
        message: `${head}. ${trailer}`,
        code: "label_purchase_failed",
      });
    }

    // ---- Phase 2b — Label was purchased. Persist LABEL_PURCHASED. ------
    // From here on, the label EXISTS at the carrier. A failure of this
    // block means "we bought a label but couldn't record it" — a
    // reconciliation problem, NOT a compensation trigger.
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw(Prisma.sql`
          UPDATE orders
             SET status = 'LABEL_PURCHASED'::"OrderStatus",
                 label_purchased_at = NOW(),
                 tracking_number = ${label.trackingNumber},
                 label_url = ${label.labelUrl},
                 updated_at = NOW()
           WHERE id = ${orderId}::uuid
        `);
      });
    } catch (postWriteErr) {
      const detail = this.extractErrorDetail(postWriteErr);
      this.logger.error(
        {
          msg: "selectRate: CRITICAL — label was purchased but LABEL_PURCHASED write failed. Do NOT compensate; manual reconciliation required.",
          orderId,
          vendorId: inner.vendorId,
          trackingNumber: label.trackingNumber,
          labelUrl: label.labelUrl,
          detail,
        },
        postWriteErr instanceof Error ? postWriteErr.stack : undefined,
      );
      // Best-effort audit so the tracking number is captured
      // permanently even though the order row didn't update.
      await this.audit
        .log({
          actorId,
          action: "order.label_bought_state_stale",
          resourceType: "order",
          resourceId: orderId,
          afterState: {
            trackingNumber: label.trackingNumber,
            labelUrl: label.labelUrl,
            carrier: label.carrier,
            service: label.service,
            writeErr: detail,
          } as unknown as Prisma.InputJsonValue,
        })
        .catch(() => undefined);
      throw new InternalServerErrorException({
        code: "label_bought_state_stale",
        message: `Label was purchased successfully (tracking ${label.trackingNumber}) but the order status update failed [${detail}]. The vendor has been charged. Contact support with this correlation id so the order can be manually advanced.`,
      });
    }

    await this.audit.log({
      actorId,
      action: "order.label_purchased",
      resourceType: "order",
      resourceId: orderId,
      beforeState: { status: "SHIPPING_PAID" } as unknown as Prisma.InputJsonValue,
      afterState: {
        status: "LABEL_PURCHASED",
        trackingNumber: label.trackingNumber,
        labelUrl: label.labelUrl,
        carrier: label.carrier,
        service: label.service,
      } as unknown as Prisma.InputJsonValue,
    });

    return {
      outcome: "LABEL_PURCHASED" as const,
      balanceAfterCents: inner.balanceAfterCents,
      shippingCostCents: inner.shippingCostCents,
      carrier: inner.carrier,
      service: inner.service,
      rateProviderRef: inner.rateProviderRef,
      trackingNumber: label.trackingNumber,
      labelUrl: label.labelUrl,
    };
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  private assertPositiveDims(input: RecordPackInput): void {
    const check = (name: string, value: number): void => {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new BadRequestException({
          message: `${name} must be a positive number.`,
          code: "invalid_input",
        });
      }
    };
    check("lengthIn", input.lengthIn);
    check("widthIn", input.widthIn);
    check("heightIn", input.heightIn);
    check("weightOz", input.weightOz);
    if (!Number.isInteger(input.weightOz)) {
      throw new BadRequestException({
        message: "weightOz must be a positive integer (ounces).",
        code: "invalid_input",
      });
    }
    if (input.notes !== undefined && input.notes.length > 500) {
      throw new BadRequestException({
        message: "notes must be 500 characters or fewer.",
        code: "invalid_input",
      });
    }
  }

  /**
   * Best-effort human-readable extract from an unknown thrown value.
   *
   * Nest HttpException subclasses expose a structured response object
   * that usually carries the useful `message` field — reading it via
   * `getResponse()` avoids the "[object Object]" that a naïve
   * `String(err)` produces. Plain Errors fall through to `.message`.
   * Anything else is stringified.
   *
   * Length-capped to keep an accidental multi-KB blob (Shippo
   * occasionally returns a whole validation payload) from bloating
   * the response body or the audit-log row.
   */
  private extractErrorDetail(err: unknown): string {
    const MAX = 400;
    let text: string;
    if (
      err !== null &&
      typeof err === "object" &&
      "getResponse" in err &&
      typeof (err as { getResponse: () => unknown }).getResponse === "function"
    ) {
      const r = (err as { getResponse: () => unknown }).getResponse();
      if (typeof r === "string") text = r;
      else if (r !== null && typeof r === "object" && "message" in r) {
        const m = (r as { message?: unknown }).message;
        text = typeof m === "string" ? m : JSON.stringify(m);
      } else text = JSON.stringify(r);
    } else if (err instanceof Error) {
      text = err.message;
    } else {
      text = String(err);
    }
    if (text.length > MAX) text = `${text.slice(0, MAX)}…`;
    return text;
  }

  /**
   * Shared raw-SQL error mapper for the write paths in this service.
   *
   * Pass-through for the Nest HttpException subclasses we deliberately
   * throw from inside transaction bodies (BadRequest / Conflict /
   * NotFound). Everything else is presumed to be a Prisma-wrapped
   * Postgres failure — extract the diagnostic fields (Prisma code, pg
   * SQLSTATE, constraint / trigger name) and re-throw as a coded
   * InternalServerErrorException whose `message` embeds those fields
   * inline. Ops can then read the exact failing rule from the browser
   * without pulling correlationId logs.
   *
   * Returns `never` so the caller's control flow narrows correctly
   * (e.g. TypeScript accepts that a variable assigned inside `try` is
   * definitely assigned after the try/catch as long as the catch
   * always throws).
   */
  private throwWrappedRawSqlError(
    err: unknown,
    operation: string,
    code: string,
    orderId: string,
  ): never {
    if (
      err instanceof BadRequestException ||
      err instanceof ConflictException ||
      err instanceof NotFoundException
    ) {
      throw err;
    }
    const prismaCode =
      typeof err === "object" && err !== null && "code" in err
        ? String((err as { code?: unknown }).code ?? "")
        : "";
    const pgCode =
      typeof err === "object" &&
      err !== null &&
      "meta" in err &&
      typeof (err as { meta?: { code?: unknown } }).meta === "object"
        ? String((err as { meta?: { code?: unknown } }).meta?.code ?? "")
        : "";
    const pgMessage =
      typeof err === "object" &&
      err !== null &&
      "meta" in err &&
      typeof (err as { meta?: { message?: unknown } }).meta === "object"
        ? String((err as { meta?: { message?: unknown } }).meta?.message ?? "")
        : "";
    const constraintMatch = pgMessage.match(/constraint "([^"]+)"/);
    const triggerMatch = pgMessage.match(/order_status_[a-z_]+/);
    // Column-name extraction — pg 42703 "column ... does not exist"
    // is the exact class of bug we most want to pinpoint. Capture the
    // identifier between the "column" keyword and "does not exist".
    const columnMatch = pgMessage.match(/column "?([A-Za-z_][A-Za-z0-9_]*)"? .*does not exist/);
    const detail =
      constraintMatch?.[1] ??
      triggerMatch?.[0] ??
      (columnMatch ? `column=${columnMatch[1]}` : "");
    this.logger.error(
      {
        msg: `${operation}: raw SQL failure`,
        orderId,
        prismaCode,
        pgCode,
        detail,
        err: err instanceof Error ? err.message : String(err),
      },
      err instanceof Error ? err.stack : undefined,
    );
    const suffix = [
      prismaCode ? `prisma=${prismaCode}` : null,
      pgCode ? `pg=${pgCode}` : null,
      detail ? `at=${detail}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    const message = suffix
      ? `Operation ${operation} failed — a database write was rejected [${suffix}]. This usually means database migrations have not been applied in this environment, or an ops guardrail (trigger, constraint) refused the transition.`
      : `Operation ${operation} failed — a database write was rejected.`;
    throw new InternalServerErrorException({ message, code });
  }

  /**
   * Prisma returns Decimal columns as either a Decimal instance, a
   * plain number, or a string depending on the environment (raw query
   * vs generated client, Node vs edge). Handle all three.
   */
  private decimalToNumber(value: Prisma.Decimal | number | string | null): number {
    if (value === null) return 0;
    if (typeof value === "number") return value;
    if (typeof value === "string") return Number(value);
    return Number(value.toString());
  }

  /**
   * Builds a customs declaration for an international order from its lines
   * joined to their products (HS code, origin country and per-unit weight
   * live on the product; per-unit value is derived from the line's
   * declared value ÷ quantity). Returns undefined when the order has no
   * lines. Contents default to MERCHANDISE / DDU — the common case for a
   * fulfilled retail shipment.
   */
  private async buildOrderCustoms(orderId: string): Promise<CustomsDeclaration | undefined> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        product_name: string;
        quantity: number;
        declared_value_cents: number; // unit value × quantity
        weight_oz: number;
        hs_code: string | null;
        country_of_origin: string;
      }>
    >(Prisma.sql`
      SELECT ol.product_name, ol.quantity, ol.declared_value_cents,
             p.weight_oz, p.hs_code, p.country_of_origin
      FROM order_lines ol
      JOIN products p ON p.id = ol.product_id
      WHERE ol.order_id = ${orderId}::uuid
    `);
    if (rows.length === 0) return undefined;
    return {
      contentsType: "MERCHANDISE",
      signer: "USA Errands Fulfillment",
      incoterm: "DDU",
      items: rows.map((r) => {
        const qty = Math.max(1, r.quantity);
        return {
          description: r.product_name,
          quantity: r.quantity,
          netWeightOz: r.weight_oz,
          // Line declared value is unit × qty; divide back to per-unit for
          // the customs item (Shippo expects per-item value).
          valueCents: Math.round(r.declared_value_cents / qty),
          hsCode: r.hs_code ?? undefined,
          originCountry: (r.country_of_origin ?? "US").toUpperCase(),
        };
      }),
    };
  }
}
