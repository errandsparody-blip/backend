/**
 * StorefrontPublicService — public (buyer-facing) reads (Migration 0059).
 *
 * The resolver is the single mapping from an incoming store identifier to a
 * vendor, so every URL model (slug path, subdomain, and later custom domains)
 * shares one code path. Only ENABLED storefronts resolve; a disabled or
 * non-existent store is a 404 to the public.
 *
 * Catalog + product-detail reads are added to this service in Layer 5.
 */
import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { PrismaService } from "../../common/prisma.service";

export interface PublicStorefront {
  vendorId: string;
  slug: string;
  displayName: string;
  logoUrl: string | null;
  bannerUrl: string | null;
  accentColor: string | null;
  about: string | null;
  currency: string;
  /** Payment rails this store can actually accept (ACTIVE payout accounts). */
  availableProcessors: string[];
}

export interface PublicProductCard {
  id: string;
  name: string;
  category: string | null;
  tags: string[];
  retailPriceCents: number;
  imageUrl: string | null;
  available: number;
}

@Injectable()
export class StorefrontPublicService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve a live storefront by its slug. Throws 404 for unknown or disabled
   * stores. This is the shared entry point for the slug route AND the subdomain
   * middleware (which rewrites to the same slug route); custom domains will call
   * a sibling resolveByHost() later without changing callers.
   */
  async resolveBySlug(slug: string): Promise<PublicStorefront> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        vendor_id: string;
        slug: string;
        business_name: string;
        display_name: string | null;
        logo_url: string | null;
        banner_url: string | null;
        accent_color: string | null;
        about: string | null;
        currency: string | null;
      }>
    >(Prisma.sql`
      SELECT v.id AS vendor_id, v.slug, v.business_name,
             s.display_name, s.logo_url, s.banner_url, s.accent_color, s.about, s.currency
      FROM vendors v
      LEFT JOIN vendor_storefronts s ON s.vendor_id = v.id
      WHERE lower(v.slug) = ${slug.toLowerCase()}
        AND v.storefront_enabled = true
      LIMIT 1
    `);
    const r = rows[0];
    if (!r) {
      throw new NotFoundException({
        message: "Store not found.",
        code: "storefront_not_found",
      });
    }
    const procRows = await this.prisma.$queryRaw<Array<{ processor: string }>>(Prisma.sql`
      SELECT processor FROM vendor_payout_accounts
      WHERE vendor_id = ${r.vendor_id}::uuid AND status = 'ACTIVE'
    `);
    return {
      vendorId: r.vendor_id,
      slug: r.slug,
      displayName: r.display_name ?? r.business_name,
      logoUrl: r.logo_url,
      bannerUrl: r.banner_url,
      accentColor: r.accent_color,
      about: r.about,
      currency: r.currency ?? "USD",
      availableProcessors: procRows.map((p) => p.processor),
    };
  }

  /**
   * Custom-domain resolver: map a verified host to its store slug (Phase 3).
   * Returns null when the host isn't a verified domain of a live store.
   */
  async resolveHostToSlug(host: string): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<Array<{ slug: string }>>(Prisma.sql`
      SELECT v.slug
      FROM vendor_domains d
      JOIN vendors v ON v.id = d.vendor_id
      WHERE lower(d.host) = ${host.trim().toLowerCase()}
        AND d.status = 'VERIFIED'
        AND v.storefront_enabled = true
        AND v.slug IS NOT NULL
      LIMIT 1
    `);
    return rows[0]?.slug ?? null;
  }

  /**
   * Listed, active, priced, IN-STOCK products for a live store. Availability is
   * read straight off SKU quantities (available − reserved) — the same single
   * source of truth the warehouse uses, so the storefront never drifts from
   * real inventory. Optional category filter.
   */
  async listProducts(
    vendorId: string,
    opts: { category?: string } = {},
  ): Promise<PublicProductCard[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        name: string;
        category: string | null;
        tags: string[];
        retail_price_cents: number;
        image_url: string | null;
        available: number | bigint;
      }>
    >(Prisma.sql`
      SELECT p.id, p.name, p.category, p.tags, p.retail_price_cents, p.image_url,
             COALESCE(s.avail, 0) AS available
      FROM products p
      LEFT JOIN (
        SELECT product_id, SUM(quantity_available - quantity_reserved) AS avail
        FROM skus WHERE status = 'ACTIVE' GROUP BY product_id
      ) s ON s.product_id = p.id
      WHERE p.vendor_id = ${vendorId}::uuid
        AND p.listed = true
        AND p.status = 'ACTIVE'
        AND p.retail_price_cents IS NOT NULL
        AND COALESCE(s.avail, 0) > 0
        ${opts.category ? Prisma.sql`AND p.category = ${opts.category}` : Prisma.empty}
      ORDER BY p.created_at DESC
      LIMIT 120
    `);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      category: r.category,
      tags: r.tags,
      retailPriceCents: r.retail_price_cents,
      imageUrl: r.image_url,
      available: Number(r.available),
    }));
  }

  /** Single product detail for a live store (must be listed + in stock). */
  async getProduct(vendorId: string, productId: string): Promise<PublicProductCard> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        name: string;
        category: string | null;
        tags: string[];
        retail_price_cents: number | null;
        image_url: string | null;
        available: number | bigint;
      }>
    >(Prisma.sql`
      SELECT p.id, p.name, p.category, p.tags, p.retail_price_cents, p.image_url,
             COALESCE(s.avail, 0) AS available
      FROM products p
      LEFT JOIN (
        SELECT product_id, SUM(quantity_available - quantity_reserved) AS avail
        FROM skus WHERE status = 'ACTIVE' GROUP BY product_id
      ) s ON s.product_id = p.id
      WHERE p.id = ${productId}::uuid
        AND p.vendor_id = ${vendorId}::uuid
        AND p.listed = true
        AND p.status = 'ACTIVE'
      LIMIT 1
    `);
    const r = rows[0];
    if (!r || r.retail_price_cents == null) {
      throw new NotFoundException({ message: "Product not found.", code: "product_not_found" });
    }
    return {
      id: r.id,
      name: r.name,
      category: r.category,
      tags: r.tags,
      retailPriceCents: r.retail_price_cents,
      imageUrl: r.image_url,
      available: Number(r.available),
    };
  }

  // ---------------------------------------------------------------------------
  // Multi-vendor marketplace feed (Phase 2) — across storefront-enabled AND
  // marketplace-featured vendors only.
  // ---------------------------------------------------------------------------

  /** Mixed (randomised) product feed across all featured stores. */
  async listMarketplaceProducts(
    opts: { category?: string } = {},
  ): Promise<
    Array<PublicProductCard & { vendorSlug: string; storeName: string }>
  > {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        name: string;
        category: string | null;
        tags: string[];
        retail_price_cents: number;
        image_url: string | null;
        available: number | bigint;
        vendor_slug: string;
        store_name: string;
      }>
    >(Prisma.sql`
      SELECT p.id, p.name, p.category, p.tags, p.retail_price_cents, p.image_url,
             COALESCE(st.avail, 0) AS available,
             v.slug AS vendor_slug,
             COALESCE(vs.display_name, v.business_name) AS store_name
      FROM products p
      JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN vendor_storefronts vs ON vs.vendor_id = v.id
      LEFT JOIN (
        SELECT product_id, SUM(quantity_available - quantity_reserved) AS avail
        FROM skus WHERE status = 'ACTIVE' GROUP BY product_id
      ) st ON st.product_id = p.id
      WHERE v.storefront_enabled = true AND v.marketplace_featured = true
        AND p.listed = true AND p.status = 'ACTIVE' AND p.retail_price_cents IS NOT NULL
        AND COALESCE(st.avail, 0) > 0
        ${opts.category ? Prisma.sql`AND p.category = ${opts.category}` : Prisma.empty}
      ORDER BY random()
      LIMIT 120
    `);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      category: r.category,
      tags: r.tags,
      retailPriceCents: r.retail_price_cents,
      imageUrl: r.image_url,
      available: Number(r.available),
      vendorSlug: r.vendor_slug,
      storeName: r.store_name,
    }));
  }

  /** Distinct categories across all featured stores. */
  async listMarketplaceCategories(): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ category: string }>>(Prisma.sql`
      SELECT DISTINCT p.category
      FROM products p JOIN vendors v ON v.id = p.vendor_id
      WHERE v.storefront_enabled = true AND v.marketplace_featured = true
        AND p.listed = true AND p.status = 'ACTIVE' AND p.category IS NOT NULL
      ORDER BY p.category ASC
    `);
    return rows.map((r) => r.category);
  }

  /** Featured stores strip. */
  async listFeaturedStores(): Promise<
    Array<{ slug: string; displayName: string; logoUrl: string | null; accentColor: string | null }>
  > {
    const rows = await this.prisma.$queryRaw<
      Array<{ slug: string; name: string; logo_url: string | null; accent_color: string | null }>
    >(Prisma.sql`
      SELECT v.slug, COALESCE(vs.display_name, v.business_name) AS name,
             vs.logo_url, vs.accent_color
      FROM vendors v LEFT JOIN vendor_storefronts vs ON vs.vendor_id = v.id
      WHERE v.storefront_enabled = true AND v.marketplace_featured = true AND v.slug IS NOT NULL
      ORDER BY v.updated_at DESC
      LIMIT 60
    `);
    return rows.map((r) => ({
      slug: r.slug,
      displayName: r.name,
      logoUrl: r.logo_url,
      accentColor: r.accent_color,
    }));
  }

  /** Distinct non-null categories across a store's listed products. */
  async listCategories(vendorId: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ category: string }>>(Prisma.sql`
      SELECT DISTINCT category FROM products
      WHERE vendor_id = ${vendorId}::uuid AND listed = true
        AND status = 'ACTIVE' AND category IS NOT NULL
      ORDER BY category ASC
    `);
    return rows.map((r) => r.category);
  }
}
