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
  /** Set when this card represents a size×colour variant group (Migration 0066);
   *  the product page loads the full variant set via getListing. */
  variantGroupId?: string | null;
  /** True when the group's variants aren't all the same price (card shows "from $X"). */
  priceVaries?: boolean;
}

/** One selectable variant within a listing. */
export interface ListingVariant {
  productId: string;
  optionSize: string | null;
  optionColor: string | null;
  retailPriceCents: number;
  imageUrl: string | null;
  imageUrls: string[];
  available: number;
}

/** A storefront listing = one product, or a group of size×colour variants. */
export interface PublicListing {
  name: string;
  category: string | null;
  tags: string[];
  variantGroupId: string | null;
  /** Distinct option axes for the selectors (empty when the listing is single). */
  sizes: string[];
  colors: string[];
  variants: ListingVariant[];
  /** Vendor-declared returns policy, for the product page's Returns section. */
  returnsAllowed: boolean;
  returnWindowDays: number;
  /** Vendor-authored product details (Migration 0070) for the details section. */
  description: string | null;
  fit: string | null;
  gender: string | null;
  material: string | null;
  careInstructions: string | null;
  brand: string | null;
  shipsFrom: string | null;
}

/** Collapse rows sharing a variant_group_id into ONE card (representative =
 *  cheapest in-stock variant); availability is summed and price shows "from". */
interface VariantRow {
  id: string;
  name: string;
  category: string | null;
  tags: string[];
  retail_price_cents: number;
  image_url: string | null;
  available: number | bigint;
  variant_group_id: string | null;
}
function collapseVariantRows<T extends VariantRow>(rows: T[]): Array<T & { card: PublicProductCard }> {
  const byGroup = new Map<string, T[]>();
  for (const r of rows) {
    const key = r.variant_group_id ?? r.id;
    const g = byGroup.get(key);
    if (g) g.push(r);
    else byGroup.set(key, [r]);
  }
  return [...byGroup.values()].map((group) => {
    const rep = group.reduce((a, b) => (b.retail_price_cents < a.retail_price_cents ? b : a));
    const prices = group.map((g) => g.retail_price_cents);
    const card: PublicProductCard = {
      id: rep.id,
      name: rep.name,
      category: rep.category,
      tags: rep.tags,
      retailPriceCents: Math.min(...prices),
      imageUrl: rep.image_url,
      available: group.reduce((s, g) => s + Number(g.available), 0),
      variantGroupId: rep.variant_group_id,
      priceVaries: new Set(prices).size > 1,
    };
    return { ...rep, card };
  });
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
        variant_group_id: string | null;
      }>
    >(Prisma.sql`
      SELECT p.id, p.name, p.category, p.tags, p.retail_price_cents, p.image_url,
             COALESCE(s.avail, 0) AS available, p.variant_group_id
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
        ${opts.category ? Prisma.sql`AND LOWER(p.category) = LOWER(${opts.category})` : Prisma.empty}
      ORDER BY p.created_at DESC
      LIMIT 240
    `);
    // Collapse size×colour variants into one card per listing.
    return collapseVariantRows(rows).map((g) => g.card);
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

  /**
   * A listing with all its size×colour variants (Migration 0066). The path param
   * may be a product id OR a variant_group_id. Includes out-of-stock variants so
   * the product page can show every size/colour and disable the sold-out combos.
   * A lone product returns a single-variant listing so the page has one code path.
   */
  async getListing(vendorId: string, idOrGroup: string): Promise<PublicListing> {
    const match = await this.prisma.$queryRaw<
      Array<{ id: string; variant_group_id: string | null }>
    >(Prisma.sql`
      SELECT id, variant_group_id FROM products
      WHERE (id = ${idOrGroup}::uuid OR variant_group_id = ${idOrGroup}::uuid)
        AND vendor_id = ${vendorId}::uuid AND listed = true AND status = 'ACTIVE'
        AND retail_price_cents IS NOT NULL
      LIMIT 1
    `);
    const m = match[0];
    if (!m) {
      throw new NotFoundException({ message: "Product not found.", code: "product_not_found" });
    }
    const groupFilter = m.variant_group_id
      ? Prisma.sql`p.variant_group_id = ${m.variant_group_id}::uuid`
      : Prisma.sql`p.id = ${m.id}::uuid`;

    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        name: string;
        category: string | null;
        tags: string[];
        variant: string;
        option_color: string | null;
        retail_price_cents: number;
        image_url: string | null;
        image_urls: string[];
        available: number | bigint;
        description: string | null;
        fit: string | null;
        gender: string | null;
        material: string | null;
        care_instructions: string | null;
        brand: string | null;
        ships_from: string | null;
      }>
    >(Prisma.sql`
      SELECT p.id, p.name, p.category, p.tags, p.variant, p.option_color,
             p.retail_price_cents, p.image_url, p.image_urls,
             COALESCE(s.avail, 0) AS available,
             p.description, p.fit, p.gender, p.material, p.care_instructions, p.brand, p.ships_from
      FROM products p
      LEFT JOIN (
        SELECT product_id, SUM(quantity_available - quantity_reserved) AS avail
        FROM skus WHERE status = 'ACTIVE' GROUP BY product_id
      ) s ON s.product_id = p.id
      WHERE ${groupFilter}
        AND p.vendor_id = ${vendorId}::uuid AND p.listed = true AND p.status = 'ACTIVE'
        AND p.retail_price_cents IS NOT NULL
      ORDER BY p.option_color ASC NULLS FIRST, p.variant ASC NULLS FIRST, p.created_at ASC
    `);
    if (rows.length === 0) {
      throw new NotFoundException({ message: "Product not found.", code: "product_not_found" });
    }

    // Size comes from each product's `variant` (its inventory listing), never a
    // separately-typed field. "STD" is the no-variant marker → treat as no size.
    const sizeOf = (variant: string): string | null =>
      variant && variant.toUpperCase() !== "STD" ? variant : null;

    const variants: ListingVariant[] = rows.map((r) => ({
      productId: r.id,
      optionSize: sizeOf(r.variant),
      optionColor: r.option_color,
      retailPriceCents: r.retail_price_cents,
      imageUrl: r.image_url,
      imageUrls:
        r.image_urls && r.image_urls.length > 0
          ? r.image_urls
          : r.image_url
            ? [r.image_url]
            : [],
      available: Number(r.available),
    }));
    const uniq = (xs: Array<string | null>): string[] =>
      [...new Set(xs.filter((x): x is string => !!x))];

    // Vendor's declared returns policy (defaults preserve pre-policy behaviour).
    const policyRows = await this.prisma.$queryRaw<
      Array<{ returns_allowed: boolean | null; return_window_days: number | null }>
    >(Prisma.sql`
      SELECT returns_allowed, return_window_days
      FROM vendor_storefronts WHERE vendor_id = ${vendorId}::uuid
      LIMIT 1
    `);
    const policy = policyRows[0];

    // Product details come from the representative row (a listing's variants
    // share one description/fit/etc.). First row with a value wins, so details
    // survive even if the primary variant left some blank.
    const firstOf = (pick: (r: (typeof rows)[number]) => string | null): string | null =>
      rows.map(pick).find((v) => v != null && v !== "") ?? null;

    return {
      name: rows[0]!.name,
      category: rows[0]!.category,
      tags: rows[0]!.tags,
      variantGroupId: m.variant_group_id,
      sizes: uniq(variants.map((v) => v.optionSize)),
      colors: uniq(variants.map((v) => v.optionColor)),
      variants,
      returnsAllowed: policy?.returns_allowed ?? true,
      returnWindowDays: policy?.return_window_days ?? 30,
      description: firstOf((r) => r.description),
      fit: firstOf((r) => r.fit),
      gender: firstOf((r) => r.gender),
      material: firstOf((r) => r.material),
      careInstructions: firstOf((r) => r.care_instructions),
      brand: firstOf((r) => r.brand),
      shipsFrom: firstOf((r) => r.ships_from),
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
        variant_group_id: string | null;
        vendor_slug: string;
        store_name: string;
      }>
    >(Prisma.sql`
      SELECT p.id, p.name, p.category, p.tags, p.retail_price_cents, p.image_url,
             COALESCE(st.avail, 0) AS available, p.variant_group_id,
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
        ${opts.category ? Prisma.sql`AND LOWER(p.category) = LOWER(${opts.category})` : Prisma.empty}
      ORDER BY random()
      LIMIT 240
    `);
    // Collapse size×colour variants into one card, carrying the store fields.
    return collapseVariantRows(rows).map((g) => ({
      ...g.card,
      vendorSlug: g.vendor_slug,
      storeName: g.store_name,
    }));
  }

  /** Distinct categories across all featured stores. */
  async listMarketplaceCategories(): Promise<string[]> {
    // DISTINCT ON (LOWER(...)) collapses casing variants ("Clothing"/"clothing")
    // into one chip, picking a stable representative (first alphabetically).
    const rows = await this.prisma.$queryRaw<Array<{ category: string }>>(Prisma.sql`
      SELECT DISTINCT ON (LOWER(p.category)) p.category
      FROM products p JOIN vendors v ON v.id = p.vendor_id
      WHERE v.storefront_enabled = true AND v.marketplace_featured = true
        AND p.listed = true AND p.status = 'ACTIVE' AND p.category IS NOT NULL
      ORDER BY LOWER(p.category) ASC, p.category ASC
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
    // Collapse casing variants into one entry (see listMarketplaceCategories).
    const rows = await this.prisma.$queryRaw<Array<{ category: string }>>(Prisma.sql`
      SELECT DISTINCT ON (LOWER(category)) category FROM products
      WHERE vendor_id = ${vendorId}::uuid AND listed = true
        AND status = 'ACTIVE' AND category IS NOT NULL
      ORDER BY LOWER(category) ASC, category ASC
    `);
    return rows.map((r) => r.category);
  }
}
