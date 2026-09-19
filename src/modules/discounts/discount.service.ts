/**
 * DiscountService — vendor + super-admin marketplace discount codes
 * (Migration 0059, Layer 8).
 *
 * Resolution rules for a buyer's code on a given vendor's cart:
 *   1. A VENDOR code owned by that vendor (only ever discounts that vendor).
 *   2. Otherwise a MARKETPLACE code that targets all vendors (no target rows)
 *      or that specific vendor.
 * A code is valid only when active, within its date window, under its
 * redemption cap, and the cart meets its minimum. Economics: the discount
 * reduces the buyer's total AND the amount routed to the vendor (so the
 * platform fee — shipping + fulfillment — is never pushed negative); a
 * marketplace promo is therefore funded by the vendors the super-admin targets.
 *
 * All persistence is raw SQL (new tables; stale-client-safe).
 */
import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { PrismaService } from "../../common/prisma.service";
import type {
  CreateMarketplaceDiscountInput,
  CreateVendorDiscountInput,
} from "../../common/schemas/discount.schema";

interface DiscountRow {
  id: string;
  code: string;
  scope: string;
  discount_type: string;
  value_bps: number | null;
  value_cents: number | null;
  active: boolean;
  starts_at: Date | null;
  ends_at: Date | null;
  min_subtotal_cents: number | null;
  max_redemptions: number | null;
  redemption_count: number;
}

export type DiscountResolution =
  | { ok: true; id: string; code: string; discountCents: number }
  | { ok: false; reason: string };

@Injectable()
export class DiscountService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // Vendor codes
  // ---------------------------------------------------------------------------

  async createVendorCode(vendorId: string, input: CreateVendorDiscountInput) {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        INSERT INTO discount_codes
          (code, scope, vendor_id, discount_type, value_bps, value_cents, active,
           starts_at, ends_at, min_subtotal_cents, max_redemptions, created_at, updated_at)
        VALUES
          (${input.code}, 'VENDOR', ${vendorId}::uuid, ${input.discountType},
           ${input.valueBps ?? null}, ${input.valueCents ?? null}, true,
           ${input.startsAt ?? null}, ${input.endsAt ?? null},
           ${input.minSubtotalCents ?? null}, ${input.maxRedemptions ?? null}, now(), now())
        RETURNING id
      `);
      return { id: rows[0]!.id };
    } catch (err) {
      if ((err as { code?: string }).code === "P2010" || `${err}`.includes("duplicate")) {
        throw new BadRequestException({
          message: "You already have a code with that name.",
          code: "discount_code_exists",
        });
      }
      throw err;
    }
  }

  async listVendorCodes(vendorId: string) {
    return this.prisma.$queryRaw(Prisma.sql`
      SELECT id, code, discount_type, value_bps, value_cents, active,
             starts_at, ends_at, min_subtotal_cents, max_redemptions, redemption_count, created_at
      FROM discount_codes
      WHERE scope = 'VENDOR' AND vendor_id = ${vendorId}::uuid
      ORDER BY created_at DESC
    `);
  }

  async deactivateVendorCode(vendorId: string, id: string): Promise<void> {
    await this.setVendorCodeActive(vendorId, id, false);
  }

  /** Flip a vendor code active on/off. Scoped so a vendor can only touch its own. */
  async setVendorCodeActive(vendorId: string, id: string, active: boolean): Promise<void> {
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE discount_codes SET active = ${active}, updated_at = now()
      WHERE id = ${id}::uuid AND scope = 'VENDOR' AND vendor_id = ${vendorId}::uuid
    `);
  }

  /**
   * Permanently remove a vendor code. Safe: nothing references discount_codes
   * except discount_code_vendors (ON DELETE CASCADE); orders store the discount
   * as cents, not a foreign key, so past orders are untouched.
   */
  async deleteVendorCode(vendorId: string, id: string): Promise<void> {
    await this.prisma.$executeRaw(Prisma.sql`
      DELETE FROM discount_codes
      WHERE id = ${id}::uuid AND scope = 'VENDOR' AND vendor_id = ${vendorId}::uuid
    `);
  }

  // ---------------------------------------------------------------------------
  // Marketplace codes (super-admin)
  // ---------------------------------------------------------------------------

  async createMarketplaceCode(actorId: string, input: CreateMarketplaceDiscountInput) {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      INSERT INTO discount_codes
        (code, scope, created_by, discount_type, value_bps, value_cents, active,
         starts_at, ends_at, min_subtotal_cents, max_redemptions, created_at, updated_at)
      VALUES
        (${input.code}, 'MARKETPLACE', ${actorId}::uuid, ${input.discountType},
         ${input.valueBps ?? null}, ${input.valueCents ?? null}, true,
         ${input.startsAt ?? null}, ${input.endsAt ?? null},
         ${input.minSubtotalCents ?? null}, ${input.maxRedemptions ?? null}, now(), now())
      RETURNING id
    `);
    const id = rows[0]!.id;
    for (const vendorId of input.vendorIds ?? []) {
      await this.prisma.$executeRaw(Prisma.sql`
        INSERT INTO discount_code_vendors (discount_code_id, vendor_id)
        VALUES (${id}::uuid, ${vendorId}::uuid)
        ON CONFLICT DO NOTHING
      `);
    }
    return { id };
  }

  async listMarketplaceCodes() {
    return this.prisma.$queryRaw(Prisma.sql`
      SELECT dc.id, dc.code, dc.discount_type, dc.value_bps, dc.value_cents, dc.active,
             dc.starts_at, dc.ends_at, dc.min_subtotal_cents, dc.max_redemptions,
             dc.redemption_count, dc.created_at,
             COALESCE(array_agg(dcv.vendor_id) FILTER (WHERE dcv.vendor_id IS NOT NULL), '{}') AS vendor_ids
      FROM discount_codes dc
      LEFT JOIN discount_code_vendors dcv ON dcv.discount_code_id = dc.id
      WHERE dc.scope = 'MARKETPLACE'
      GROUP BY dc.id
      ORDER BY dc.created_at DESC
    `);
  }

  async deactivateMarketplaceCode(id: string): Promise<void> {
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE discount_codes SET active = false, updated_at = now()
      WHERE id = ${id}::uuid AND scope = 'MARKETPLACE'
    `);
  }

  // ---------------------------------------------------------------------------
  // Resolution (checkout + public validation)
  // ---------------------------------------------------------------------------

  /** Resolve + validate a code for a vendor's cart. Never throws. */
  async resolve(
    vendorId: string,
    codeRaw: string,
    subtotalCents: number,
  ): Promise<DiscountResolution> {
    const code = codeRaw.trim().toUpperCase();

    // 1. Vendor-owned code.
    const vendorRows = await this.prisma.$queryRaw<DiscountRow[]>(Prisma.sql`
      SELECT * FROM discount_codes
      WHERE scope = 'VENDOR' AND vendor_id = ${vendorId}::uuid AND code = ${code}
      LIMIT 1
    `);
    if (vendorRows[0]) return this.validateRow(vendorRows[0], subtotalCents);

    // 2. Marketplace code targeting all vendors or this vendor.
    const mkRows = await this.prisma.$queryRaw<DiscountRow[]>(Prisma.sql`
      SELECT * FROM discount_codes
      WHERE scope = 'MARKETPLACE' AND code = ${code}
      LIMIT 1
    `);
    const mk = mkRows[0];
    if (!mk) return { ok: false, reason: "not_found" };

    const targeted = await this.prisma.$queryRaw<Array<{ vendor_id: string }>>(Prisma.sql`
      SELECT vendor_id FROM discount_code_vendors WHERE discount_code_id = ${mk.id}::uuid
    `);
    if (targeted.length > 0 && !targeted.some((t) => t.vendor_id === vendorId)) {
      return { ok: false, reason: "not_applicable" };
    }
    return this.validateRow(mk, subtotalCents);
  }

  /** Throwing variant used by checkout — a bad code stops the order. */
  async quoteForCheckout(
    vendorId: string,
    codeRaw: string,
    subtotalCents: number,
  ): Promise<{ id: string; code: string; discountCents: number }> {
    const res = await this.resolve(vendorId, codeRaw, subtotalCents);
    if (!res.ok) {
      throw new BadRequestException({
        message: "That discount code isn't valid for this order.",
        code: "discount_invalid",
        reason: res.reason,
      });
    }
    return { id: res.id, code: res.code, discountCents: res.discountCents };
  }

  /** Increment a code's redemption count (called in the order transaction). */
  async redeem(tx: Prisma.TransactionClient, discountCodeId: string): Promise<void> {
    await tx.$executeRaw(Prisma.sql`
      UPDATE discount_codes SET redemption_count = redemption_count + 1, updated_at = now()
      WHERE id = ${discountCodeId}::uuid
    `);
  }

  private validateRow(row: DiscountRow, subtotalCents: number): DiscountResolution {
    if (!row.active) return { ok: false, reason: "inactive" };
    const now = Date.now();
    if (row.starts_at && new Date(row.starts_at).getTime() > now) {
      return { ok: false, reason: "not_started" };
    }
    if (row.ends_at && new Date(row.ends_at).getTime() < now) {
      return { ok: false, reason: "expired" };
    }
    if (row.max_redemptions != null && row.redemption_count >= row.max_redemptions) {
      return { ok: false, reason: "redemption_limit" };
    }
    if (row.min_subtotal_cents != null && subtotalCents < row.min_subtotal_cents) {
      return { ok: false, reason: "below_minimum" };
    }
    const discountCents = this.computeDiscount(row, subtotalCents);
    if (discountCents <= 0) return { ok: false, reason: "no_discount" };
    return { ok: true, id: row.id, code: row.code, discountCents };
  }

  private computeDiscount(row: DiscountRow, subtotalCents: number): number {
    let raw = 0;
    if (row.discount_type === "PERCENT" && row.value_bps != null) {
      raw = Math.floor((subtotalCents * row.value_bps) / 10_000);
    } else if (row.discount_type === "FIXED" && row.value_cents != null) {
      raw = row.value_cents;
    }
    return Math.max(0, Math.min(raw, subtotalCents)); // never exceed the subtotal
  }
}
