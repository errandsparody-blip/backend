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

import { loadConfig } from "../../common/config";
import { PrismaService } from "../../common/prisma.service";
import type {
  CheckoutInput,
  CrossVendorCheckoutInput,
  QuoteInput,
  StorefrontShipAddress,
} from "../../common/schemas/storefront-checkout.schema";
import { DiscountService } from "../discounts/discount.service";
import { ShippoService } from "../integrations/shippo/shippo.service";
import { assertEmailDeliverable } from "../shopper/email-deliverability.util";

import type { ProcessorKey } from "../payments/payment-processor.interface";
import { PaymentProcessorRegistry } from "../payments/payment-processor.registry";
import { bucketRates, type BuyerShippingOption } from "./shipping-options";
import { StorefrontPublicService } from "./storefront-public.service";
import { StorefrontTaxService } from "./storefront-tax.service";

/** Flat platform fulfillment fee added on top of shipping (config later). */
export const STOREFRONT_FULFILLMENT_FEE_CENTS = 300;

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
    return {
      currency: "USD",
      productSubtotalCents,
      fulfillmentFeeCents: STOREFRONT_FULFILLMENT_FEE_CENTS,
      taxCents,
      // Never expose the internal service token to the buyer.
      shippingOptions: options.map(({ serviceToken: _t, ...rest }) => rest),
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

    // Apply a discount code if supplied (vendor-owned or a marketplace code
    // that targets this vendor). A bad code stops the order so the buyer knows.
    let discountCents = 0;
    let discountCodeId: string | null = null;
    if (input.discountCode) {
      const disc = await this.discounts.quoteForCheckout(
        store.vendorId,
        input.discountCode,
        productSubtotalCents,
      );
      discountCents = disc.discountCents;
      discountCodeId = disc.id;
    }
    const shippingCents = chosen.costCents;
    const fulfillmentFeeCents = STOREFRONT_FULFILLMENT_FEE_CENTS;
    // Destination sales tax on the (discounted) goods — $0 unless configured.
    const taxCents = await this.tax.taxFor(
      input.shipAddress.state,
      Math.max(0, productSubtotalCents - discountCents),
    );
    // The platform keeps shipping + fulfillment + tax (USA Errands remits the
    // tax as facilitator); the vendor still receives the discounted goods only.
    const platformFeeCents = shippingCents + fulfillmentFeeCents + taxCents;
    const totalCents =
      productSubtotalCents - discountCents + shippingCents + fulfillmentFeeCents + taxCents;

    // The buyer pays through the vendor's connected account for the chosen rail.
    const payout = await this.activePayout(store.vendorId, input.processor);

    // Reserve stock + persist the order atomically. Payment is opened AFTER the
    // tx commits (network call must not hold a DB transaction); on failure we
    // compensate by releasing the reservation and cancelling the order.
    const { orderId, reference } = await this.prisma.$transaction(async (tx) => {
      const reserved = await this.reserveStock(tx, items);
      const allocByProduct = new Map(reserved.map((r) => [r.productId, r.allocations]));
      const refRow = await tx.$queryRaw<Array<{ n: bigint }>>(
        Prisma.sql`SELECT nextval('storefront_order_ref_seq') AS n`,
      );
      const reference = `SF-${String(Number(refRow[0]!.n)).padStart(6, "0")}`;
      // Persist the per-SKU allocation + line snapshot the webhook needs to
      // build the fulfillment OrderLines without re-touching stock.
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
           total_cents, currency, processor, status, created_at, updated_at)
        VALUES
          (${reference}, ${store.vendorId}::uuid, ${input.buyerEmail}, ${input.buyerName ?? null},
           ${input.buyerPhone ?? null}, ${JSON.stringify(input.shipAddress)}::jsonb,
           ${itemsJson}::jsonb, ${productSubtotalCents}, ${input.discountCode ?? null},
           ${discountCents}, ${shippingCents}, ${input.shippingSpeed}, ${chosen.serviceToken},
           ${platformFeeCents}, ${taxCents}, ${totalCents}, 'USD', ${input.processor},
           'PENDING_PAYMENT', now(), now())
        RETURNING id
      `);
      if (discountCodeId) await this.discounts.redeem(tx, discountCodeId);
      return { orderId: rows[0]!.id, reference };
    });

    // Open the hosted checkout on the processor.
    let checkoutUrl: string;
    let paymentRef: string;
    try {
      const web = loadConfig().WEB_PUBLIC_URL;
      const res = await this.registry.get(input.processor).createCheckout({
        reference,
        amountCents: totalCents,
        platformFeeCents,
        currency: "USD",
        vendorExternalAccountId: payout.externalAccountId,
        buyerEmail: input.buyerEmail,
        successUrl: `${web}/store/${store.slug}/order/${reference}?paid=1`,
        cancelUrl: `${web}/store/${store.slug}/checkout?cancelled=1`,
        metadata: { storefrontOrderId: orderId, vendorId: store.vendorId },
      });
      checkoutUrl = res.checkoutUrl;
      paymentRef = res.paymentRef;
    } catch (err) {
      // Compensate: free the reservation + cancel the order so stock isn't stuck.
      await this.compensate(orderId, items);
      this.logger.error({ err: `${err}`, reference }, "storefront.checkout.payment_open_failed");
      throw new BadRequestException({
        message: "We couldn't start checkout. Please try again.",
        code: "storefront_checkout_failed",
      });
    }

    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE storefront_orders
      SET payment_ref = ${paymentRef}, payment_intent_id = ${paymentRef}, updated_at = now()
      WHERE id = ${orderId}::uuid
    `);

    return { reference, checkoutUrl };
  }

  // ---------------------------------------------------------------------------
  // Cross-vendor checkout (Phase 2)
  // ---------------------------------------------------------------------------

  /**
   * Create one sub-order per store from a cross-vendor cart. Shared buyer +
   * address; each group carries its own shipping speed, processor, and optional
   * discount. Reuses the single-vendor createOrder per group so all the
   * validation/reservation/split logic is identical. Groups are independent: a
   * failure in one is reported without rolling back the others (each successful
   * group already reserved stock + opened a payment).
   */
  async createCrossVendorOrder(input: CrossVendorCheckoutInput): Promise<{
    results: Array<{ slug: string; reference: string; checkoutUrl: string }>;
    errors: Array<{ slug: string; message: string; code?: string }>;
  }> {
    const results: Array<{ slug: string; reference: string; checkoutUrl: string }> = [];
    const errors: Array<{ slug: string; message: string; code?: string }> = [];

    for (const group of input.groups) {
      try {
        const res = await this.createOrder(group.slug, {
          items: group.items,
          shipAddress: input.shipAddress,
          buyerEmail: input.buyerEmail,
          buyerName: input.buyerName,
          buyerPhone: input.buyerPhone,
          shippingSpeed: group.shippingSpeed,
          processor: group.processor,
          discountCode: group.discountCode,
        });
        results.push({ slug: group.slug, reference: res.reference, checkoutUrl: res.checkoutUrl });
      } catch (err) {
        const e = err as { message?: string; response?: { message?: string; code?: string } };
        errors.push({
          slug: group.slug,
          message: e.response?.message ?? e.message ?? "Checkout failed for this store.",
          code: e.response?.code,
        });
      }
    }
    return { results, errors };
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

  /** Live Shippo estimate, collapsed to Standard/Express buyer options. */
  private async shippingOptions(
    items: CheckoutItem[],
    declaredValueCents: number,
    addr: StorefrontShipAddress,
  ): Promise<BuyerShippingOption[]> {
    const cfg = loadConfig();
    const weightOz = items.reduce((s, i) => s + i.weightOz * i.qty, 0) || 1;
    const lengthIn = Math.max(1, ...items.map((i) => i.lengthIn ?? 0));
    const widthIn = Math.max(1, ...items.map((i) => i.widthIn ?? 0));
    const heightIn =
      items.reduce((s, i) => s + (i.heightIn ?? 0) * i.qty, 0) || 1;

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
      parcel: { weightOz, lengthIn, widthIn, heightIn },
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
