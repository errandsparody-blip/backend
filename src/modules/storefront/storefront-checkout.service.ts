/**
 * StorefrontCheckoutService — public buyer quote + checkout (Migration 0059).
 *
 * Flow:
 *   quote()       → validate items + stock, price the cart, return the ≤2
 *                   buyer shipping options (Standard/Express, no carrier).
 *   createOrder() → re-validate + soft-reserve stock, create the storefront
 *                   order (PENDING_PAYMENT), then open a split checkout on the
 *                   chosen processor. Payment is confirmed later by the webhook
 *                   (Layer 6); the label is bought at pack time (Layer 7), so
 *                   the shipping figure here is a quote.
 *
 * Money: buyer pays product − discount + shipping + fulfillment fee. The vendor
 * receives the product amount; USA Errands keeps shipping + fulfillment as the
 * processor application fee. USD throughout.
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "crypto";

import { loadConfig } from "../../common/config";
import {
  fulfillmentFeeForUnits,
  loadFeeSchedule,
  type FeeSchedule,
} from "../../common/fees";
import { PrismaService } from "../../common/prisma.service";
import type {
  CheckoutInput,
  CrossVendorCheckoutInput,
  CrossVendorQuoteInput,
  QuoteInput,
  StorefrontShipAddress,
} from "../../common/schemas/storefront-checkout.schema";
import { DiscountService } from "../discounts/discount.service";
import { ShippoService } from "../integrations/shippo/shippo.service";
import { assertEmailDeliverable } from "../shopper/email-deliverability.util";

import type { PaymentProcessor, ProcessorKey } from "../payments/payment-processor.interface";
import { PaymentProcessorRegistry } from "../payments/payment-processor.registry";
import { bucketRates, type BuyerShippingOption } from "./shipping-options";
import { StorefrontPublicService } from "./storefront-public.service";
import { StorefrontTaxService } from "./storefront-tax.service";

const unitsOf = (items: CheckoutItem[]): number => items.reduce((s, i) => s + i.qty, 0);

interface CheckoutItem {
  productId: string;
  code: string;
  variant: string;
  name: string;
  qty: number;
  unitRetailCents: number;
  unitDeclaredValueCents: number;
  weightOz: number;
  lengthIn: number | null;
  widthIn: number | null;
  heightIn: number | null;
  available: number;
}

/** One SKU slice of a reserved line — persisted so the webhook can build the
 *  fulfillment OrderLines against the exact SKUs that were reserved. */
export interface SkuAllocation {
  skuId: string;
  qty: number;
}

export interface CheckoutQuote {
  currency: string;
  productSubtotalCents: number;
  /** Flat platform fulfillment fee added at checkout — shown for an honest total. */
  fulfillmentFeeCents: number;
  /** Destination sales tax on the goods (0 unless configured for the ship state). */
  taxCents: number;
  shippingOptions: Array<Omit<BuyerShippingOption, "serviceToken">>;
  /**
   * The combined parcel the shipping estimate was priced on. Surfaced for
   * diagnostics: a very large weightOz here means a product's weight data is
   * wrong (carriers bill on max(actual, dimensional) weight, so weight drives
   * the price). Inspect this in the quote response when a rate looks too high.
   */
  parcel?: { weightOz: number; lengthIn: number; widthIn: number; heightIn: number };
}

@Injectable()
export class StorefrontCheckoutService {
  private readonly logger = new Logger(StorefrontCheckoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly shippo: ShippoService,
    private readonly registry: PaymentProcessorRegistry,
    private readonly publicStore: StorefrontPublicService,
    private readonly discounts: DiscountService,
    private readonly tax: StorefrontTaxService,
  ) {}

  // ---------------------------------------------------------------------------
  // Quote
  // ---------------------------------------------------------------------------

  async quote(slug: string, input: QuoteInput): Promise<CheckoutQuote> {
    const store = await this.publicStore.resolveBySlug(slug);
    const items = await this.loadItems(store.vendorId, input.items);
    const productSubtotalCents = items.reduce((s, i) => s + i.unitRetailCents * i.qty, 0);
    const options = await this.shippingOptions(items, productSubtotalCents, input.shipAddress);
    const taxCents = await this.tax.taxFor(input.shipAddress.state, productSubtotalCents);
    const schedule = await loadFeeSchedule(this.prisma);
    return {
      currency: "USD",
      productSubtotalCents,
      fulfillmentFeeCents: fulfillmentFeeForUnits(unitsOf(items), schedule),
      taxCents,
      // Never expose the internal service token to the buyer.
      shippingOptions: options.map(({ serviceToken: _t, ...rest }) => rest),
      parcel: this.buildParcel(items),
    };
  }

  // ---------------------------------------------------------------------------
  // Create order + open payment
  // ---------------------------------------------------------------------------

  async createOrder(
    slug: string,
    input: CheckoutInput,
  ): Promise<{ reference: string; checkoutUrl: string }> {
    const store = await this.publicStore.resolveBySlug(slug);

    // Email is mandatory + must be genuinely deliverable (order updates go here).
    await assertEmailDeliverable(input.buyerEmail, this.logger);

    const items = await this.loadItems(store.vendorId, input.items);
    const productSubtotalCents = items.reduce((s, i) => s + i.unitRetailCents * i.qty, 0);

    // Re-price shipping server-side; never trust a client-supplied amount.
    const options = await this.shippingOptions(items, productSubtotalCents, input.shipAddress);
    const chosen = options.find((o) => o.speed === input.shippingSpeed);
    if (!chosen) {
      throw new BadRequestException({
        message: "That delivery speed isn't available for this address.",
        code: "shipping_speed_unavailable",
      });
    }

    const schedule = await loadFeeSchedule(this.prisma);
    return this.placeOrder(store, items, {
      buyerEmail: input.buyerEmail,
      buyerName: input.buyerName,
      buyerPhone: input.buyerPhone,
      shipAddress: input.shipAddress,
      processor: input.processor,
      discountCode: input.discountCode,
      shippingSpeed: input.shippingSpeed,
      // Single-store: this order is the whole shipment, so it carries the full
      // shipping; fulfillment scales with this order's unit count.
      shippingCents: chosen.costCents,
      serviceToken: chosen.serviceToken,
      fulfillmentFeeCents: fulfillmentFeeForUnits(unitsOf(items), schedule),
    });
  }

  /**
   * Persist one storefront order + open its split checkout, from an already
   * validated item list and a resolved shipping decision. Shared by the
   * single-store path and each leg of a cross-vendor cart.
   *
   * Money invariant: the vendor always receives only the (discounted) product
   * amount; USA Errands keeps shipping + fulfillment + tax via the processor
   * application fee. In a cross-vendor cart the shipping + fulfillment are placed
   * on ONE leg only (the rest pass shippingCents/fulfillmentFeeCents = 0), so the
   * buyer pays a single delivery charge for the whole cart — one shipment, one
   * shipping fee, exactly as the storefront spec requires.
   */
  private async placeOrder(
    store: { vendorId: string; slug: string },
    items: CheckoutItem[],
    params: {
      buyerEmail: string;
      buyerName?: string;
      buyerPhone?: string;
      shipAddress: StorefrontShipAddress;
      processor: ProcessorKey;
      discountCode?: string;
      shippingSpeed: string;
      shippingCents: number;
      serviceToken: string | null;
      fulfillmentFeeCents: number;
      /** Links the sub-orders of one cross-vendor cart; null for single-store. */
      cartGroupId?: string | null;
    },
  ): Promise<{ reference: string; checkoutUrl: string }> {
    // Collect-then-payout: the buyer pays the PLATFORM (USA Errands holds the
    // money), and the vendor's share is released later (after their return
    // window, or a 24h buffer if they take no returns). This keeps refunds
    // instant + clawback-free — the business never pays a vendor money it might
    // have to refund. The vendor is credited immediately in their earnings
    // ledger (payout_status HELD + payout_release_at), just not withdrawable yet.
    const collector = this.platformCollector();
    const persisted = await this.persistSubOrder(store, items, params, {
      collectorProcessor: collector.key,
    });

    // Open ONE platform charge. Opened AFTER the persist tx commits (a network
    // call must not hold a DB transaction); on failure we compensate by
    // releasing the reservation.
    let checkoutUrl: string;
    let paymentRef: string;
    try {
      const web = loadConfig().WEB_PUBLIC_URL;
      const res = await collector.processor.createPlatformCheckout({
        reference: persisted.reference,
        amountCents: persisted.totalCents,
        currency: "USD",
        buyerEmail: params.buyerEmail,
        successUrl: `${web}/store/${store.slug}/order/${persisted.reference}?paid=1`,
        cancelUrl: `${web}/store/${store.slug}/checkout?cancelled=1`,
        metadata: { storefrontOrderId: persisted.orderId, vendorId: store.vendorId },
      });
      checkoutUrl = res.checkoutUrl;
      paymentRef = res.paymentRef;
    } catch (err) {
      await this.compensate(persisted.orderId, items);
      this.logger.error(
        { err: `${err}`, reference: persisted.reference },
        "storefront.checkout.payment_open_failed",
      );
      throw new BadRequestException({
        message: "We couldn't start checkout. Please try again.",
        code: "storefront_checkout_failed",
      });
    }

    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE storefront_orders
      SET payment_ref = ${paymentRef}, payment_intent_id = ${paymentRef}, updated_at = now()
      WHERE id = ${persisted.orderId}::uuid
    `);

    return { reference: persisted.reference, checkoutUrl };
  }

  /**
   * Reserve stock + insert ONE storefront sub-order (PENDING_PAYMENT). Shared by
   * the direct-charge path (placeOrder) and the unified collect-then-payout path.
   * Does NOT open any payment — the caller opens either a per-vendor charge or a
   * single platform charge. Validates the vendor has an ACTIVE payout account up
   * front, so an unpayable vendor is rejected before any charge is opened.
   * `collectorProcessor` set ⇒ this is a leg of a unified cart (payout pending);
   * null ⇒ direct charge (no vendor transfer needed).
   */
  private async persistSubOrder(
    store: { vendorId: string; slug: string },
    items: CheckoutItem[],
    params: {
      buyerEmail: string;
      buyerName?: string;
      buyerPhone?: string;
      shipAddress: StorefrontShipAddress;
      processor: ProcessorKey;
      discountCode?: string;
      shippingSpeed: string;
      shippingCents: number;
      serviceToken: string | null;
      fulfillmentFeeCents: number;
      cartGroupId?: string | null;
    },
    opts: { collectorProcessor: ProcessorKey | null },
  ): Promise<{
    orderId: string;
    reference: string;
    totalCents: number;
    platformFeeCents: number;
    vendorExternalAccountId: string;
  }> {
    const productSubtotalCents = items.reduce((s, i) => s + i.unitRetailCents * i.qty, 0);

    let discountCents = 0;
    let discountCodeId: string | null = null;
    if (params.discountCode) {
      const disc = await this.discounts.quoteForCheckout(
        store.vendorId,
        params.discountCode,
        productSubtotalCents,
      );
      discountCents = disc.discountCents;
      discountCodeId = disc.id;
    }
    const shippingCents = params.shippingCents;
    const taxCents = await this.tax.taxFor(
      params.shipAddress.state,
      Math.max(0, productSubtotalCents - discountCents),
    );
    // Money model: the buyer pays product + delivery (+ tax) only — NOT
    // fulfillment. The platform keeps delivery + tax; the vendor receives their
    // full discounted product amount (= totalCents − platformFeeCents). The
    // fulfillment fee is charged to the VENDOR's wallet at fulfillment time
    // (the same pattern as a normal order), not added here.
    const platformFeeCents = shippingCents + taxCents;
    const totalCents =
      productSubtotalCents - discountCents + shippingCents + taxCents;

    // The vendor must have an ACTIVE payout account (direct charge destination,
    // or the transfer target under unified payout). Reject up front otherwise.
    const payout = await this.activePayout(store.vendorId, params.processor);

    const payoutStatus = opts.collectorProcessor ? "PENDING" : "NONE";

    const { orderId, reference } = await this.prisma.$transaction(async (tx) => {
      const reserved = await this.reserveStock(tx, items);
      const allocByProduct = new Map(reserved.map((r) => [r.productId, r.allocations]));
      const refRow = await tx.$queryRaw<Array<{ n: bigint }>>(
        Prisma.sql`SELECT nextval('storefront_order_ref_seq') AS n`,
      );
      const reference = `SF-${String(Number(refRow[0]!.n)).padStart(6, "0")}`;
      const itemsJson = JSON.stringify(
        items.map((i) => ({
          productId: i.productId,
          code: i.code,
          variant: i.variant,
          name: i.name,
          qty: i.qty,
          unitRetailCents: i.unitRetailCents,
          unitDeclaredValueCents: i.unitDeclaredValueCents,
          allocations: allocByProduct.get(i.productId) ?? [],
        })),
      );
      const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        INSERT INTO storefront_orders
          (reference, vendor_id, buyer_email, buyer_name, buyer_phone, ship_address,
           items, product_subtotal_cents, discount_code, discount_cents, shipping_cents,
           shipping_speed, shipping_service_token, platform_fee_cents, tax_cents,
           total_cents, currency, processor, cart_group_id, collector_processor,
           payout_status, status, created_at, updated_at)
        VALUES
          (${reference}, ${store.vendorId}::uuid, ${params.buyerEmail}, ${params.buyerName ?? null},
           ${params.buyerPhone ?? null}, ${JSON.stringify(params.shipAddress)}::jsonb,
           ${itemsJson}::jsonb, ${productSubtotalCents}, ${params.discountCode ?? null},
           ${discountCents}, ${shippingCents}, ${params.shippingSpeed}, ${params.serviceToken},
           ${platformFeeCents}, ${taxCents}, ${totalCents}, 'USD', ${params.processor},
           ${params.cartGroupId ?? null}::uuid, ${opts.collectorProcessor},
           ${payoutStatus}, 'PENDING_PAYMENT', now(), now())
        RETURNING id
      `);
      if (discountCodeId) await this.discounts.redeem(tx, discountCodeId);
      return { orderId: rows[0]!.id, reference };
    });

    return {
      orderId,
      reference,
      totalCents,
      platformFeeCents,
      vendorExternalAccountId: payout.externalAccountId,
    };
  }

  // ---------------------------------------------------------------------------
  // Cross-vendor checkout (Phase 2)
  // ---------------------------------------------------------------------------

  /**
   * Quote a cross-vendor cart as ONE consolidated shipment. All items across
   * every vendor are combined into a single Shippo estimate (same warehouse →
   * same address = one delivery), so the buyer sees a single Standard/Express
   * shipping charge for the whole cart — not one per store. Product subtotal and
   * tax are summed across vendors; the fulfillment fee is charged once.
   */
  async quoteCrossVendor(input: CrossVendorQuoteInput): Promise<CheckoutQuote> {
    const schedule = await loadFeeSchedule(this.prisma);
    const allItems: CheckoutItem[] = [];
    let productSubtotalCents = 0;
    let taxCents = 0;
    let fulfillmentFeeCents = 0;
    for (const group of input.groups) {
      const store = await this.publicStore.resolveBySlug(group.slug);
      const items = await this.loadItems(store.vendorId, group.items);
      const groupSubtotal = items.reduce((s, i) => s + i.unitRetailCents * i.qty, 0);
      productSubtotalCents += groupSubtotal;
      // Tax is destination-based and charged per sub-order on that vendor's
      // goods, so the cart tax is the sum of per-vendor tax (kept in step with
      // what checkout will actually charge).
      taxCents += await this.tax.taxFor(input.shipAddress.state, groupSubtotal);
      // Fulfillment is per vendor and scales with that vendor's unit count.
      fulfillmentFeeCents += fulfillmentFeeForUnits(unitsOf(items), schedule);
      allItems.push(...items);
    }
    // One shipping estimate for the combined parcel.
    const options = await this.shippingOptions(allItems, productSubtotalCents, input.shipAddress);
    return {
      currency: "USD",
      productSubtotalCents,
      // Shipping is ONE delivery for the whole cart; fulfillment is summed per
      // vendor (each store's goods are picked + packed separately).
      fulfillmentFeeCents,
      taxCents,
      shippingOptions: options.map(({ serviceToken: _t, ...rest }) => rest),
      parcel: this.buildParcel(allItems),
    };
  }

  /**
   * Place a cross-vendor cart. Shared buyer + address + ONE delivery speed for
   * the whole cart. Shipping is quoted once across all items and charged on a
   * single leg (the first vendor), with a single fulfillment fee; the remaining
   * legs carry product + tax only. So the buyer pays one delivery charge for the
   * whole cart, while each vendor still receives only their own product amount.
   *
   * Legs are placed independently: a failure in one is reported without rolling
   * back the others (each successful leg already reserved stock + opened a
   * payment). Note: the shipping/fulfillment leg is placed first, so if it is the
   * one that fails, the buyer is told and no shipping is silently dropped.
   */
  async createCrossVendorOrder(input: CrossVendorCheckoutInput): Promise<{
    results: Array<{ slug: string; reference: string; checkoutUrl: string }>;
    errors: Array<{ slug: string; message: string; code?: string }>;
  }> {
    // Email is mandatory + must be genuinely deliverable (order updates go here).
    await assertEmailDeliverable(input.buyerEmail, this.logger);

    // Resolve + validate every leg first, and gather all items so shipping can be
    // quoted once for the whole cart.
    const legs: Array<{
      slug: string;
      store: { vendorId: string; slug: string };
      items: CheckoutItem[];
      processor: ProcessorKey;
      discountCode?: string;
    }> = [];
    const allItems: CheckoutItem[] = [];
    let productSubtotalCents = 0;
    for (const group of input.groups) {
      const store = await this.publicStore.resolveBySlug(group.slug);
      const items = await this.loadItems(store.vendorId, group.items);
      productSubtotalCents += items.reduce((s, i) => s + i.unitRetailCents * i.qty, 0);
      legs.push({
        slug: group.slug,
        store: { vendorId: store.vendorId, slug: store.slug },
        items,
        processor: group.processor,
        discountCode: group.discountCode,
      });
      allItems.push(...items);
    }

    // One consolidated shipping estimate for the combined parcel, at the cart's
    // chosen speed. If it's unavailable the whole cart stops — we never quietly
    // ship without charging.
    const options = await this.shippingOptions(allItems, productSubtotalCents, input.shipAddress);
    const chosen = options.find((o) => o.speed === input.shippingSpeed);
    if (!chosen) {
      throw new BadRequestException({
        message: "That delivery speed isn't available for this address.",
        code: "shipping_speed_unavailable",
      });
    }

    const results: Array<{ slug: string; reference: string; checkoutUrl: string }> = [];
    const errors: Array<{ slug: string; message: string; code?: string }> = [];

    // Fee schedule for the per-vendor fulfillment fee (same model as normal
    // orders: base + per-additional-unit, capped).
    const schedule = await loadFeeSchedule(this.prisma);

    // One id links every sub-order of this cart so the warehouse can see they
    // ship together (and, next step, pack them into one physical shipment).
    const cartGroupId = legs.length > 1 ? randomUUID() : null;

    // A MULTI-vendor cart is ONE platform charge; the platform holds the money
    // and releases each vendor's share after their return window (collect-then-
    // payout). Single-vendor carts go through placeOrder below, which now also
    // collects to the platform — so the platform holds the money for EVERY
    // storefront order, keeping refunds instant + clawback-free.
    if (legs.length > 1 && cartGroupId) {
      return this.openUnifiedCart(legs, input, chosen, schedule, cartGroupId);
    }

    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i]!;
      // Shipping is ONE delivery for the whole cart, so only the first leg
      // carries the (single) shipping charge; the rest carry no shipping. But
      // the fulfillment fee is PER VENDOR (each vendor's goods are picked +
      // packed separately), so every leg carries its own fulfillment fee.
      const carriesShipping = i === 0;
      try {
        const res = await this.placeOrder(leg.store, leg.items, {
          buyerEmail: input.buyerEmail,
          buyerName: input.buyerName,
          buyerPhone: input.buyerPhone,
          shipAddress: input.shipAddress,
          processor: leg.processor,
          discountCode: leg.discountCode,
          shippingSpeed: input.shippingSpeed,
          shippingCents: carriesShipping ? chosen.costCents : 0,
          serviceToken: carriesShipping ? chosen.serviceToken : null,
          fulfillmentFeeCents: fulfillmentFeeForUnits(unitsOf(leg.items), schedule),
          cartGroupId,
        });
        results.push({ slug: leg.slug, reference: res.reference, checkoutUrl: res.checkoutUrl });
      } catch (err) {
        const e = err as { message?: string; response?: { message?: string; code?: string } };
        errors.push({
          slug: leg.slug,
          message: e.response?.message ?? e.message ?? "Checkout failed for this store.",
          code: e.response?.code,
        });
      }
    }
    return { results, errors };
  }

  /**
   * Pick the platform's collection rail for a unified cart — the account that
   * takes the single buyer charge. Prefers Flutterwave (this marketplace's
   * primary rail — local cards, mobile money, etc.), falling back to Stripe;
   * both must be configured AND support platform collection. Throws a clear 400
   * when neither is available so the cart fails loudly rather than mis-routing.
   */
  private platformCollector(): { key: ProcessorKey; processor: PaymentProcessor } {
    for (const key of ["FLUTTERWAVE", "STRIPE"] as ProcessorKey[]) {
      let proc: PaymentProcessor;
      try {
        proc = this.registry.get(key);
      } catch {
        continue; // not registered
      }
      if (proc.isConfigured() && proc.supportsPlatformCollection()) {
        return { key, processor: proc };
      }
    }
    throw new BadRequestException({
      message: "One-payment checkout isn't available right now.",
      code: "no_platform_collector",
    });
  }

  /**
   * Unified cart: persist every vendor sub-order (PENDING_PAYMENT, no per-vendor
   * charge), then open ONE platform charge for the whole cart. When it confirms,
   * the webhook marks all sub-orders paid and pays each vendor their share
   * (StorefrontOrderService.distributeCartPayment). If persisting any leg or
   * opening the charge fails, every already-persisted leg is compensated
   * (reservation released, order cancelled) so no stock is stranded and the buyer
   * is never charged for a partial cart.
   */
  private async openUnifiedCart(
    legs: Array<{
      slug: string;
      store: { vendorId: string; slug: string };
      items: CheckoutItem[];
      processor: ProcessorKey;
      discountCode?: string;
    }>,
    input: CrossVendorCheckoutInput,
    chosen: BuyerShippingOption,
    schedule: FeeSchedule,
    cartGroupId: string,
  ): Promise<{
    results: Array<{ slug: string; reference: string; checkoutUrl: string }>;
    errors: Array<{ slug: string; message: string; code?: string }>;
  }> {
    const collector = this.platformCollector();

    const persisted: Array<{ orderId: string; totalCents: number; items: CheckoutItem[] }> = [];
    try {
      for (let i = 0; i < legs.length; i++) {
        const leg = legs[i]!;
        const carriesShipping = i === 0; // shipping charged once for the cart
        const p = await this.persistSubOrder(
          leg.store,
          leg.items,
          {
            buyerEmail: input.buyerEmail,
            buyerName: input.buyerName,
            buyerPhone: input.buyerPhone,
            shipAddress: input.shipAddress,
            processor: leg.processor,
            discountCode: leg.discountCode,
            shippingSpeed: input.shippingSpeed,
            shippingCents: carriesShipping ? chosen.costCents : 0,
            serviceToken: carriesShipping ? chosen.serviceToken : null,
            fulfillmentFeeCents: fulfillmentFeeForUnits(unitsOf(leg.items), schedule),
            cartGroupId,
          },
          { collectorProcessor: collector.key },
        );
        persisted.push({ orderId: p.orderId, totalCents: p.totalCents, items: leg.items });
      }
    } catch (err) {
      for (const p of persisted) await this.compensate(p.orderId, p.items);
      const e = err as { message?: string; response?: { message?: string; code?: string } };
      return {
        results: [],
        errors: [
          {
            slug: "cart",
            message: e.response?.message ?? e.message ?? "We couldn't start checkout.",
            code: e.response?.code ?? "storefront_checkout_failed",
          },
        ],
      };
    }

    const cartTotalCents = persisted.reduce((s, p) => s + p.totalCents, 0);
    let checkoutUrl: string;
    let paymentRef: string;
    try {
      const web = loadConfig().WEB_PUBLIC_URL;
      const res = await collector.processor.createPlatformCheckout({
        reference: `CART-${cartGroupId}`,
        amountCents: cartTotalCents,
        currency: "USD",
        buyerEmail: input.buyerEmail,
        successUrl: `${web}/marketplace/checkout?paid=1`,
        cancelUrl: `${web}/marketplace/checkout?cancelled=1`,
        metadata: { cartGroupId },
      });
      checkoutUrl = res.checkoutUrl;
      paymentRef = res.paymentRef;
    } catch (err) {
      for (const p of persisted) await this.compensate(p.orderId, p.items);
      this.logger.error({ err: `${err}`, cartGroupId }, "storefront.checkout.platform_open_failed");
      return {
        results: [],
        errors: [
          {
            slug: "cart",
            message: "We couldn't start checkout. Please try again.",
            code: "storefront_checkout_failed",
          },
        ],
      };
    }

    // Stamp the single platform payment ref on every sub-order so the webhook +
    // refunds resolve the whole cart from one charge.
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE storefront_orders
      SET payment_ref = ${paymentRef}, payment_intent_id = ${paymentRef}, updated_at = now()
      WHERE cart_group_id = ${cartGroupId}::uuid
    `);

    // ONE result → the web shows a single "Complete payment" button.
    return {
      results: [{ slug: "cart", reference: `CART-${cartGroupId}`, checkoutUrl }],
      errors: [],
    };
  }

  // ---------------------------------------------------------------------------
  // Abandoned-cart sweep
  // ---------------------------------------------------------------------------

  /**
   * Release stock held by orders that were created but never paid. Checkout
   * reserves inventory the moment the order row is written; if the buyer never
   * completes payment, that stock would sit reserved forever. This frees any
   * PENDING_PAYMENT order older than `maxAgeMinutes` (available += qty,
   * reserved −= qty) and cancels it. Idempotent + guarded: a late webhook can
   * still only flip PENDING_PAYMENT → PAID, and this only touches rows still
   * PENDING_PAYMENT. Returns how many orders were released.
   */
  async sweepAbandonedReservations(maxAgeMinutes = 60): Promise<number> {
    const stale = await this.prisma.$queryRaw<
      Array<{ id: string; items: Array<{ allocations?: SkuAllocation[] }> }>
    >(Prisma.sql`
      SELECT id, items FROM storefront_orders
      WHERE status = 'PENDING_PAYMENT'
        AND created_at < now() - (${maxAgeMinutes} * interval '1 minute')
      ORDER BY created_at ASC
      LIMIT 200
    `);

    let released = 0;
    for (const order of stale) {
      const ok = await this.prisma.$transaction(async (tx) => {
        // Only cancel if still unpaid — the row lock + guard means a webhook
        // that just marked it PAID wins the race.
        const upd = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          UPDATE storefront_orders SET status = 'CANCELLED', updated_at = now()
          WHERE id = ${order.id}::uuid AND status = 'PENDING_PAYMENT'
          RETURNING id
        `);
        if (upd.length === 0) return false;
        for (const item of order.items ?? []) {
          for (const a of item.allocations ?? []) {
            await tx.$executeRaw(Prisma.sql`
              UPDATE skus
              SET quantity_reserved = GREATEST(0, quantity_reserved - ${a.qty}),
                  quantity_available = quantity_available + ${a.qty},
                  updated_at = now()
              WHERE id = ${a.skuId}
            `);
          }
        }
        return true;
      });
      if (ok) released++;
    }
    if (released > 0) {
      this.logger.log({ released }, "storefront.abandoned_cart.swept");
    }
    return released;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Validate the cart against the live, listed, in-stock catalog. */
  private async loadItems(
    vendorId: string,
    reqItems: Array<{ productId: string; quantity: number }>,
  ): Promise<CheckoutItem[]> {
    const out: CheckoutItem[] = [];
    for (const it of reqItems) {
      const rows = await this.prisma.$queryRaw<
        Array<{
          id: string;
          code: string;
          variant: string;
          name: string;
          retail_price_cents: number | null;
          declared_value_cents: number;
          weight_oz: number;
          length_in: number | null;
          width_in: number | null;
          height_in: number | null;
          available: number | bigint;
        }>
      >(Prisma.sql`
        SELECT p.id, p.code, p.variant, p.name, p.retail_price_cents, p.declared_value_cents,
               p.weight_oz, p.length_in, p.width_in, p.height_in,
               COALESCE(s.avail, 0) AS available
        FROM products p
        LEFT JOIN (
          SELECT product_id, SUM(quantity_available - quantity_reserved) AS avail
          FROM skus WHERE status = 'ACTIVE' GROUP BY product_id
        ) s ON s.product_id = p.id
        WHERE p.id = ${it.productId}::uuid AND p.vendor_id = ${vendorId}::uuid
          AND p.listed = true AND p.status = 'ACTIVE'
        LIMIT 1
      `);
      const r = rows[0];
      if (!r || r.retail_price_cents == null) {
        throw new BadRequestException({
          message: "One of the items is no longer available.",
          code: "product_unavailable",
        });
      }
      const available = Number(r.available);
      if (it.quantity > available) {
        throw new ConflictException({
          message: `Only ${available} of "${r.name}" left in stock.`,
          code: "insufficient_stock",
        });
      }
      out.push({
        productId: r.id,
        code: r.code,
        variant: r.variant,
        name: r.name,
        qty: it.quantity,
        unitRetailCents: r.retail_price_cents,
        unitDeclaredValueCents: r.declared_value_cents,
        weightOz: r.weight_oz,
        lengthIn: r.length_in,
        widthIn: r.width_in,
        heightIn: r.height_in,
        available,
      });
    }
    if (out.length === 0) {
      throw new BadRequestException({ message: "Your cart is empty.", code: "empty_cart" });
    }
    return out;
  }

  /**
   * Estimate ONE combined parcel from the cart. Weight is summed across items;
   * the box footprint is the largest item's length × width and height grows only
   * by the leftover volume (a realistic "packed box", not a tower of stacked
   * heights). Dimensions are clamped to a carrier-sane max so one bad product
   * dimension can't blow up the quote. NOTE: this is only an estimate — the real
   * box is measured at pack time. If a rate looks absurd, inspect this parcel:
   * a huge weightOz means a product's weight data is wrong (carriers bill on
   * max(actual weight, dimensional weight), so weight dominates the price).
   */
  private buildParcel(items: CheckoutItem[]): {
    weightOz: number;
    lengthIn: number;
    widthIn: number;
    heightIn: number;
  } {
    const MAX_DIM_IN = 108; // common carrier max length/girth guardrail
    const weightOz = items.reduce((s, i) => s + i.weightOz * i.qty, 0) || 1;
    const maxLen = Math.max(1, ...items.map((i) => i.lengthIn ?? 0));
    const maxWid = Math.max(1, ...items.map((i) => i.widthIn ?? 0));
    const totalVolumeIn3 = items.reduce(
      (s, i) => s + (i.lengthIn ?? 0) * (i.widthIn ?? 0) * (i.heightIn ?? 0) * i.qty,
      0,
    );
    const lengthIn = Math.min(MAX_DIM_IN, Math.ceil(maxLen));
    const widthIn = Math.min(MAX_DIM_IN, Math.ceil(maxWid));
    const footprintIn2 = Math.max(1, lengthIn * widthIn);
    const heightIn = Math.min(MAX_DIM_IN, Math.max(1, Math.ceil(totalVolumeIn3 / footprintIn2)));
    return { weightOz: Math.ceil(weightOz), lengthIn, widthIn, heightIn };
  }

  /** Live Shippo estimate, collapsed to Standard/Express buyer options. */
  private async shippingOptions(
    items: CheckoutItem[],
    declaredValueCents: number,
    addr: StorefrontShipAddress,
  ): Promise<BuyerShippingOption[]> {
    const cfg = loadConfig();
    const parcel = this.buildParcel(items);

    const res = await this.shippo.getRates({
      fromAddress: {
        state: cfg.WAREHOUSE_FROM_STATE,
        postalCode: cfg.WAREHOUSE_FROM_ZIP,
        country: "US",
      },
      toAddress: {
        recipientName: addr.recipientName,
        line1: addr.line1,
        line2: addr.line2,
        city: addr.city,
        state: addr.state,
        postalCode: addr.postalCode,
        country: addr.country,
        phone: addr.phone,
      },
      parcel,
      declaredValueCents,
      insuranceRequested: false,
    });
    const options = bucketRates(res.rates);
    if (options.length === 0) {
      throw new BadRequestException({
        message: "We couldn't find a delivery option for this address.",
        code: "no_shipping_options",
      });
    }
    return options;
  }

  private async activePayout(
    vendorId: string,
    processor: ProcessorKey,
  ): Promise<{ externalAccountId: string }> {
    const rows = await this.prisma.$queryRaw<Array<{ external_account_id: string | null }>>(
      Prisma.sql`
        SELECT external_account_id FROM vendor_payout_accounts
        WHERE vendor_id = ${vendorId}::uuid AND processor = ${processor} AND status = 'ACTIVE'
        LIMIT 1
      `,
    );
    const ext = rows[0]?.external_account_id;
    if (!ext) {
      throw new BadRequestException({
        message: "This store can't accept that payment method right now.",
        code: "processor_unavailable",
      });
    }
    return { externalAccountId: ext };
  }

  /**
   * Greedily reserve `qty` per product across its active SKUs (row-locked),
   * matching the fulfillment pipeline's RESERVE semantics (available −qty,
   * reserved +qty). Returns the exact per-SKU allocation so the webhook can
   * build the fulfillment OrderLines against the same SKUs.
   */
  private async reserveStock(
    tx: Prisma.TransactionClient,
    items: CheckoutItem[],
  ): Promise<Array<{ productId: string; allocations: SkuAllocation[] }>> {
    const result: Array<{ productId: string; allocations: SkuAllocation[] }> = [];
    for (const item of items) {
      let remaining = item.qty;
      const allocations: SkuAllocation[] = [];
      const skus = await tx.$queryRaw<Array<{ id: string; free: number }>>(Prisma.sql`
        SELECT id, (quantity_available - quantity_reserved) AS free
        FROM skus
        WHERE product_id = ${item.productId}::uuid AND status = 'ACTIVE'
          AND (quantity_available - quantity_reserved) > 0
        ORDER BY free DESC
        FOR UPDATE
      `);
      for (const s of skus) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, Number(s.free));
        await tx.$executeRaw(Prisma.sql`
          UPDATE skus
          SET quantity_available = quantity_available - ${take},
              quantity_reserved = quantity_reserved + ${take},
              updated_at = now()
          WHERE id = ${s.id}
        `);
        allocations.push({ skuId: s.id, qty: take });
        remaining -= take;
      }
      if (remaining > 0) {
        // Lost a race with another buyer between validation and reservation.
        throw new ConflictException({
          message: `"${item.name}" just sold out.`,
          code: "insufficient_stock",
        });
      }
      result.push({ productId: item.productId, allocations });
    }
    return result;
  }

  /** Release a reservation + cancel the order when opening payment fails. */
  private async compensate(orderId: string, items: CheckoutItem[]): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        for (const item of items) {
          let remaining = item.qty;
          const skus = await tx.$queryRaw<Array<{ id: string; reserved: number }>>(Prisma.sql`
            SELECT id, quantity_reserved AS reserved FROM skus
            WHERE product_id = ${item.productId}::uuid AND status = 'ACTIVE' AND quantity_reserved > 0
            ORDER BY quantity_reserved DESC
            FOR UPDATE
          `);
          for (const s of skus) {
            if (remaining <= 0) break;
            const give = Math.min(remaining, Number(s.reserved));
            await tx.$executeRaw(Prisma.sql`
              UPDATE skus
              SET quantity_reserved = quantity_reserved - ${give},
                  quantity_available = quantity_available + ${give},
                  updated_at = now()
              WHERE id = ${s.id}
            `);
            remaining -= give;
          }
        }
        await tx.$executeRaw(Prisma.sql`
          UPDATE storefront_orders SET status = 'CANCELLED', updated_at = now()
          WHERE id = ${orderId}::uuid
        `);
      });
    } catch (err) {
      this.logger.error({ err: `${err}`, orderId }, "storefront.checkout.compensate_failed");
    }
  }
}
