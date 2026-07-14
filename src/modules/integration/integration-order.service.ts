/**
 * IntegrationOrderService — ingests orders pushed from a vendor's storefront
 * (POST /v1/integration/orders) and drops them into the same fulfillment
 * pipeline manual orders use (Migration 0038).
 *
 * Design: this service deliberately does NOT call into OrderService.create()
 * — that file is the "two-reviewer" money path and we avoid destabilising it.
 * Instead it reuses the same lower-level PRIMITIVES (WalletService.debit /
 * .credit, ShippoService rates, SmartyService validation, computeOrderFees,
 * aggregateParcel) and runs its own transaction, so the financial guarantees
 * (atomic stock-reserve + wallet-debit, FOR UPDATE locking) are identical.
 *
 * Two outcomes per ingest:
 *   ALLOCATED — mapped, funded, address ok → stock reserved + wallet debited,
 *               order lands in the admin work queue exactly like a manual one.
 *   ON_HOLD   — something needs a human/funds first. The order is created as a
 *               header-only placeholder carrying the normalized inbound payload
 *               (sourcePayload) and a holdReason; nothing is reserved or charged
 *               until it's released. Release re-runs allocation on the SAME row.
 *
 * Hold reasons: INSUFFICIENT_FUNDS (auto-releases on deposit / cron sweep),
 * UNMAPPED_SKU, INSUFFICIENT_STOCK, ADDRESS_INVALID (admin resolves).
 */

import { HttpException, HttpStatus, Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { Order, OrderLine, OrderStatus, PrismaClient } from "@prisma/client";

import { loadConfig } from "../../common/config";
import { loadFeeSchedule } from "../../common/fees";
import { formatOrderRef } from "../../common/order-ref";
import { aggregateParcel, computeOrderFees } from "../../common/order-fees";
import { PrismaService } from "../../common/prisma.service";
import type { IntegrationOrderInput } from "../../common/schemas/integration.schema";
import { AuditService } from "../audit/audit.service";
import { ShippoService, type ShippingRate } from "../integrations/shippo/shippo.service";
import { SmartyService } from "../integrations/smarty/smarty.service";
import { NotificationService } from "../notifications/notification.service";
import { OpsAlertService } from "../notifications/ops-alert.service";
import { WalletService } from "../wallet/wallet.service";

type Tx = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

interface SkuLockRow {
  id: string;
  vendor_id: string;
  quantity_available: number;
  status: string;
}

/** A storefront line resolved from product code → concrete active SKU. */
interface ResolvedLine {
  code: string;
  quantity: number;
  productId: string;
  productName: string;
  variant: string;
  declaredValueCents: number;
  weightOz: number;
  lengthIn: number | null;
  widthIn: number | null;
  heightIn: number | null;
  skuId: string;
  quantityAvailable: number;
}

export type HoldReason =
  | "INSUFFICIENT_FUNDS"
  | "UNMAPPED_SKU"
  | "INSUFFICIENT_STOCK"
  | "ADDRESS_INVALID";

export interface IntegrationOrderResult {
  id: string;
  orderNumber: number;
  externalReference: string | null;
  status: OrderStatus;
  held: boolean;
  holdReason: string | null;
  carrierService: string | null;
  totalChargedCents: number;
  trackingNumber: string | null;
  lines: Array<{ sku: string; productName: string; quantity: number }>;
}

/** Thrown inside the allocation transaction so the caller can convert a
 *  stock shortfall (only knowable under the row lock) into an ON_HOLD. */
class InsufficientStockError extends Error {}

/**
 * Migration 0047 — thrown by `ingest` while the v2 rewrite is
 * outstanding. Surfaces as HTTP 501 with a stable code so a
 * storefront integration can distinguish it from a transient error.
 */
export class IntegrationV2NotImplementedError extends HttpException {
  constructor() {
    super(
      {
        message:
          "Storefront integration is temporarily disabled during migration to Fulfillment v2. Contact support to enable.",
        code: "integration_v2_migration_pending",
      },
      HttpStatus.NOT_IMPLEMENTED,
    );
  }
}

@Injectable()
export class IntegrationOrderService {
  private readonly logger = new Logger(IntegrationOrderService.name);
  private readonly cfg = loadConfig();
  private readonly warehouseOrigin = {
    state: this.cfg.WAREHOUSE_FROM_STATE,
    postalCode: this.cfg.WAREHOUSE_FROM_ZIP,
    country: "US",
  } as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly smarty: SmartyService,
    private readonly shippo: ShippoService,
    private readonly audit: AuditService,
    private readonly opsAlerts: OpsAlertService,
    private readonly notifications: NotificationService,
  ) {}

  // ===========================================================================
  // INGEST — entry point from the API-key-authed controller.
  // ===========================================================================

  async ingest(_args: {
    vendorId: string;
    apiKeyId: string | null;
    input: IntegrationOrderInput;
  }): Promise<IntegrationOrderResult> {
    // ---- Migration 0047 — Fulfillment v1 abolition ----
    //
    // Per the v2 spec ("Studio mvp task 71326.pdf", page 4, yellow
    // highlight): "FOR ORDERS FLOWING IN THROUGH INTEGRATION FROM
    // VENDOR ECOMMERCE STORE, ONLY FULFILLMENT SHOULD BE CHARGED, AND
    // WHEN ADMIN OR WAREHOUSE STAFF PROCEEDS TO WORK ON ORDER THEY
    // CAN CHARGE THE WALLET FOR SHIPMENT".
    //
    // The pre-existing implementation of ingest / tryAllocate /
    // reserveDebitAndPersist was v1 semantics (Shippo quote + full
    // wallet debit at intake). Rewriting that ~700 lines of financial
    // code to v2 is a phase in its own right and is deferred alongside
    // the Shopify/WooCommerce integrations that would consume it
    // (product plan: vendor dashboard only for now).
    //
    // The prior code is preserved below in `tryAllocate` /
    // `reserveDebitAndPersist` for reference and for the eventual
    // rewrite. `ingest` itself hard-rejects so no v1 order can be
    // created via the API-key path in the meantime. The
    // `releaseHeldOrder` path is also unreachable in production while
    // ingest is gated, but its type surface stays valid.
    throw new IntegrationV2NotImplementedError();
  }

  // ===========================================================================
  // RELEASE — re-run allocation on an existing ON_HOLD order. Called by the
  // deposit hook, the cron sweep, and the admin "resolve & release" action.
  // ===========================================================================

  async releaseHeldOrder(
    orderId: string,
    actorId: string | null,
  ): Promise<{ released: boolean; status: OrderStatus; holdReason: string | null }> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.status !== "ON_HOLD") {
      return {
        released: false,
        status: order?.status ?? "CANCELLED",
        holdReason: order?.holdReason ?? null,
      };
    }

    const input = order.sourcePayload as unknown as IntegrationOrderInput | null;
    if (!input) {
      this.logger.warn({ orderId }, "Held order has no sourcePayload; cannot release.");
      return { released: false, status: order.status, holdReason: order.holdReason };
    }

    const outcome = await this.tryAllocate(order.vendorId, actorId, input, order.id);
    if (outcome.kind === "ALLOCATED") {
      await this.audit.log({
        actorId,
        action: "order.released",
        resourceType: "order",
        resourceId: order.id,
        beforeState: { status: "ON_HOLD", holdReason: order.holdReason },
        afterState: { status: "ALLOCATED", totalChargedCents: outcome.order.totalChargedCents },
      });
      void this.notifyVendorReleased(outcome.order);
      void this.alertOpsNewOrder(outcome.order, order.vendorId, outcome.order.lines.length);
      return { released: true, status: "ALLOCATED", holdReason: null };
    }

    // Still stuck — update the reason if it changed (e.g. funds arrived but a
    // SKU is now out of stock) so the admin sees the current blocker.
    if (outcome.reason !== order.holdReason) {
      await this.prisma.order.update({
        where: { id: order.id },
        data: { holdReason: outcome.reason },
      });
    }
    return { released: false, status: "ON_HOLD", holdReason: outcome.reason };
  }

  /**
   * Re-check every INSUFFICIENT_FUNDS hold for a vendor — invoked after a wallet
   * deposit so a top-up auto-releases queued orders. Best-effort and isolated:
   * one order failing to release never blocks the others.
   */
  async releaseFundedHoldsForVendor(vendorId: string): Promise<number> {
    const holds = await this.prisma.order.findMany({
      where: { vendorId, status: "ON_HOLD", holdReason: "INSUFFICIENT_FUNDS" },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
    let released = 0;
    for (const h of holds) {
      try {
        const r = await this.releaseHeldOrder(h.id, null);
        if (r.released) released++;
        else break; // funds exhausted — stop trying further holds this pass
      } catch (err) {
        this.logger.warn({ err, orderId: h.id }, "Auto-release of funded hold failed.");
      }
    }
    return released;
  }

  // ===========================================================================
  // STATUS LOOKUP — for the storefront to poll.
  // ===========================================================================

  async getByExternalReference(
    vendorId: string,
    externalReference: string,
  ): Promise<IntegrationOrderResult | null> {
    const order = await this.prisma.order.findUnique({
      where: { vendor_external_ref_unique: { vendorId, externalReference } },
      include: { lines: true },
    });
    return order ? this.toResult(order) : null;
  }

  // ===========================================================================
  // Allocation core
  // ===========================================================================

  private async tryAllocate(
    vendorId: string,
    actorId: string | null,
    input: IntegrationOrderInput,
    existingOrderId: string | null,
  ): Promise<
    | { kind: "ALLOCATED"; order: Order & { lines: OrderLine[] } }
    | { kind: "HELD"; reason: HoldReason }
  > {
    // 1. Map each storefront line (product code) → an active SKU.
    const mapping = await this.resolveLines(vendorId, input.lines);
    if (mapping.kind === "UNMAPPED") return { kind: "HELD", reason: "UNMAPPED_SKU" };
    const resolved = mapping.resolved;

    // 2. Address deliverability. A hard USPS rejection parks the order rather
    //    than 500-ing the storefront (the customer already paid the vendor).
    const addr = await this.smarty.verifyUS({
      line1: input.recipient.line1,
      line2: input.recipient.line2,
      city: input.recipient.city,
      state: input.recipient.state,
      postalCode: input.recipient.postalCode,
      country: input.recipient.country,
    });
    if (addr.outcome === "REJECTED") return { kind: "HELD", reason: "ADDRESS_INVALID" };

    // 3. Live rates → resolve the carrier service from the vendor's default
    //    (or per-request override), then compute fees off the real cost.
    const declaredValueCents = resolved.reduce((s, r) => s + r.declaredValueCents, 0);
    const totalUnits = resolved.reduce((s, r) => s + r.quantity, 0);
    const parcel = aggregateParcel(
      resolved.map((r) => ({
        qty: r.quantity,
        weightOz: r.weightOz,
        lengthIn: r.lengthIn,
        widthIn: r.widthIn,
        heightIn: r.heightIn,
      })),
    );

    const vendor = await this.prisma.vendor.findUniqueOrThrow({
      where: { id: vendorId },
      select: {
        integrationDefaultCarrierService: true,
        integrationDefaultInsurance: true,
      },
    });
    const insuranceRequested = input.shipping?.insurance ?? vendor.integrationDefaultInsurance;

    const rateResp = await this.shippo.getRates({
      fromAddress: this.warehouseOrigin,
      toAddress: {
        recipientName: input.recipient.name,
        line1: input.recipient.line1,
        line2: input.recipient.line2,
        city: input.recipient.city,
        state: input.recipient.state,
        postalCode: input.recipient.postalCode,
        country: input.recipient.country,
      },
      parcel,
      declaredValueCents,
      insuranceRequested,
    });

    const chosen = this.chooseRate(
      rateResp.rates,
      input.shipping?.carrierService ?? vendor.integrationDefaultCarrierService ?? null,
    );
    if (!chosen) {
      // No rates at all to this destination — treat as an address problem the
      // admin must look at rather than silently dropping the order.
      return { kind: "HELD", reason: "ADDRESS_INVALID" };
    }

    const schedule = await loadFeeSchedule(this.prisma);
    const fees = computeOrderFees({
      schedule,
      totalUnits,
      carrierCostCents: chosen.costCents,
      declaredValueCents,
      insuranceRequested,
    });

    // 4. Funds pre-check (outside the tx for a friendly hold; the debit inside
    //    re-checks under FOR UPDATE so a race can't overspend).
    const walletSnapshot = await this.wallet.get(vendorId);
    if (walletSnapshot.balanceCents < fees.totalChargedCents) {
      return { kind: "HELD", reason: "INSUFFICIENT_FUNDS" };
    }

    // 5. Atomic allocate: reserve stock + debit wallet + create/upgrade order.
    try {
      const order = await this.prisma.$transaction(async (tx) => {
        const orderId = await this.reserveDebitAndPersist(tx, {
          vendorId,
          actorId,
          input,
          resolved,
          fees,
          chosen,
          addressOutcome: addr.outcome,
          addressDetail: addr.detail ?? null,
          declaredValueCents,
          existingOrderId,
        });
        return tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { lines: true } });
      });
      return { kind: "ALLOCATED", order };
    } catch (err) {
      if (err instanceof InsufficientStockError) {
        return { kind: "HELD", reason: "INSUFFICIENT_STOCK" };
      }
      // A concurrent order may have drained the wallet between the pre-check
      // above and the FOR UPDATE debit inside the tx — WalletService throws
      // ConflictException{ code: "insufficient_funds" }. Convert that race into
      // a clean hold rather than surfacing a 500 to the storefront.
      if (this.isInsufficientFunds(err)) {
        return { kind: "HELD", reason: "INSUFFICIENT_FUNDS" };
      }
      throw err;
    }
  }

  /** The transactional money path: lock → validate stock → reserve → debit →
   *  create (or upgrade a held) order + lines + events. Returns the order id. */
  private async reserveDebitAndPersist(
    tx: Tx,
    p: {
      vendorId: string;
      actorId: string | null;
      input: IntegrationOrderInput;
      resolved: ResolvedLine[];
      fees: ReturnType<typeof computeOrderFees>;
      chosen: ShippingRate;
      addressOutcome: string;
      addressDetail: string | null;
      declaredValueCents: number;
      existingOrderId: string | null;
    },
  ): Promise<string> {
    const { vendorId, actorId, input, resolved, fees, chosen } = p;

    // Lock SKUs deterministically (sorted) to avoid deadlocks.
    const needBySku = new Map<string, number>();
    for (const r of resolved) needBySku.set(r.skuId, (needBySku.get(r.skuId) ?? 0) + r.quantity);
    const skuIds = Array.from(needBySku.keys()).sort();
    const locked = await this.lockSkus(tx, vendorId, skuIds);

    for (const [skuId, need] of needBySku) {
      const row = locked.get(skuId);
      if (!row || row.vendor_id !== vendorId || row.status !== "ACTIVE") {
        throw new InsufficientStockError(`SKU ${skuId} unavailable.`);
      }
      if (row.quantity_available < need) {
        throw new InsufficientStockError(`SKU ${skuId} short: have ${row.quantity_available}, need ${need}.`);
      }
    }

    const carrierLabel = `${chosen.carrier} ${chosen.service}`;

    // Create the order row first so movements + ledger reference it directly.
    let orderId: string;
    const moneyData = {
      itemsDeclaredValueCents: p.declaredValueCents,
      shippingCostCents: fees.shippingCostCents,
      shippingFeeCents: fees.shippingFeeCents,
      fulfillmentFeeCents: fees.fulfillmentFeeCents,
      insuranceFeeCents: fees.insuranceFeeCents,
      totalChargedCents: fees.totalChargedCents,
      carrier: chosen.carrier,
      carrierService: carrierLabel,
      rateProviderRef: chosen.shipmentId,
      ratePurchasedRef: chosen.rateId,
      addressValidationStatus: p.addressOutcome,
      addressValidationDetail: p.addressDetail
        ? ({ note: p.addressDetail } as Prisma.InputJsonValue)
        : Prisma.JsonNull,
    };

    if (p.existingOrderId) {
      // Upgrade a held placeholder in place — keeps one row per externalReference.
      const updated = await tx.order.update({
        where: { id: p.existingOrderId },
        data: {
          status: "ALLOCATED",
          holdReason: null,
          sourcePayload: Prisma.JsonNull,
          submittedAt: new Date(),
          allocatedAt: new Date(),
          ...moneyData,
        },
        select: { id: true },
      });
      orderId = updated.id;
    } else {
      const created = await tx.order.create({
        data: {
          vendorId,
          source: "API",
          externalReference: input.externalReference,
          status: "ALLOCATED",
          recipientName: input.recipient.name,
          recipientPhone: input.recipient.phone ?? null,
          recipientEmail: input.recipient.email ?? null,
          shipAddressLine1: input.recipient.line1,
          shipAddressLine2: input.recipient.line2 ?? null,
          shipCity: input.recipient.city,
          shipState: input.recipient.state,
          shipPostalCode: input.recipient.postalCode,
          shipCountry: input.recipient.country,
          submittedAt: new Date(),
          allocatedAt: new Date(),
          createdBy: null,
          ...moneyData,
        },
        select: { id: true },
      });
      orderId = created.id;
    }

    // Reserve stock.
    for (const [skuId, need] of needBySku) {
      await tx.sku.update({
        where: { id: skuId },
        data: {
          quantityAvailable: { decrement: need },
          quantityReserved: { increment: need },
        },
      });
      await tx.inventoryMovement.create({
        data: {
          vendorId,
          skuId,
          type: "RESERVE",
          deltaAvailable: -need,
          deltaReserved: need,
          referenceType: "order",
          referenceId: orderId,
          actorId,
        },
      });
    }

    // Debit the wallet (atomic SELECT FOR UPDATE inside WalletService).
    await this.wallet.debit(
      {
        vendorId,
        amountCents: fees.totalChargedCents,
        type: "FULFILLMENT",
        description: `Storefront order ${input.externalReference} → ${input.recipient.city}`,
        referenceType: "order",
        referenceId: orderId,
        actorId: actorId ?? undefined,
      },
      tx as unknown as Parameters<typeof this.wallet.debit>[1],
    );

    // Order lines — snapshot product info.
    for (const r of resolved) {
      await tx.orderLine.create({
        data: {
          orderId,
          vendorId,
          productId: r.productId,
          skuId: r.skuId,
          productCode: r.code,
          productName: r.productName,
          variant: r.variant,
          quantity: r.quantity,
          declaredValueCents: r.declaredValueCents,
          allocationStatus: "RESERVED",
        },
      });
    }

    // Timeline.
    await tx.orderEvent.create({
      data: {
        orderId,
        type: p.existingOrderId ? "order.released" : "order.ingested",
        description: p.existingOrderId
          ? "Hold released; stock reserved and wallet debited."
          : `Storefront order ingested with ${resolved.length} line(s).`,
        source: "SYSTEM",
        actorId,
        metadata: {
          source: "API",
          carrierService: carrierLabel,
          totalChargedCents: fees.totalChargedCents,
          externalReference: input.externalReference,
        },
      },
    });
    await tx.orderEvent.create({
      data: {
        orderId,
        type: "order.allocated",
        description: "Stock reserved; wallet debited.",
        source: "SYSTEM",
      },
    });

    return orderId;
  }

  /** Create a header-only placeholder for an order that couldn't allocate. */
  private async createHoldOrder(
    vendorId: string,
    actorId: string | null,
    input: IntegrationOrderInput,
    reason: HoldReason,
  ): Promise<Order & { lines: OrderLine[] }> {
    const order = await this.prisma.order.create({
      data: {
        vendorId,
        source: "API",
        externalReference: input.externalReference,
        status: "ON_HOLD",
        holdReason: reason,
        sourcePayload: input as unknown as Prisma.InputJsonValue,
        recipientName: input.recipient.name,
        recipientPhone: input.recipient.phone ?? null,
        recipientEmail: input.recipient.email ?? null,
        shipAddressLine1: input.recipient.line1,
        shipAddressLine2: input.recipient.line2 ?? null,
        shipCity: input.recipient.city,
        shipState: input.recipient.state,
        shipPostalCode: input.recipient.postalCode,
        shipCountry: input.recipient.country,
        createdBy: null,
      },
      include: { lines: true },
    });
    await this.prisma.orderEvent.create({
      data: {
        orderId: order.id,
        type: "order.held",
        description: `Order held: ${reason}.`,
        source: "SYSTEM",
        actorId,
        metadata: { reason, externalReference: input.externalReference },
      },
    });
    await this.audit.log({
      actorId,
      action: "order.held",
      resourceType: "order",
      resourceId: order.id,
      afterState: { source: "API", holdReason: reason, externalReference: input.externalReference },
    });
    return order;
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /** Resolve storefront product codes → concrete active SKUs. */
  private async resolveLines(
    vendorId: string,
    lines: IntegrationOrderInput["lines"],
  ): Promise<{ kind: "OK"; resolved: ResolvedLine[] } | { kind: "UNMAPPED" }> {
    const codes = Array.from(new Set(lines.map((l) => l.sku)));
    const products = await this.prisma.product.findMany({
      where: { vendorId, code: { in: codes }, status: "ACTIVE" },
      include: {
        skus: {
          where: { status: "ACTIVE" },
          orderBy: { quantityAvailable: "desc" },
        },
      },
    });
    const byCode = new Map(products.map((p) => [p.code, p]));

    const resolved: ResolvedLine[] = [];
    for (const line of lines) {
      const product = byCode.get(line.sku);
      // Unmapped if the code is unknown OR the product has no receivable SKU
      // bucket yet (nothing has been received against it).
      const sku = product?.skus[0];
      if (!product || !sku) return { kind: "UNMAPPED" };
      resolved.push({
        code: product.code,
        quantity: line.quantity,
        productId: product.id,
        productName: product.name,
        variant: sku.variant,
        declaredValueCents: product.declaredValueCents * line.quantity,
        weightOz: product.weightOz,
        lengthIn: product.lengthIn,
        widthIn: product.widthIn,
        heightIn: product.heightIn,
        skuId: sku.id,
        quantityAvailable: sku.quantityAvailable,
      });
    }
    return { kind: "OK", resolved };
  }

  /** Pick the rate matching the wanted service label, else cheapest. */
  private chooseRate(rates: ShippingRate[], wanted: string | null): ShippingRate | null {
    if (rates.length === 0) return null;
    const cheapest = [...rates].sort((a, b) => a.costCents - b.costCents)[0]!;
    const want = (wanted ?? "").trim();
    if (!want || want.toUpperCase() === "CHEAPEST") return cheapest;
    const match = rates.find(
      (r) => `${r.carrier} ${r.service}`.toLowerCase() === want.toLowerCase(),
    );
    // Fall back to cheapest if the configured service isn't offered to this
    // destination — better to ship than to drop a paid order.
    return match ?? cheapest;
  }

  /** True when an error is WalletService's insufficient-funds ConflictException. */
  private isInsufficientFunds(err: unknown): boolean {
    const resp = (err as { getResponse?: () => unknown })?.getResponse?.();
    return (resp as { code?: string } | undefined)?.code === "insufficient_funds";
  }

  private async lockSkus(tx: Tx, vendorId: string, skuIds: string[]): Promise<Map<string, SkuLockRow>> {
    if (skuIds.length === 0) return new Map();
    const rows = await tx.$queryRaw<SkuLockRow[]>(
      Prisma.sql`
        SELECT id, vendor_id, quantity_available, status
        FROM skus
        WHERE id IN (${Prisma.join(skuIds)})
          AND vendor_id = ${vendorId}::uuid
        ORDER BY id
        FOR UPDATE
      `,
    );
    return new Map(rows.map((r) => [r.id, r]));
  }

  private toResult(order: Order & { lines: OrderLine[] }): IntegrationOrderResult {
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      externalReference: order.externalReference,
      status: order.status,
      held: order.status === "ON_HOLD",
      holdReason: order.holdReason,
      carrierService: order.carrierService,
      totalChargedCents: order.totalChargedCents,
      trackingNumber: order.trackingNumber,
      lines: order.lines.map((l) => ({
        sku: l.productCode,
        productName: l.productName,
        quantity: l.quantity,
      })),
    };
  }

  // ---- Notifications (all fire-and-forget; never block the order) ----------

  private async alertOpsNewOrder(
    order: Order,
    vendorId: string,
    lineCount: number,
  ): Promise<void> {
    try {
      const vendor = await this.prisma.vendor.findUnique({
        where: { id: vendorId },
        select: { businessName: true },
      });
      const ref = formatOrderRef(order.orderNumber);
      await this.opsAlerts.send({
        type: "ops.order.new",
        subject: `New storefront order ${ref} — ${vendor?.businessName ?? "vendor"}`,
        html: `<p>Storefront order <strong>${ref}</strong> from ${vendor?.businessName ?? "a vendor"} (${lineCount} line(s), $${(order.totalChargedCents / 100).toFixed(2)}) is allocated and ready to fulfill.</p>`,
        text: `Storefront order ${ref} allocated — ${lineCount} line(s), $${(order.totalChargedCents / 100).toFixed(2)}.`,
        idempotencyKey: `ops:order:${order.id}`,
        href: `/admin/orders/${order.id}`,
      });
    } catch {
      /* best-effort */
    }
  }

  private async alertHold(order: Order, vendorId: string, reason: HoldReason): Promise<void> {
    const ref = formatOrderRef(order.orderNumber);
    const human: Record<HoldReason, string> = {
      INSUFFICIENT_FUNDS: "your wallet balance is too low to cover the fee",
      UNMAPPED_SKU: "one or more items don't match a stored product code",
      INSUFFICIENT_STOCK: "there isn't enough stock on hand",
      ADDRESS_INVALID: "the shipping address couldn't be verified",
    };
    // Vendor in-app notification.
    void this.notifications
      .emit({
        vendorId,
        type: "order.held",
        severity: "WARNING",
        title: `Storefront order ${ref} is on hold`,
        body: `We received order ${order.externalReference} from your store but ${human[reason]}. ${reason === "INSUFFICIENT_FUNDS" ? "It will ship automatically once you top up your wallet." : "Please resolve it to continue."}`,
        href: `/orders/${order.id}`,
      })
      .catch(() => undefined);
    // Ops alert.
    try {
      await this.opsAlerts.send({
        type: "ops.order.held",
        subject: `Storefront order ${ref} held — ${reason}`,
        html: `<p>Order <strong>${ref}</strong> (ext ${order.externalReference}) was ingested but held: <strong>${reason}</strong>.</p>`,
        text: `Order ${ref} held: ${reason}.`,
        idempotencyKey: `ops:order:held:${order.id}`,
        href: `/admin/orders/${order.id}`,
      });
    } catch {
      /* best-effort */
    }
  }

  private async notifyVendorReleased(order: Order): Promise<void> {
    void this.notifications
      .emit({
        vendorId: order.vendorId,
        type: "order.released",
        severity: "INFO",
        title: `Storefront order ${formatOrderRef(order.orderNumber)} released`,
        body: `Order ${order.externalReference} is now being fulfilled.`,
        href: `/orders/${order.id}`,
      })
      .catch(() => undefined);
  }
}
