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
        option_size: string | null;
        option_color: string | null;
        image_url: string | null;
      }>
    >(Prisma.sql`
      SELECT id, status, listed, retail_price_cents, category, tags,
             option_size, option_color, image_url
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

    const nextCategory =
      input.category === undefined ? product.category : input.category;
    const nextTags = input.tags === undefined ? product.tags : input.tags;
    // Variant fields: undefined = keep, null = clear.
    const nextSize = input.optionSize === undefined ? product.option_size : input.optionSize;
    const nextColor = input.optionColor === undefined ? product.option_color : input.optionColor;
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
      optionSize: string | null;
      optionColor: string | null;
      variantGroupId: string | null;
      imageUrl: string | null;
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
        option_size: string | null;
        option_color: string | null;
        variant_group_id: string | null;
        image_url: string | null;
      }>
    >(Prisma.sql`
      SELECT id, code, name, status, listed, retail_price_cents, category,
             option_size, option_color, variant_group_id, image_url
      FROM products
      WHERE vendor_id = ${vendorId}::uuid AND status = 'ACTIVE'
      ORDER BY created_at DESC
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
      optionSize: r.option_size,
      optionColor: r.option_color,
      variantGroupId: r.variant_group_id,
      imageUrl: r.image_url,
    }));
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
      }>
    >(Prisma.sql`
      SELECT display_name, logo_url, banner_url, accent_color, about, currency
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
      hasActivePayoutAccount: await this.hasActivePayoutAccount(vendorId),
    };
  }

  async upsertSettings(
    vendorId: string,
    input: UpsertStorefrontSettingsInput,
  ): Promise<StorefrontSettings> {
    await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO vendor_storefronts
        (vendor_id, display_name, logo_url, banner_url, accent_color, about, currency, created_at, updated_at)
      VALUES
        (${vendorId}::uuid, ${input.displayName}, ${input.logoUrl ?? null},
         ${input.bannerUrl ?? null}, ${input.accentColor ?? null}, ${input.about ?? null},
         'USD', now(), now())
      ON CONFLICT (vendor_id) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        logo_url     = EXCLUDED.logo_url,
        banner_url   = EXCLUDED.banner_url,
        accent_color = EXCLUDED.accent_color,
        about        = EXCLUDED.about,
        updated_at   = now()
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
