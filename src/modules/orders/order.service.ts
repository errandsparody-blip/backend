/**
 * OrderService — fulfillment workflow's transactional core.
 *
 * Implementation Plan §6.6, §14.3 (atomic order create).
 *
 * Critical guarantees:
 *
 *   1. Stock reservation + wallet debit happen in ONE transaction.
 *      Insufficient funds OR insufficient stock OR fee mismatch =>
 *      everything rolls back. Vendor sees an error; nothing changed.
 *
 *   2. Inventory rows are locked with `SELECT ... FOR UPDATE`. Two concurrent
 *      orders for the same SKU cannot both succeed if there's only one in stock.
 *
 *   3. Money math is computed once and snapshotted on the order row; the
 *      service never recomputes silently. Reassessment writes a separate
 *      ledger entry + an explicit `reassessment_delta_cents` value.
 *
 *   4. Address validation runs BEFORE any DB write. A REJECTED address
 *      hard-fails. NEEDS_VERIFICATION is allowed (vendor took on the risk),
 *      but the outcome is recorded so support can audit.
 *
 *   5. Tenant scoping is enforced everywhere — every read filters by
 *      vendorId; every write trusts only the (vendorId, id) tuple.
 *
 * Two reviewers required for any change to this file (Implementation Plan §17.1).
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  Order,
  OrderLine,
  OrderStatus,
  PrismaClient,
} from "@prisma/client";

import { loadConfig } from "../../common/config";
import { loadFeeSchedule } from "../../common/fees";
import { formatOrderRef } from "../../common/order-ref";
import {
  aggregateParcel,
  computeOrderFees,
  type OrderFeeBreakdown,
} from "../../common/order-fees";
import { PrismaService } from "../../common/prisma.service";
import type {
  CancelOrderInput,
  CreateOrderInput,
  ListOrdersInput,
  OrderLineInput,
  QuoteOrderInput,
} from "../../common/schemas/order.schema";
import { CarrierPackagingRegistryService } from "../../common/services/carrier-packaging-registry";
import { ShippingPointService } from "../../common/services/shipping-point.service";
import { AuditService } from "../audit/audit.service";
import { opsNewOrderTemplate } from "../email/email-templates";
import { ShippoService } from "../integrations/shippo/shippo.service";
import { SmartyService, type AddressValidationResult } from "../integrations/smarty/smarty.service";
import { OpsAlertService } from "../notifications/ops-alert.service";
import { WalletService } from "../wallet/wallet.service";

type Tx = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

interface SkuLockRow {
  id: string;
  vendor_id: string;
  product_id: string;
  variant: string;
  quantity_available: number;
  quantity_reserved: number;
  status: string;
}

interface ProductSnapshot {
  id: string;
  code: string;
  name: string;
  weightOz: number;
  // Length/width/height became optional in migration 0009. The order-fees
  // aggregator handles nulls by treating them as 0 in the parcel
  // envelope; the carrier rates from weight alone in that case.
  lengthIn: number | null;
  widthIn: number | null;
  heightIn: number | null;
  declaredValueCents: number;
  countryOfOrigin: string;
}

interface ResolvedLine {
  input: OrderLineInput;
  sku: SkuLockRow;
  product: ProductSnapshot;
  declaredValueCents: number; // qty × product.declaredValueCents
}

export interface QuoteRateOption {
  carrier: string;
  service: string;
  estimatedDeliveryDays: number;
  shippingCostCents: number;
  fees: OrderFeeBreakdown;
  rateProviderRef: string; // Shippo shipment id (so the next /orders call can look up)
  ratePurchasedRef: string; // Shippo rate id
}

export interface QuoteResult {
  addressValidation: AddressValidationResult;
  totalUnits: number;
  declaredValueCents: number;
  rates: QuoteRateOption[];
}

export interface PublicOrder {
  id: string;
  /**
   * Monotonic, platform-assigned order number. Rendered as `#${orderNumber}`
   * in the portal and emails (migration 0029). The PRIMARY identifier shown
   * to vendors — externalReference below is their own optional bookkeeping
   * id and is surfaced as a secondary "Your reference" field.
   */
  orderNumber: number;
  externalReference: string | null;
  status: OrderStatus;
  recipient: {
    name: string;
    phone: string | null;
    email: string | null;
    line1: string;
    line2: string | null;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  };
  carrier: string | null;
  carrierService: string | null;
  trackingNumber: string | null;
  labelUrl: string | null;
  itemsDeclaredValueCents: number;
  shippingCostCents: number;
  shippingFeeCents: number;
  fulfillmentFeeCents: number;
  insuranceFeeCents: number;
  totalChargedCents: number;
  reassessmentDeltaCents: number;
  cancelReason: Order["cancelReason"];
  cancelNote: string | null;
  submittedAt: Date | null;
  allocatedAt: Date | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Migration 0041 — Fulfillment v2 discriminator.
   *   1 = legacy flow (Shippo quoted at submit, everything debited)
   *   2 = v2 flow (fulfillment fee only at submit, estimate range shown)
   * Vendor UI branches on this to render either the legacy money
   * breakdown or the v2 "estimate range + fulfillment paid" view.
   */
  workflowVersion: number;
  /**
   * Migration 0041 — v2 shipping estimate captured at submit time.
   * Both null for legacy (workflowVersion=1) orders AND for v2
   * VENDOR_CARRIER orders (no platform shipping to estimate).
   */
  estimatedShippingMinCents: number | null;
  estimatedShippingMaxCents: number | null;
  /**
   * Phase O — vendor-visible packaging summary. All null until the
   * warehouse records pack; then reflects the actual outside-of-box
   * dimensions and parcel weight sent to the carrier. `packagingLabel`
   * resolves to either the library-preset label (e.g. "USPS Medium
   * Flat Rate Box"), the carrier-template friendly name (e.g. "UPS
   * Simple Rate — Small") or NULL for pure ad-hoc packaging.
   */
  packedLengthIn: number | null;
  packedWidthIn: number | null;
  packedHeightIn: number | null;
  packedWeightOz: number | null;
  packedAt: Date | null;
  packagingLabel: string | null;
  lines: Array<{
    id: string;
    skuId: string;
    productCode: string;
    productName: string;
    variant: string;
    quantity: number;
    declaredValueCents: number;
    allocationStatus: string;
  }>;
}

@Injectable()
export class OrderService {
  private readonly cfg = loadConfig();
  /** Warehouse origin sourced from validated env config — no magic numbers. */
  private readonly warehouseOrigin = {
    state: this.cfg.WAREHOUSE_FROM_STATE,
    postalCode: this.cfg.WAREHOUSE_FROM_ZIP,
    country: "US",
  } as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly wallet: WalletService,
    private readonly smarty: SmartyService,
    private readonly shippo: ShippoService,
    // OpsAlertService fans an email (to OPS_ALERT_EMAILS) plus an
    // in-app notification (to every active admin user) when a vendor
    // creates an order, so ops sees the new pick/pack work without
    // having to refresh the admin orders list.
    private readonly opsAlerts: OpsAlertService,
    // Migration 0041 — Fulfillment v2 uses shipping points to compute
    // the vendor-facing estimate range at submit time. Injected via
    // the @Global() ShippingPointModule (migration 0040).
    private readonly shippingPoints: ShippingPointService,
    // Phase O — resolves an order's parcel_template (Shippo carrier
    // template) to its friendly label so the vendor-visible packaging
    // summary reads "USPS Medium Flat Rate Box" rather than
    // "USPS_MediumFlatRateBox1".
    private readonly carrierRegistry: CarrierPackagingRegistryService,
  ) {}

  // ===========================================================================
  // VALIDATE ADDRESS — called by the order-new form before submit so vendors
  // see USPS rejection inline, not after wallet debit. No DB write.
  // ===========================================================================

  async validateAddress(input: {
    shipAddressLine1: string;
    shipAddressLine2?: string | undefined;
    shipCity: string;
    shipState: string;
    shipPostalCode: string;
    shipCountry: string;
  }): Promise<{
    outcome: "ACCEPTED" | "NEEDS_VERIFICATION" | "REJECTED";
    detail?: string | undefined;
    suggested?:
      | {
          line1: string;
          line2?: string | undefined;
          city: string;
          state: string;
          postalCode: string;
          country: string;
        }
      | undefined;
  }> {
    const result = await this.smarty.verifyUS({
      line1: input.shipAddressLine1,
      line2: input.shipAddressLine2,
      city: input.shipCity,
      state: input.shipState,
      postalCode: input.shipPostalCode,
      country: input.shipCountry,
    });
    return {
      outcome: result.outcome,
      detail: result.detail,
      suggested: result.normalized
        ? {
            line1: result.normalized.line1,
            line2: result.normalized.line2,
            city: result.normalized.city,
            state: result.normalized.state,
            postalCode: result.normalized.postalCode,
            country: result.normalized.country,
          }
        : undefined,
    };
  }

  /**
   * Parse a single pasted address string into structured recipient fields via
   * Shippo's address parser. Powers the "paste a full address" convenience on
   * the order form — the vendor pastes one line and we split it into the
   * line1 / city / state / ZIP inputs for them to confirm.
   */
  async parseAddress(raw: string): Promise<{
    line1: string;
    line2: string | null;
    city: string;
    state: string;
    postalCode: string;
    country: string;
    phone: string | null;
  }> {
    return this.shippo.parseAddress(raw);
  }

  // ===========================================================================
  // QUOTE — pure read, no DB writes (besides the address validation cache).
  // ===========================================================================

  async quote(vendorId: string, input: QuoteOrderInput): Promise<QuoteResult> {
    // 1. Validate the destination address.
    const addressValidation = await this.smarty.verifyUS({
      line1: input.recipient.shipAddressLine1,
      line2: input.recipient.shipAddressLine2,
      city: input.recipient.shipCity,
      state: input.recipient.shipState,
      postalCode: input.recipient.shipPostalCode,
      country: input.recipient.shipCountry,
    });
    if (addressValidation.outcome === "REJECTED") {
      throw new BadRequestException({
        message: `Address rejected: ${addressValidation.detail ?? "invalid"}`,
        code: "address_rejected",
      });
    }

    // 2. Load and validate the SKUs / products. Read-only; no FOR UPDATE here.
    const resolved = await this.resolveLinesReadOnly(vendorId, input.lines);

    // 3. Aggregate parcel + declared value.
    const parcel = aggregateParcel(
      resolved.map((r) => ({
        qty: r.input.quantity,
        weightOz: r.product.weightOz,
        lengthIn: r.product.lengthIn,
        widthIn: r.product.widthIn,
        heightIn: r.product.heightIn,
      })),
    );
    const declaredValueCents = resolved.reduce((s, r) => s + r.declaredValueCents, 0);
    const totalUnits = resolved.reduce((s, r) => s + r.input.quantity, 0);

    // 4. Carrier rates.
    const rateResp = await this.shippo.getRates({
      fromAddress: this.warehouseOrigin,
      toAddress: {
        recipientName: input.recipient.recipientName,
        line1: input.recipient.shipAddressLine1,
        line2: input.recipient.shipAddressLine2,
        city: input.recipient.shipCity,
        state: input.recipient.shipState,
        postalCode: input.recipient.shipPostalCode,
        country: input.recipient.shipCountry,
      },
      parcel,
      declaredValueCents,
      insuranceRequested: input.insuranceRequested,
    });

    // 5. Convert each carrier rate into a fee preview.
    const schedule = await loadFeeSchedule(this.prisma);
    const rates = rateResp.rates
      .filter(
        (r) =>
          !input.preferredService ||
          `${r.carrier} ${r.service}`.toLowerCase().includes(input.preferredService.toLowerCase()),
      )
      .map<QuoteRateOption>((r) => ({
        carrier: r.carrier,
        service: r.service,
        estimatedDeliveryDays: r.estimatedDeliveryDays,
        shippingCostCents: r.costCents,
        fees: computeOrderFees({
          schedule,
          totalUnits,
          carrierCostCents: r.costCents,
          declaredValueCents,
          insuranceRequested: input.insuranceRequested,
        }),
        rateProviderRef: r.shipmentId,
        ratePurchasedRef: r.rateId,
      }));

    return { addressValidation, totalUnits, declaredValueCents, rates };
  }

  // ===========================================================================
  // FULFILLMENT ESTIMATE — fees only, no Shippo round-trip.
  //
  // Used by the VENDOR_CARRIER branch of the order wizard so the vendor
  // can see what handling + insurance will cost BEFORE they reach the
  // review step. Shipping is zero by definition on this branch (the
  // vendor brought their own label), so we pass carrierCostCents: 0
  // through the same fee math the carrier-quoted path uses — keeping
  // both branches honest against one source of truth.
  //
  // No address validation needed: this is a pricing read, not an order
  // commitment, and addresses don't change the handling fee. Read-only
  // SKU resolution is the only DB work.
  // ===========================================================================

  async fulfillmentEstimate(
    vendorId: string,
    input: { lines: OrderLineInput[]; insuranceRequested?: boolean },
  ): Promise<{
    totalUnits: number;
    declaredValueCents: number;
    fulfillmentFeeCents: number;
    insuranceFeeCents: number;
    totalCents: number;
  }> {
    const resolved = await this.resolveLinesReadOnly(vendorId, input.lines);
    const totalUnits = resolved.reduce((s, r) => s + r.input.quantity, 0);
    const declaredValueCents = resolved.reduce(
      (s, r) => s + r.declaredValueCents,
      0,
    );
    const schedule = await loadFeeSchedule(this.prisma);
    const fees = computeOrderFees({
      schedule,
      totalUnits,
      // Vendor-carrier orders never have a Shippo-bought label, so
      // shipping cost is structurally zero. The breakdown therefore
      // contains only handling + insurance — exactly what the wizard
      // displays as "Fulfillment cost".
      carrierCostCents: 0,
      declaredValueCents,
      insuranceRequested: input.insuranceRequested ?? false,
    });
    return {
      totalUnits,
      declaredValueCents,
      fulfillmentFeeCents: fees.fulfillmentFeeCents,
      insuranceFeeCents: fees.insuranceFeeCents,
      totalCents: fees.fulfillmentFeeCents + fees.insuranceFeeCents,
    };
  }

  // ===========================================================================
  // CREATE — atomic. Stock reservation + wallet debit + order + events.
  // ===========================================================================

  async create(
    vendorId: string,
    actorId: string,
    input: CreateOrderInput,
  ): Promise<PublicOrder> {
    // Fulfillment v1 was ABOLISHED per the v2 spec ("Studio mvp task
    // 71326.pdf", page 8, yellow highlight: "WE ARE ABOLISHING THIS
    // FLOW ENTIRELY"). Every submit — vendor wizard, CSV bulk import,
    // storefront webhook — goes through the v2 machine below.
    //
    // Existing legacy in-flight orders (workflowVersion=1) are NOT
    // migrated. They stay on their legacy transition machine (label
    // buy / pick / pack / ship) until they complete or cancel. The
    // workflowVersion column is the safety discriminator; it's set at
    // create time and never mutated.
    //
    // SRP: the public surface owns dispatch only; createV2 owns the
    // v2 lifecycle. Kept as a two-method shape (public create →
    // private createV2) so the legacy import graph doesn't change,
    // and so a future v3 could slot in with the same pattern.
    return this.createV2(vendorId, actorId, input);
  }

  // ===========================================================================
  // CREATE V2 — Fulfillment v2 (migration 0041). Feature-flag gated by
  // `fulfillment_v2_enabled`. See create() above for the dispatch entry
  // point.
  //
  // Divergence vs. legacy create() worth calling out:
  //
  //   * NO Shippo quote at submit. The vendor sees a shipping-points-
  //     based ESTIMATE range instead. Actual shipping is bought at pack
  //     time by admin (Phase C).
  //
  //   * NO insurance handling. Insurance is inherently tied to the
  //     carrier's insurance product, which we buy alongside the label.
  //     v2 defers that decision to pack time.
  //
  //   * Wallet debit is ONLY the fulfillment fee. Actual shipping is
  //     debited at pack-and-charge time (Phase C).
  //
  //   * Blocks submit when ANY product on the order lacks a
  //     shippingPoints value — a super admin must set it before the
  //     order can be created. This is what makes the ESTIMATE range
  //     honest.
  //
  //   * Wallet-cover validation: balance >= fulfillmentFee +
  //     estimatedShippingMaxCents. The top of the range is used so
  //     the vendor is protected from ordering something they can't
  //     afford to eventually ship. Backend enforcement mirrors the
  //     frontend gate.
  //
  //   * Terminal status is PENDING_PACKING, not ALLOCATED. Every
  //     downstream v2 transition service reads workflowVersion + this
  //     status to dispatch correctly.
  //
  // VENDOR_CARRIER (Fulfill Only) branch inside v2: same fulfillment
  // fee debit; skips shipping-points check, estimate resolution, and
  // wallet-cover check (no shipping to cover). Status still lands
  // PENDING_PACKING — the warehouse still barcode-scans + packs, then
  // hands off to the vendor's carrier at pack time.
  // ===========================================================================

  private async createV2(
    vendorId: string,
    actorId: string,
    input: CreateOrderInput,
  ): Promise<PublicOrder> {
    // 1. Address validation — same rules as legacy.
    const addressValidation = await this.smarty.verifyUS({
      line1: input.recipient.shipAddressLine1,
      line2: input.recipient.shipAddressLine2,
      city: input.recipient.shipCity,
      state: input.recipient.shipState,
      postalCode: input.recipient.shipPostalCode,
      country: input.recipient.shipCountry,
    });
    if (addressValidation.outcome === "REJECTED") {
      throw new BadRequestException({
        message: `Address rejected: ${addressValidation.detail ?? "invalid"}`,
        code: "address_rejected",
      });
    }

    // 2. Duplicate external-reference guard (same as legacy).
    if (input.externalReference) {
      const dup = await this.prisma.order.findUnique({
        where: {
          vendor_external_ref_unique: {
            vendorId,
            externalReference: input.externalReference,
          },
        },
        select: { id: true },
      });
      if (dup) {
        throw new ConflictException({
          message: "An order with this external reference already exists.",
          code: "order_external_ref_duplicate",
        });
      }
    }

    // 3. Resolve products (read-only). Reuses the legacy loader.
    const productsByCode = await this.loadProducts(vendorId, input.lines);

    const totalUnits = input.lines.reduce((s, l) => s + l.quantity, 0);
    const declaredValueCents = input.lines.reduce((s, l) => {
      const sku = productsByCode.bySkuId.get(l.skuId);
      if (!sku) {
        throw new BadRequestException({
          message: `Unknown SKU ${l.skuId}`,
          code: "order_invalid_sku",
        });
      }
      return s + sku.product.declaredValueCents * l.quantity;
    }, 0);

    // 4. Compute the fulfillment fee. carrierCost=0 by definition in v2
    // (no shipping bought yet). Insurance is deferred to pack time.
    const schedule = await loadFeeSchedule(this.prisma);
    const fees = computeOrderFees({
      schedule,
      totalUnits,
      carrierCostCents: 0,
      declaredValueCents,
      insuranceRequested: false,
    });
    const fulfillmentFeeCents = fees.fulfillmentFeeCents;

    // 5. Branch on fulfillmentMode for the shipping-side checks.
    // VENDOR_CARRIER (Fulfill Only) → skip everything shipping-related;
    // vendor pays their own carrier. PLATFORM_SHIP → resolve estimate
    // range + gate on shipping points + wallet cover.
    const isVendorCarrier = input.fulfillmentMode === "VENDOR_CARRIER";
    let estimatedShippingMinCents: number | null = null;
    let estimatedShippingMaxCents: number | null = null;

    if (!isVendorCarrier) {
      // 5a. Every product on the order must have shipping points
      // assigned. Super admin sets them at PSN receive time
      // (migration 0040). We refuse submit here so the vendor sees a
      // clear error rather than a $0 estimate that sails through
      // wallet validation.
      const productLines = input.lines.map((l) => {
        const r = productsByCode.bySkuId.get(l.skuId);
        return { productId: r!.product.id, quantity: l.quantity };
      });
      const pointRes = await this.shippingPoints.sumForLines(productLines);
      if (!pointRes.allAssigned) {
        const unassigned = pointRes.resolutions
          .filter((r) => !r.assigned)
          .map((r) => r.productId);
        throw new BadRequestException({
          message:
            "Some products on this order don't have shipping points assigned yet. A super admin must set them before this order can be submitted.",
          code: "order_missing_shipping_points",
          missingProductIds: unassigned,
        });
      }

      // 5b. Resolve the estimate range from the summed points.
      const range = await this.shippingPoints.resolveRange(pointRes.totalPoints);
      estimatedShippingMinCents = range.dollarsMin;
      estimatedShippingMaxCents = range.dollarsMax;

      // 5c. Wallet-cover validation. Balance must cover the
      // fulfillment fee AND the top of the estimated shipping range.
      // The top (not the bottom) is used so the vendor is protected
      // against ordering something the actual carrier quote would put
      // them under-funded on. The check is repeated at pack time
      // (Phase C) against the actual rate; this pre-flight is just
      // to catch obvious cases before we reserve inventory.
      const requiredCoverage = fulfillmentFeeCents + estimatedShippingMaxCents;
      const walletSnapshot = await this.wallet.get(vendorId);
      const walletBalance = walletSnapshot.balanceCents;
      if (walletBalance < requiredCoverage) {
        throw new ConflictException({
          message:
            `Wallet balance $${(walletBalance / 100).toFixed(2)} is below the required coverage $${(requiredCoverage / 100).toFixed(2)} ` +
            `(fulfillment $${(fulfillmentFeeCents / 100).toFixed(2)} + estimated shipping max $${(estimatedShippingMaxCents / 100).toFixed(2)}). ` +
            "Fund your wallet before submitting.",
          code: "order_wallet_insufficient",
          walletBalanceCents: walletBalance,
          requiredCoverageCents: requiredCoverage,
        });
      }
    }

    // 6. Optional hard cap. maxAcceptableTotalCents applies to the
    // fulfillment fee here (v2 doesn't charge shipping at submit).
    if (input.maxAcceptableTotalCents && fulfillmentFeeCents > input.maxAcceptableTotalCents) {
      throw new ConflictException({
        message: `Fulfillment fee $${(fulfillmentFeeCents / 100).toFixed(2)} exceeds your max of $${(input.maxAcceptableTotalCents / 100).toFixed(2)}.`,
        code: "order_total_exceeds_max",
      });
    }

    // 7. Transactional core.
    const order = await this.prisma.$transaction(async (tx) => {
      // 7a. Lock SKUs, validate, reserve — identical to legacy.
      const skuIds = Array.from(new Set(input.lines.map((l) => l.skuId))).sort();
      const lockedSkus = await this.lockSkus(tx, vendorId, skuIds);

      const linesByQty = new Map<string, number>();
      for (const l of input.lines) {
        linesByQty.set(l.skuId, (linesByQty.get(l.skuId) ?? 0) + l.quantity);
      }
      for (const skuId of skuIds) {
        const sku = lockedSkus.get(skuId);
        if (!sku) throw new NotFoundException(`SKU ${skuId} not found.`);
        if (sku.vendor_id !== vendorId) throw new NotFoundException(`SKU ${skuId} not found.`);
        if (sku.status !== "ACTIVE") {
          throw new ConflictException({
            message: `SKU ${skuId} is ${sku.status} and cannot be ordered.`,
            code: "order_sku_inactive",
          });
        }
        const need = linesByQty.get(skuId)!;
        if (sku.quantity_available < need) {
          throw new ConflictException({
            message: `Insufficient stock on SKU ${skuId}: have ${sku.quantity_available}, need ${need}.`,
            code: "order_insufficient_stock",
          });
        }
      }

      for (const [skuId, need] of linesByQty.entries()) {
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
            referenceId: null,
            actorId,
          },
        });
      }

      // 7b. Debit the FULFILLMENT FEE only. Shipping is charged at
      // pack time in Phase C.
      await this.wallet.debit(
        {
          vendorId,
          amountCents: fulfillmentFeeCents,
          type: "FULFILLMENT",
          description:
            `Fulfillment fee for ${input.lines.length} SKU(s) → ${input.recipient.shipCity}` +
            (isVendorCarrier ? " (Fulfill Only)" : ""),
          referenceType: "order",
          referenceId: undefined,
          actorId,
        },
        tx as unknown as Parameters<typeof this.wallet.debit>[1],
      );

      // 7c. Create the Order row. status=PENDING_PACKING;
      // workflowVersion=2; shipping-money-columns all zero (charged
      // at pack time); estimate range populated so the vendor sees
      // what they were told at submit.
      const created = await tx.order.create({
        data: {
          vendorId,
          externalReference: input.externalReference ?? null,
          status: "PENDING_PACKING" as OrderStatus,
          recipientName: input.recipient.recipientName,
          recipientPhone: input.recipient.recipientPhone ?? null,
          recipientEmail: input.recipient.recipientEmail ?? null,
          shipAddressLine1: input.recipient.shipAddressLine1,
          shipAddressLine2: input.recipient.shipAddressLine2 ?? null,
          shipCity: input.recipient.shipCity,
          shipState: input.recipient.shipState,
          shipPostalCode: input.recipient.shipPostalCode,
          shipCountry: input.recipient.shipCountry,
          addressValidationStatus: addressValidation.outcome,
          addressValidationDetail: addressValidation.detail
            ? ({
                note: addressValidation.detail,
                providerRef: addressValidation.providerRef ?? null,
              } as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          // v2 records carrier identity only for VENDOR_CARRIER (the
          // vendor tells us who's shipping it). PLATFORM_SHIP has no
          // carrier known until pack time.
          carrier: isVendorCarrier
            ? input.vendorCarrier?.vendorCarrierName ?? null
            : null,
          carrierService: isVendorCarrier ? "Vendor carrier" : null,
          rateProviderRef: null,
          ratePurchasedRef: null,
          // Migration 0037 fulfillmentMode + vendor-carrier fields.
          // Cast through unknown for the Railway/local Prisma-client
          // stale-generation pattern.
          ...({
            fulfillmentMode: input.fulfillmentMode,
            vendorCarrierName: isVendorCarrier
              ? input.vendorCarrier?.vendorCarrierName ?? null
              : null,
            vendorTrackingNumber: isVendorCarrier
              ? input.vendorCarrier?.vendorTrackingNumber ?? null
              : null,
            vendorLabelUrl: isVendorCarrier
              ? input.vendorCarrier?.vendorLabelUrl ?? null
              : null,
            // Migration 0041 columns — workflowVersion + estimate range.
            workflowVersion: 2,
            estimatedShippingMinCents,
            estimatedShippingMaxCents,
          } as Record<string, unknown>),
          trackingNumber: isVendorCarrier
            ? input.vendorCarrier?.vendorTrackingNumber ?? null
            : null,
          itemsDeclaredValueCents: declaredValueCents,
          // v2 shipping money is zero at submit — actual is charged
          // at pack time. totalChargedCents reflects ONLY what's
          // been debited so far (fulfillment fee).
          shippingCostCents: 0,
          shippingFeeCents: 0,
          fulfillmentFeeCents,
          insuranceFeeCents: 0,
          totalChargedCents: fulfillmentFeeCents,
          submittedAt: new Date(),
          // v2 doesn't stamp allocatedAt at submit — allocation is
          // gated on pack completion. Keeping the column null makes
          // "when did the warehouse actually take responsibility"
          // queryable.
          allocatedAt: null,
          createdBy: actorId,
        },
      });

      // 7d. OrderLines snapshot — identical to legacy.
      for (const l of input.lines) {
        const r = productsByCode.bySkuId.get(l.skuId);
        if (!r) throw new BadRequestException(`Unknown SKU ${l.skuId} during create.`);
        await tx.orderLine.create({
          data: {
            orderId: created.id,
            vendorId,
            productId: r.product.id,
            skuId: l.skuId,
            productCode: r.product.code,
            productName: r.product.name,
            variant: r.sku.variant,
            quantity: l.quantity,
            declaredValueCents: r.product.declaredValueCents * l.quantity,
            allocationStatus: "RESERVED",
          },
        });
      }

      // 7e. Patch referenceIds on the movements + ledger entries we
      // just wrote (couldn't set them before the order id existed).
      await tx.inventoryMovement.updateMany({
        where: {
          vendorId,
          referenceType: "order",
          referenceId: null,
          createdAt: { gte: created.createdAt },
        },
        data: { referenceId: created.id },
      });
      await tx.ledgerEntry.updateMany({
        where: {
          vendorId,
          referenceType: "order",
          referenceId: null,
          createdAt: { gte: created.createdAt },
        },
        data: { referenceId: created.id },
      });

      // 7f. Append-only timeline. v2 records the estimate range so
      // audit reproductions can prove "this is what the vendor was
      // told at submit" if a dispute arises later.
      await tx.orderEvent.create({
        data: {
          orderId: created.id,
          type: "order.submitted",
          description:
            `Order submitted (Fulfillment v2) — ${input.lines.length} line(s).` +
            (isVendorCarrier ? " Fulfill Only." : ""),
          source: "VENDOR",
          actorId,
          metadata: {
            workflowVersion: 2,
            fulfillmentMode: input.fulfillmentMode,
            fulfillmentFeeCents,
            estimatedShippingMinCents,
            estimatedShippingMaxCents,
          },
        },
      });

      return created;
    });

    // 8. Ops alert (best-effort, outside the transaction). Uses the
    // same opsNewOrderTemplate as the legacy path so the ops inbox
    // format stays consistent across the two flows.
    void (async () => {
      try {
        const vendorRow = await this.prisma.vendor.findUnique({
          where: { id: vendorId },
          select: { businessName: true },
        });
        const tpl = opsNewOrderTemplate({
          orderId: order.id,
          orderRef: formatOrderRef((order as unknown as { orderNumber: number }).orderNumber),
          vendorBusinessName: vendorRow?.businessName ?? "(unknown vendor)",
          lineCount: input.lines.length,
          // v2 has only charged the fulfillment fee at this point.
          // Ops sees "$X.XX (fulfillment only)" so they don't confuse
          // this with the legacy "everything at submit" number.
          totalChargedCents: fulfillmentFeeCents,
        });
        await this.opsAlerts.send({
          type: "ops.order.new",
          subject: tpl.subject,
          html: tpl.html,
          text: tpl.text,
          idempotencyKey: `ops:order:new:${order.id}`,
          href: `/admin/orders/${order.id}`,
        });
      } catch {
        // Fire-and-forget; a failed ops alert must never roll back
        // the order.
      }
    })();

    // 9. Refetch with lines included — toPublic requires them.
    const withLines = await this.prisma.order.findUnique({
      where: { id: order.id },
      include: { lines: true, packagingOption: true } as Prisma.OrderInclude,
    });
    if (!withLines) {
      throw new NotFoundException(`Order ${order.id} disappeared after create.`);
    }
    return this.toPublic(withLines);
  }

  /**
   * Migration 0041 — vendor-facing shipping estimate preview for the
   * v2 wizard. Returns the same numbers the backend will use at
   * submit time, so the vendor sees the exact wallet-cover
   * requirement before they commit.
   *
   * `allAssigned` = false surfaces which products still lack
   * shipping points so the wizard can render a clear "this SKU
   * isn't ready" error rather than a $0 estimate.
   *
   * Not used in the legacy flow — the wizard only calls this
   * endpoint when `/orders/fulfillment-config` reports v2Enabled=true.
   */
  async shippingEstimate(
    vendorId: string,
    input: { lines: OrderLineInput[] },
  ): Promise<{
    totalPoints: number;
    allAssigned: boolean;
    missingProductIds: string[];
    estimateMinCents: number;
    estimateMaxCents: number;
  }> {
    const resolved = await this.resolveLinesReadOnly(vendorId, input.lines);
    const productLines = resolved.map((r) => ({
      productId: r.product.id,
      quantity: r.input.quantity,
    }));
    const points = await this.shippingPoints.sumForLines(productLines);
    // Even when a line has unassigned points, resolve the range from
    // the (partial) sum so the wizard has SOMETHING to show — the
    // wallet-cover gate will refuse until allAssigned=true anyway.
    const range = await this.shippingPoints.resolveRange(points.totalPoints);
    return {
      totalPoints: points.totalPoints,
      allAssigned: points.allAssigned,
      missingProductIds: points.resolutions
        .filter((r) => !r.assigned)
        .map((r) => r.productId),
      estimateMinCents: range.dollarsMin,
      estimateMaxCents: range.dollarsMax,
    };
  }

  // ===========================================================================
  // READS
  // ===========================================================================

  async list(
    vendorId: string,
    input: ListOrdersInput,
  ): Promise<{ items: PublicOrder[]; nextCursor: string | null }> {
    const where: Prisma.OrderWhereInput = { vendorId };
    if (input.status) where.status = input.status;
    if (input.search) {
      // Numeric matches go against orderNumber so "#1625" or "1625" both
      // find order #1625. Strip a leading "#" if the user pasted the
      // rendered form; coerce only fully-numeric tokens so a search for
      // "shop-42" doesn't accidentally bind to the integer column.
      const trimmed = input.search.trim().replace(/^#/, "");
      const numericMatch = /^\d+$/.test(trimmed) ? Number(trimmed) : null;
      where.OR = [
        ...(numericMatch !== null ? [{ orderNumber: numericMatch }] : []),
        { externalReference: { contains: input.search, mode: "insensitive" } },
        { trackingNumber: { contains: input.search, mode: "insensitive" } },
        { recipientName: { contains: input.search, mode: "insensitive" } },
        { recipientEmail: { contains: input.search, mode: "insensitive" } },
      ];
    }

    const orders = await this.prisma.order.findMany({
      where,
      include: { lines: true, packagingOption: true } as Prisma.OrderInclude,
      take: input.limit + 1,
      orderBy: { createdAt: "desc" },
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    });

    let nextCursor: string | null = null;
    if (orders.length > input.limit) {
      const next = orders.pop();
      nextCursor = next?.id ?? null;
    }
    return { items: orders.map((o) => this.toPublic(o)), nextCursor };
  }

  async get(vendorId: string, id: string): Promise<PublicOrder> {
    const order = await this.prisma.order.findFirst({
      where: { id, vendorId },
      include: { lines: true, packagingOption: true } as Prisma.OrderInclude,
    });
    if (!order) throw new NotFoundException();
    return this.toPublic(order);
  }

  // ===========================================================================
  // CANCEL
  // ===========================================================================

  async cancel(
    vendorId: string,
    actorId: string,
    id: string,
    input: CancelOrderInput,
  ): Promise<PublicOrder> {
    // Pre-flight read for the 404 path. The authoritative status check happens
    // inside the transaction below with `SELECT ... FOR UPDATE` so that two
    // concurrent cancels cannot both succeed and double-refund.
    const exists = await this.prisma.order.findFirst({
      where: { id, vendorId },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException();

    const cancellable: OrderStatus[] = ["DRAFT", "SUBMITTED", "ALLOCATED"];

    const { before, updated } = await this.prisma.$transaction(async (tx) => {
      // Lock the order row for the duration of the transaction.
      const lockedRows = await tx.$queryRaw<Array<{ id: string; status: OrderStatus; total_charged_cents: number }>>(
        Prisma.sql`
          SELECT id, status, total_charged_cents
          FROM orders
          WHERE id = ${id}::uuid AND vendor_id = ${vendorId}::uuid
          FOR UPDATE
        `,
      );
      const locked = lockedRows[0];
      if (!locked) throw new NotFoundException();
      if (!cancellable.includes(locked.status)) {
        throw new ConflictException({
          message: `Order in status ${locked.status} cannot be cancelled. Contact support for a return.`,
          code: "order_not_cancellable",
        });
      }

      const before = await tx.order.findUniqueOrThrow({
        where: { id },
        include: { lines: true, packagingOption: true } as Prisma.OrderInclude,
      });

      // Release reservations on every line.
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
            vendorId,
            skuId: line.skuId,
            type: "RELEASE",
            deltaAvailable: line.quantity,
            deltaReserved: -line.quantity,
            referenceType: "order",
            referenceId: id,
            actorId,
            reason: `cancel: ${input.reason}`,
          },
        });
        await tx.orderLine.update({
          where: { id: line.id },
          data: { allocationStatus: "CANCELLED" },
        });
      }

      // Refund the wallet for the full charged amount, if anything was charged.
      if (before.totalChargedCents > 0) {
        await this.wallet.credit(
          {
            vendorId,
            amountCents: before.totalChargedCents,
            type: "REVERSAL",
            description: `Refund for cancelled order ${id.slice(0, 8)}`,
            referenceType: "order",
            referenceId: id,
            actorId,
          },
          tx as unknown as Parameters<typeof this.wallet.credit>[1],
        );
      }

      const o = await tx.order.update({
        where: { id },
        data: {
          status: "CANCELLED",
          cancelReason: input.reason,
          cancelNote: input.note ?? null,
          cancelledAt: new Date(),
        },
        include: { lines: true, packagingOption: true } as Prisma.OrderInclude,
      });

      await tx.orderEvent.create({
        data: {
          orderId: id,
          type: "order.cancelled",
          description: `Cancelled: ${input.reason}${input.note ? ` (${input.note})` : ""}`,
          source: "VENDOR",
          actorId,
        },
      });

      return { before, updated: o };
    });

    await this.audit.log({
      actorId,
      action: "order.cancelled",
      resourceType: "order",
      resourceId: id,
      beforeState: { status: before.status, totalChargedCents: before.totalChargedCents },
      afterState: { status: "CANCELLED", reason: input.reason },
    });

    return this.toPublic(updated);
  }

  // ===========================================================================
  // Internal helpers
  // ===========================================================================

  private async resolveLinesReadOnly(
    vendorId: string,
    lines: OrderLineInput[],
  ): Promise<ResolvedLine[]> {
    if (lines.length === 0) {
      throw new BadRequestException("Order must have at least one line.");
    }

    const skuIds = Array.from(new Set(lines.map((l) => l.skuId)));
    const skus = await this.prisma.sku.findMany({
      where: { id: { in: skuIds }, vendorId },
      include: { product: true },
    });

    if (skus.length !== skuIds.length) {
      const found = new Set(skus.map((s) => s.id));
      const missing = skuIds.filter((id) => !found.has(id));
      throw new NotFoundException(`SKU not found: ${missing.join(", ")}`);
    }

    const bySkuId = new Map(skus.map((s) => [s.id, s]));

    return lines.map((input) => {
      const sku = bySkuId.get(input.skuId)!;
      const product = sku.product;
      return {
        input,
        sku: {
          id: sku.id,
          vendor_id: sku.vendorId,
          product_id: sku.productId,
          variant: sku.variant,
          quantity_available: sku.quantityAvailable,
          quantity_reserved: sku.quantityReserved,
          status: sku.status,
        },
        product: {
          id: product.id,
          code: product.code,
          name: product.name,
          weightOz: product.weightOz,
          lengthIn: product.lengthIn,
          widthIn: product.widthIn,
          heightIn: product.heightIn,
          declaredValueCents: product.declaredValueCents,
          countryOfOrigin: product.countryOfOrigin,
        },
        declaredValueCents: product.declaredValueCents * input.quantity,
      };
    });
  }

  private async loadProducts(
    vendorId: string,
    lines: OrderLineInput[],
  ): Promise<{ bySkuId: Map<string, ResolvedLine> }> {
    const resolved = await this.resolveLinesReadOnly(vendorId, lines);
    return { bySkuId: new Map(resolved.map((r) => [r.sku.id, r])) };
  }

  /**
   * Lock the requested SKU rows in a single statement — `SELECT ... FOR UPDATE`
   * scoped to the vendor. The order of `skuIds` must be deterministic
   * (sorted) to prevent deadlocks across concurrent transactions.
   */
  private async lockSkus(tx: Tx, vendorId: string, skuIds: string[]): Promise<Map<string, SkuLockRow>> {
    if (skuIds.length === 0) return new Map();
    const rows = await tx.$queryRaw<SkuLockRow[]>(
      Prisma.sql`
        SELECT id, vendor_id, product_id, variant, quantity_available, quantity_reserved, status
        FROM skus
        WHERE id IN (${Prisma.join(skuIds)})
          AND vendor_id = ${vendorId}::uuid
        ORDER BY id
        FOR UPDATE
      `,
    );
    return new Map(rows.map((r) => [r.id, r]));
  }

  private toPublic(o: Order & { lines: OrderLine[] }): PublicOrder {
    return {
      id: o.id,
      orderNumber: o.orderNumber,
      externalReference: o.externalReference,
      status: o.status,
      recipient: {
        name: o.recipientName,
        phone: o.recipientPhone,
        email: o.recipientEmail,
        line1: o.shipAddressLine1,
        line2: o.shipAddressLine2,
        city: o.shipCity,
        state: o.shipState,
        postalCode: o.shipPostalCode,
        country: o.shipCountry,
      },
      carrier: o.carrier,
      carrierService: o.carrierService,
      trackingNumber: o.trackingNumber,
      labelUrl: o.labelUrl,
      itemsDeclaredValueCents: o.itemsDeclaredValueCents,
      shippingCostCents: o.shippingCostCents,
      shippingFeeCents: o.shippingFeeCents,
      fulfillmentFeeCents: o.fulfillmentFeeCents,
      insuranceFeeCents: o.insuranceFeeCents,
      totalChargedCents: o.totalChargedCents,
      reassessmentDeltaCents: o.reassessmentDeltaCents,
      cancelReason: o.cancelReason,
      cancelNote: o.cancelNote,
      submittedAt: o.submittedAt,
      allocatedAt: o.allocatedAt,
      shippedAt: o.shippedAt,
      deliveredAt: o.deliveredAt,
      cancelledAt: o.cancelledAt,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
      // Migration 0041 — cast because the local Prisma client may
      // not include workflow_version / estimated_shipping_*_cents
      // until `prisma generate` runs on the deploy machine. Runtime
      // Postgres returns the columns just fine. Legacy rows default
      // workflowVersion to 1 (DB default) and both estimate columns
      // to null (nullable, no default).
      workflowVersion:
        (o as unknown as { workflowVersion?: number }).workflowVersion ?? 1,
      estimatedShippingMinCents:
        (o as unknown as { estimatedShippingMinCents?: number | null })
          .estimatedShippingMinCents ?? null,
      estimatedShippingMaxCents:
        (o as unknown as { estimatedShippingMaxCents?: number | null })
          .estimatedShippingMaxCents ?? null,
      // Phase O — vendor-visible packaging summary. Reads through
      // `as unknown` casts because the sandbox Prisma client hasn't
      // been regenerated for the pack-step / packaging_option
      // relation yet; in CI the delegate exists. Runtime Postgres
      // returns null for orders that haven't been packed.
      ...(() => {
        const raw = o as unknown as {
          packedLengthIn?: unknown;
          packedWidthIn?: unknown;
          packedHeightIn?: unknown;
          packedWeightOz?: number | null;
          packedAt?: Date | null;
          parcelTemplate?: string | null;
          packagingOption?: { label: string } | null;
        };
        const label =
          raw.packagingOption?.label ??
          (raw.parcelTemplate
            ? this.carrierRegistry.getByTemplate(raw.parcelTemplate)?.label ??
              null
            : null);
        // Decimal → number via a defensive helper (Prisma may return
        // Decimal, string, or number depending on the code path).
        const num = (v: unknown): number | null => {
          if (v === null || v === undefined) return null;
          if (typeof v === "number") return v;
          if (typeof v === "string") return Number(v);
          if (typeof v === "object" && "toString" in v) {
            const n = Number((v as { toString(): string }).toString());
            return Number.isFinite(n) ? n : null;
          }
          return null;
        };
        return {
          packedLengthIn: num(raw.packedLengthIn),
          packedWidthIn: num(raw.packedWidthIn),
          packedHeightIn: num(raw.packedHeightIn),
          packedWeightOz: raw.packedWeightOz ?? null,
          packedAt: raw.packedAt ?? null,
          packagingLabel: label,
        };
      })(),
      lines: o.lines.map((l) => ({
        id: l.id,
        skuId: l.skuId,
        productCode: l.productCode,
        productName: l.productName,
        variant: l.variant,
        quantity: l.quantity,
        declaredValueCents: l.declaredValueCents,
        allocationStatus: l.allocationStatus,
      })),
    };
  }
}
