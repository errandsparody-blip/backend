/**
 * StorefrontService — vendor-facing catalog + storefront settings (Migration 0059).
 *
 * Responsibilities (single, cohesive: "the vendor's own store configuration"):
 *   - List / unlist products and set their public retail price + category/tags.
 *   - Storefront presentation (display name, logo, banner, accent, about).
 *   - The store slug (URL handle for /store/[slug] and [slug].usaerrands.com).
 *   - Enabling the storefront, which charges the one-time $50 setup fee to the
 *     vendor's wallet exactly once and gates on an ACTIVE payout account.
 *   - The (free) marketplace feature toggle.
 *
 * Public buyer reads, checkout, payments, and discounts live in their own
 * services (later layers). All persistence uses raw SQL so the module works
 * before the local Prisma client is regenerated with the 0059 tables/columns.
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "crypto";

import { PrismaService } from "../../common/prisma.service";
import type {
  SetProductListingInput,
  UpsertStorefrontSettingsInput,
} from "../../common/schemas/storefront.schema";
import { PayoutAccountService } from "../payments/payout-account.service";
import { WalletService } from "../wallet/wallet.service";

/** One-time storefront setup fee, in cents ($50). Featuring stays free. */
export const STOREFRONT_SETUP_FEE_CENTS = 5000;

/**
 * Canonicalise a category so casing/whitespace never fracture it into duplicates
 * ("Clothing", "clothing", "  CLOTHING " → "Clothing"). Trims, collapses inner
 * whitespace, and Title-Cases each word. null/empty passes through as null.
 */
export function normalizeCategory(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const cleaned = raw.trim().replace(/\s+/g, " ");
  if (!cleaned) return null;
  return cleaned
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/** Slugs we never let a vendor take — they collide with app/system routes. */
const RESERVED_SLUGS = new Set([
  "www", "api", "admin", "app", "store", "stores", "mail", "email", "static",
  "assets", "cdn", "help", "support", "about", "legal", "login", "signup",
  "dashboard", "portal", "checkout", "cart", "marketplace", "shop", "shopper",
  "vendor", "vendors", "account", "settings", "status", "blog", "docs",
]);

export interface StorefrontSettings {
  slug: string | null;
  storefrontEnabled: boolean;
  storefrontFeePaidAt: Date | null;
  marketplaceFeatured: boolean;
  displayName: string | null;
  logoUrl: string | null;
  bannerUrl: string | null;
  accentColor: string | null;
  about: string | null;
  currency: string;
  returnsAllowed: boolean;
  returnWindowDays: number;
  hasActivePayoutAccount: boolean;
}

export interface ProductListingSnapshot {
  id: string;
  listed: boolean;
  retailPriceCents: number | null;
  category: string | null;
  tags: string[];
  status: string;
}

@Injectable()
export class StorefrontService {
  private readonly logger = new Logger(StorefrontService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly payouts: PayoutAccountService,
  ) {}

  // ---------------------------------------------------------------------------
  // Catalog: list / unlist + retail pricing + categorisation
  // ---------------------------------------------------------------------------

  /**
   * Toggle a product's storefront listing and set its public retail price and
   * categorisation. Retail price is editable here; the declared (customs) value
   * is NOT touched. Enforces: the product belongs to the vendor and is ACTIVE,
   * and a positive retail price exists before it can be listed.
   */
  async setProductListing(
    vendorId: string,
    productId: string,
    input: SetProductListingInput,
  ): Promise<ProductListingSnapshot> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        status: string;
        listed: boolean;
        retail_price_cents: number | null;
        category: string | null;
        tags: string[];
        variant: string;
        option_color: string | null;
        image_url: string | null;
      }>
    >(Prisma.sql`
      SELECT id, status, listed, retail_price_cents, category, tags,
             variant, option_color, image_url
      FROM products
      WHERE id = ${productId}::uuid AND vendor_id = ${vendorId}::uuid
    `);
    const product = rows[0];
    if (!product) {
      throw new NotFoundException({
        message: "Product not found.",
        code: "product_not_found",
      });
    }

    // Effective retail price after this update (provided value wins, else keep).
    const nextRetail =
      input.retailPriceCents ?? product.retail_price_cents ?? null;

    if (input.listed) {
      if (product.status !== "ACTIVE") {
        throw new BadRequestException({
          message: "Only active products can be listed on your storefront.",
          code: "product_not_active",
        });
      }
      if (!nextRetail || nextRetail <= 0) {
        throw new BadRequestException({
          message: "Set a retail price greater than $0 before listing this product.",
          code: "retail_price_required",
        });
      }
    }

    // Normalise casing/whitespace on write so "Clothing", "clothing" and
    // "  CLOTHING " don't fracture into separate categories going forward.
    const nextCategory =
      input.category === undefined ? product.category : normalizeCategory(input.category);
    const nextTags = input.tags === undefined ? product.tags : input.tags;
    // Size is NOT typed on the storefront: it derives from the product's own
    // `variant` (the inventory listing). "STD" (the default no-variant marker)
    // means "no size", so a plain product shows no size chip on the marketplace.
    const nextSize =
      product.variant && product.variant.toUpperCase() !== "STD" ? product.variant : null;
    // Colour axis: undefined = keep, null = clear.
    const nextColor = input.optionColor === undefined ? product.option_color : input.optionColor;
    // Detail fields (Migration 0070) are set per-field below: undefined = keep
    // (column omitted from the UPDATE), null = clear, value = set.
    // Gallery: when provided, set image_urls and keep image_url (primary) in sync
    // with the first image; when omitted, leave both untouched.
    const setImages = input.imageUrls !== undefined;
    const nextImageUrls = setImages ? input.imageUrls! : null;
    const nextPrimary = setImages ? input.imageUrls![0] ?? null : product.image_url;

    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE products
      SET listed = ${input.listed},
          retail_price_cents = ${nextRetail},
          category = ${nextCategory},
          tags = ${nextTags}::text[],
          option_size = ${nextSize},
          option_color = ${nextColor},
          ${input.description !== undefined ? Prisma.sql`description = ${input.description},` : Prisma.empty}
          ${input.fit !== undefined ? Prisma.sql`fit = ${input.fit},` : Prisma.empty}
          ${input.gender !== undefined ? Prisma.sql`gender = ${input.gender},` : Prisma.empty}
          ${input.material !== undefined ? Prisma.sql`material = ${input.material},` : Prisma.empty}
          ${input.careInstructions !== undefined ? Prisma.sql`care_instructions = ${input.careInstructions},` : Prisma.empty}
          ${input.brand !== undefined ? Prisma.sql`brand = ${input.brand},` : Prisma.empty}
          ${input.shipsFrom !== undefined ? Prisma.sql`ships_from = ${input.shipsFrom},` : Prisma.empty}
          ${setImages ? Prisma.sql`image_urls = ${nextImageUrls}::text[], image_url = ${nextPrimary},` : Prisma.empty}
          updated_at = now()
      WHERE id = ${productId}::uuid AND vendor_id = ${vendorId}::uuid
    `);

    return {
      id: product.id,
      listed: input.listed,
      retailPriceCents: nextRetail,
      category: nextCategory,
      tags: nextTags,
      status: product.status,
    };
  }

  /**
   * Group a set of the vendor's products into ONE storefront listing (variants).
   * Assigns them a shared variant_group_id. All must belong to the vendor. Reuses
   * an existing group id if any selected product already has one (so adding to a
   * group works); otherwise mints a new id. Returns the group id.
   */
  async groupProductsAsVariants(vendorId: string, productIds: string[]): Promise<{ variantGroupId: string }> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; variant_group_id: string | null }>>(
      Prisma.sql`
        SELECT id, variant_group_id FROM products
        WHERE vendor_id = ${vendorId}::uuid AND id IN (${Prisma.join(productIds.map((id) => Prisma.sql`${id}::uuid`))})
      `,
    );
    if (rows.length !== productIds.length) {
      throw new BadRequestException({
        message: "One or more products weren't found for your account.",
        code: "product_not_found",
      });
    }
    const existing = rows.find((r) => r.variant_group_id)?.variant_group_id;
    const groupId = existing ?? randomUUID();
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE products SET variant_group_id = ${groupId}::uuid, updated_at = now()
      WHERE vendor_id = ${vendorId}::uuid
        AND id IN (${Prisma.join(productIds.map((id) => Prisma.sql`${id}::uuid`))})
    `);
    return { variantGroupId: groupId };
  }

  /** Remove one product from its variant group (it becomes a standalone listing). */
  async ungroupProduct(vendorId: string, productId: string): Promise<void> {
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE products SET variant_group_id = NULL, updated_at = now()
      WHERE id = ${productId}::uuid AND vendor_id = ${vendorId}::uuid
    `);
  }

  /** Vendor's products with their storefront listing state (for management UI). */
  async listVendorProducts(vendorId: string): Promise<
    Array<{
      id: string;
      code: string;
      name: string;
      status: string;
      listed: boolean;
      retailPriceCents: number | null;
      category: string | null;
      variant: string;
      optionSize: string | null;
      optionColor: string | null;
      variantGroupId: string | null;
      imageUrl: string | null;
      imageUrls: string[];
      availableStock: number;
    }>
  > {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        code: string;
        name: string;
        status: string;
        listed: boolean;
        retail_price_cents: number | null;
        category: string | null;
        variant: string;
        option_size: string | null;
        option_color: string | null;
        variant_group_id: string | null;
        image_url: string | null;
        image_urls: string[];
        available_stock: number | null;
      }>
    >(Prisma.sql`
      SELECT p.id, p.code, p.name, p.status, p.listed, p.retail_price_cents, p.category,
             p.variant, p.option_size, p.option_color, p.variant_group_id, p.image_url, p.image_urls,
             COALESCE(s.avail, 0) AS available_stock
      FROM products p
      LEFT JOIN (
        SELECT product_id, SUM(quantity_available - quantity_reserved) AS avail
        FROM skus WHERE status = 'ACTIVE' GROUP BY product_id
      ) s ON s.product_id = p.id
      WHERE p.vendor_id = ${vendorId}::uuid AND p.status = 'ACTIVE'
      ORDER BY p.created_at DESC
      LIMIT 500
    `);
    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      status: r.status,
      listed: r.listed,
      retailPriceCents: r.retail_price_cents,
      category: r.category,
      // The product's inventory variant — the source of truth for its size.
      variant: r.variant,
      optionSize: r.option_size,
      optionColor: r.option_color,
      variantGroupId: r.variant_group_id,
      imageUrl: r.image_url,
      // Fall back to the single primary image for products predating the gallery.
      imageUrls: r.image_urls?.length ? r.image_urls : r.image_url ? [r.image_url] : [],
      // Sellable units = available − reserved across active SKUs (never negative).
      availableStock: Math.max(0, Number(r.available_stock ?? 0)),
    }));
  }

  /** One vendor product with all storefront-editable detail fields (edit page). */
  async getVendorProduct(
    vendorId: string,
    productId: string,
  ): Promise<{
    id: string;
    code: string;
    name: string;
    variant: string;
    listed: boolean;
    retailPriceCents: number | null;
    category: string | null;
    optionColor: string | null;
    imageUrls: string[];
    availableStock: number;
    description: string | null;
    fit: string | null;
    gender: string | null;
    material: string | null;
    careInstructions: string | null;
    brand: string | null;
    shipsFrom: string | null;
  }> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        code: string;
        name: string;
        variant: string;
        listed: boolean;
        retail_price_cents: number | null;
        category: string | null;
        option_color: string | null;
        image_url: string | null;
        image_urls: string[];
        available_stock: number | null;
        description: string | null;
        fit: string | null;
        gender: string | null;
        material: string | null;
        care_instructions: string | null;
        brand: string | null;
        ships_from: string | null;
      }>
    >(Prisma.sql`
      SELECT p.id, p.code, p.name, p.variant, p.listed, p.retail_price_cents, p.category,
             p.option_color, p.image_url, p.image_urls,
             COALESCE(s.avail, 0) AS available_stock,
             p.description, p.fit, p.gender, p.material, p.care_instructions, p.brand, p.ships_from
      FROM products p
      LEFT JOIN (
        SELECT product_id, SUM(quantity_available - quantity_reserved) AS avail
        FROM skus WHERE status = 'ACTIVE' GROUP BY product_id
      ) s ON s.product_id = p.id
      WHERE p.id = ${productId}::uuid AND p.vendor_id = ${vendorId}::uuid AND p.status = 'ACTIVE'
      LIMIT 1
    `);
    const r = rows[0];
    if (!r) {
      throw new NotFoundException({ message: "Product not found.", code: "product_not_found" });
    }
    return {
      id: r.id,
      code: r.code,
      name: r.name,
      variant: r.variant,
      listed: r.listed,
      retailPriceCents: r.retail_price_cents,
      category: r.category,
      optionColor: r.option_color,
      imageUrls: r.image_urls?.length ? r.image_urls : r.image_url ? [r.image_url] : [],
      availableStock: Math.max(0, Number(r.available_stock ?? 0)),
      description: r.description,
      fit: r.fit,
      gender: r.gender,
      material: r.material,
      careInstructions: r.care_instructions,
      brand: r.brand,
      shipsFrom: r.ships_from,
    };
  }

  // ---------------------------------------------------------------------------
  // Storefront settings + slug
  // ---------------------------------------------------------------------------

  async getSettings(vendorId: string): Promise<StorefrontSettings> {
    const vendorRows = await this.prisma.$queryRaw<
      Array<{
        slug: string | null;
        storefront_enabled: boolean;
        storefront_fee_paid_at: Date | null;
        marketplace_featured: boolean;
      }>
    >(Prisma.sql`
      SELECT slug, storefront_enabled, storefront_fee_paid_at, marketplace_featured
      FROM vendors WHERE id = ${vendorId}::uuid
    `);
    const v = vendorRows[0];
    if (!v) {
      throw new NotFoundException({ message: "Vendor not found.", code: "vendor_not_found" });
    }

    const sfRows = await this.prisma.$queryRaw<
      Array<{
        display_name: string;
        logo_url: string | null;
        banner_url: string | null;
        accent_color: string | null;
        about: string | null;
        currency: string;
        returns_allowed: boolean | null;
        return_window_days: number | null;
      }>
    >(Prisma.sql`
      SELECT display_name, logo_url, banner_url, accent_color, about, currency,
             returns_allowed, return_window_days
      FROM vendor_storefronts WHERE vendor_id = ${vendorId}::uuid
    `);
    const sf = sfRows[0];

    return {
      slug: v.slug,
      storefrontEnabled: v.storefront_enabled,
      storefrontFeePaidAt: v.storefront_fee_paid_at,
      marketplaceFeatured: v.marketplace_featured,
      displayName: sf?.display_name ?? null,
      logoUrl: sf?.logo_url ?? null,
      bannerUrl: sf?.banner_url ?? null,
      accentColor: sf?.accent_color ?? null,
      about: sf?.about ?? null,
      currency: sf?.currency ?? "USD",
      returnsAllowed: sf?.returns_allowed ?? true,
      returnWindowDays: sf?.return_window_days ?? 30,
      hasActivePayoutAccount: await this.hasActivePayoutAccount(vendorId),
    };
  }

  async upsertSettings(
    vendorId: string,
    input: UpsertStorefrontSettingsInput,
  ): Promise<StorefrontSettings> {
    // Returns policy: when a field is omitted, keep the existing value (or the
    // column default of true / 30 for a brand-new row) rather than resetting it.
    const returnsAllowed = input.returnsAllowed ?? null;
    const returnWindowDays = input.returnWindowDays ?? null;
    await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO vendor_storefronts
        (vendor_id, display_name, logo_url, banner_url, accent_color, about, currency,
         returns_allowed, return_window_days, created_at, updated_at)
      VALUES
        (${vendorId}::uuid, ${input.displayName}, ${input.logoUrl ?? null},
         ${input.bannerUrl ?? null}, ${input.accentColor ?? null}, ${input.about ?? null},
         'USD', COALESCE(${returnsAllowed}::boolean, true),
         COALESCE(${returnWindowDays}::int, 30), now(), now())
      ON CONFLICT (vendor_id) DO UPDATE SET
        display_name       = EXCLUDED.display_name,
        logo_url           = EXCLUDED.logo_url,
        banner_url         = EXCLUDED.banner_url,
        accent_color       = EXCLUDED.accent_color,
        about              = EXCLUDED.about,
        returns_allowed    = COALESCE(${returnsAllowed}::boolean, vendor_storefronts.returns_allowed),
        return_window_days = COALESCE(${returnWindowDays}::int, vendor_storefronts.return_window_days),
        updated_at         = now()
    `);
    return this.getSettings(vendorId);
  }

  async setSlug(vendorId: string, slug: string): Promise<StorefrontSettings> {
    if (RESERVED_SLUGS.has(slug)) {
      throw new BadRequestException({
        message: "That store address is reserved — please choose another.",
        code: "slug_reserved",
      });
    }
    // Uniqueness across all OTHER vendors.
    const taken = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM vendors WHERE slug = ${slug} AND id <> ${vendorId}::uuid LIMIT 1
    `);
    if (taken.length > 0) {
      throw new ConflictException({
        message: "That store address is already taken.",
        code: "slug_taken",
      });
    }
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE vendors SET slug = ${slug} WHERE id = ${vendorId}::uuid
    `);
    return this.getSettings(vendorId);
  }

  // ---------------------------------------------------------------------------
  // Enable / disable + marketplace feature
  // ---------------------------------------------------------------------------

  /**
   * Enable the storefront. Charges the one-time $50 setup fee to the wallet
   * exactly once (idempotent on vendor id), and requires a slug, storefront
   * settings, and an ACTIVE payout account first. Re-enabling after a disable
   * does NOT charge again (storefront_fee_paid_at is the guard).
   */
  async enableStorefront(vendorId: string, actorId: string): Promise<StorefrontSettings> {
    const settings = await this.getSettings(vendorId);

    if (settings.storefrontEnabled) return settings; // idempotent no-op

    if (!settings.slug) {
      throw new BadRequestException({
        message: "Choose your store address (slug) before going live.",
        code: "slug_required",
      });
    }
    if (!settings.displayName) {
      throw new BadRequestException({
        message: "Add your storefront name before going live.",
        code: "storefront_settings_required",
      });
    }
    // Sync the payout status live from the processor before gating on it. The
    // stored status is set to PENDING at connect time and is otherwise only
    // updated by a webhook; a vendor who has just finished Stripe onboarding
    // (account already "Enabled" on Stripe) would still read PENDING here and
    // be blocked. Best-effort: refresh each connected account, ignore failures.
    let hasActivePayoutAccount = settings.hasActivePayoutAccount;
    if (!hasActivePayoutAccount) {
      try {
        const connected = await this.payouts.list(vendorId);
        for (const acc of connected) {
          if (acc.externalAccountId) {
            await this.payouts.refresh(vendorId, acc.processor).catch(() => undefined);
          }
        }
      } catch {
        // fall through to the check below with the last-known status
      }
      hasActivePayoutAccount = (await this.getSettings(vendorId)).hasActivePayoutAccount;
    }
    if (!hasActivePayoutAccount) {
      throw new BadRequestException({
        message:
          "Connect a payout account (Stripe or Flutterwave) before going live so sales can settle to you.",
        code: "payout_account_required",
      });
    }

    // Charge the one-time fee if not already paid. wallet.debit throws
    // ConflictException(insufficient_funds) which surfaces as a clean 409.
    if (!settings.storefrontFeePaidAt) {
      await this.wallet.debit({
        vendorId,
        amountCents: STOREFRONT_SETUP_FEE_CENTS,
        type: "STOREFRONT_FEE",
        description: "One-time storefront setup fee",
        referenceType: "storefront",
        referenceId: vendorId,
        idempotencyKey: `storefront_fee:${vendorId}`,
        actorId,
      });
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE vendors SET storefront_fee_paid_at = now() WHERE id = ${vendorId}::uuid
      `);
    }

    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE vendors SET storefront_enabled = true WHERE id = ${vendorId}::uuid
    `);
    return this.getSettings(vendorId);
  }

  async disableStorefront(vendorId: string): Promise<StorefrontSettings> {
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE vendors SET storefront_enabled = false WHERE id = ${vendorId}::uuid
    `);
    return this.getSettings(vendorId);
  }

  async setMarketplaceFeatured(
    vendorId: string,
    featured: boolean,
  ): Promise<StorefrontSettings> {
    const settings = await this.getSettings(vendorId);
    if (featured && !settings.storefrontEnabled) {
      throw new BadRequestException({
        message: "Go live with your storefront before featuring on the marketplace.",
        code: "storefront_not_enabled",
      });
    }
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE vendors SET marketplace_featured = ${featured} WHERE id = ${vendorId}::uuid
    `);
    return this.getSettings(vendorId);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async hasActivePayoutAccount(vendorId: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM vendor_payout_accounts
      WHERE vendor_id = ${vendorId}::uuid AND status = 'ACTIVE'
      LIMIT 1
    `);
    return rows.length > 0;
  }
}
