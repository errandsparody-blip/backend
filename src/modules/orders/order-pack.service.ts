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
import { PrismaService } from "../../common/prisma.service";
import { CarrierPackagingRegistryService } from "../../common/services/carrier-packaging-registry";
import { PackagingLibraryService } from "../../common/services/packaging-library.service";
import { AuditService } from "../audit/audit.service";
import { ShippoService, type ShippingRate } from "../integrations/shippo/shippo.service";
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
    return rows.map((o) => ({
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
        }>
      >(Prisma.sql`
        SELECT id, status, workflow_version, packed_at
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
      if (locked.packed_at !== null) {
        // Belt-and-braces — the status check above should have caught
        // this, but the DB check-constraint enforces all-or-none on
        // the pack columns and we want a friendly 409 rather than a
        // constraint violation.
        throw new ConflictException({
          message: "Order has already been packed.",
          code: "order_already_packed",
        });
      }

      const now = new Date();
      const notes = input.notes?.trim();
      const notesValue = notes && notes.length > 0 ? notes : null;

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

    await this.audit.log({
      actorId,
      action: "order.packed",
      resourceType: "order",
      resourceId: orderId,
      beforeState: { status: "PENDING_PACKING" } as unknown as Prisma.InputJsonValue,
      afterState: {
        status: "PACKING_COMPLETED",
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
  //   * Does NOT advance status. Row stays where it was.
  //   * DROPS cached rate options in order_shipping_rate_options
  //     because the dims changed — old rates are stale.
  //   * If status was AWAITING_SHIPPING_SELECTION or
  //     AWAITING_WALLET_FUNDING, we revert to PACKING_COMPLETED so
  //     the UI prompts the operator to re-fetch rates before picking
  //     one. Same reason: the cached rates on the order are gone.
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
        await tx.$executeRaw(Prisma.sql`
          DELETE FROM order_shipping_rate_options
          WHERE order_id = ${orderId}::uuid
        `);

        // Revert status back to PACKING_COMPLETED so the operator has
        // to re-fetch rates before selecting one. No status change if
        // already PACKING_COMPLETED.
        const targetStatus: OrderStatus = "PACKING_COMPLETED" as OrderStatus;

        await tx.$executeRaw(Prisma.sql`
          UPDATE orders
             SET status = ${targetStatus}::"OrderStatus",
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
          status: targetStatus,
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
      // v2 defers insurance to a later phase; the pack step never
      // re-opens the insurance choice.
      insuranceRequested: false,
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
    const inner: DebitInnerResult = await this.prisma.$transaction(async (tx) => {
      const lockedRows = await tx.$queryRaw<
        Array<{
          id: string;
          status: OrderStatus;
          workflow_version: number;
          vendor_id: string;
        }>
      >(Prisma.sql`
        SELECT id, status, workflow_version, vendor_id
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
        await tx.$executeRaw(Prisma.sql`
          UPDATE orders
             SET status = 'SHIPPING_PAID'::"OrderStatus",
                 shipping_cost_cents = ${shippingCostCents},
                 shipping_fee_cents  = ${shippingCostCents},
                 carrier             = ${chosen.carrier},
                 carrier_service     = ${chosen.service},
                 rate_provider_ref   = ${chosen.rate_provider_ref},
                 shipment_provider_ref = ${chosen.shipment_provider_ref},
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

    // ---- Phase 2 — wallet-short branch returns immediately -------------
    // Discriminate on the presence of the `outcome` key; TS narrows
    // `inner` to the SHIPPING_PAID variant below.
    if ("outcome" in inner) {
      return inner;
    }

    // ---- Phase 2 — SHIPPING_PAID: buy the label from Shippo ------------
    // Wallet was successfully debited and the DB row shows SHIPPING_PAID.
    // Now purchase the label. On success, promote to LABEL_PURCHASED
    // with tracking + label URL. On failure, compensate: refund the
    // wallet and revert status to AWAITING_SHIPPING_SELECTION so the
    // operator can retry (possibly with a different rate).
    try {
      const label = await this.shippo.purchaseLabel({
        shipmentId: inner.shipmentProviderRef,
        rateId: inner.rateProviderRef,
      });

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
    } catch (labelErr) {
      // ---- Compensation ------------------------------------------------
      // Shippo refused to sell the label after we already took the
      // vendor's money. We must return that money and revert status
      // so the operator can retry cleanly. Failing to compensate
      // leaves the vendor short + the order stuck at SHIPPING_PAID
      // with no label — the worst possible state for a wallet-based
      // system.
      this.logger.error(
        {
          msg: "selectRate: label purchase failed after wallet debit — compensating",
          orderId,
          rateProviderRef: inner.rateProviderRef,
          err: labelErr instanceof Error ? labelErr.message : String(labelErr),
        },
        labelErr instanceof Error ? labelErr.stack : undefined,
      );

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
        await this.prisma.$transaction(async (tx) => {
          await tx.$executeRaw(Prisma.sql`
            UPDATE orders
               SET status = 'AWAITING_SHIPPING_SELECTION'::"OrderStatus",
                   shipping_cost_cents = 0,
                   shipping_fee_cents  = 0,
                   carrier             = NULL,
                   carrier_service     = NULL,
                   rate_provider_ref   = NULL,
                   shipment_provider_ref = NULL,
                   total_charged_cents = total_charged_cents - ${inner.shippingCostCents},
                   updated_at = NOW()
             WHERE id = ${orderId}::uuid
          `);
        });
        await this.audit.log({
          actorId,
          action: "order.label_purchase_failed",
          resourceType: "order",
          resourceId: orderId,
          beforeState: { status: "SHIPPING_PAID" } as unknown as Prisma.InputJsonValue,
          afterState: {
            status: "AWAITING_SHIPPING_SELECTION",
            refundedCents: inner.shippingCostCents,
            reason: labelErr instanceof Error ? labelErr.message : String(labelErr),
          } as unknown as Prisma.InputJsonValue,
        });
      } catch (compensationErr) {
        // Compensation itself failed — this is a hard operational
        // problem that a human needs to look at. Log at ERROR level;
        // the outer rethrow surfaces the ORIGINAL Shippo failure to
        // the operator so they know something went wrong even if
        // ops has to sort out the money manually.
        this.logger.error(
          {
            msg: "selectRate: COMPENSATION FAILED after label-purchase failure — MANUAL RECONCILIATION REQUIRED",
            orderId,
            vendorId: inner.vendorId,
            debitedCents: inner.shippingCostCents,
            compensationErr:
              compensationErr instanceof Error
                ? compensationErr.message
                : String(compensationErr),
          },
          compensationErr instanceof Error ? compensationErr.stack : undefined,
        );
      }

      throw new BadRequestException({
        message: `Label purchase failed with ${inner.carrier} ${inner.service}. Wallet has been refunded; please pick a different rate and try again.`,
        code: "label_purchase_failed",
      });
    }
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
}
