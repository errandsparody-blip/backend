/**
 * Vendor flat-fee pricing reader — USA + Canada (migration 0080).
 *
 * Returns a vendor's negotiated flat-rate fulfillment config for feeding into
 * computeOrderFees. Reads via raw SQL so it works against the stale generated
 * Prisma client (the columns are regenerated on deploy). Disabled / absent →
 * undefined, so the caller falls back to the default fee schedule.
 */

import { Prisma } from "@prisma/client";

import type { PrismaService } from "./prisma.service";

export interface VendorFlatFee {
  enabled: boolean;
  feeCents: number;
  maxUnits: number;
}

export async function readVendorFlatFee(
  prisma: PrismaService,
  vendorId: string,
): Promise<VendorFlatFee | undefined> {
  const rows = await prisma.$queryRaw<
    Array<{ flat_fee_enabled: boolean; flat_fee_cents: number; flat_fee_max_units: number }>
  >(Prisma.sql`
    SELECT flat_fee_enabled, flat_fee_cents, flat_fee_max_units
    FROM vendors WHERE id = ${vendorId}::uuid
  `);
  const row = rows[0];
  if (!row || !row.flat_fee_enabled) return undefined;
  return {
    enabled: true,
    feeCents: Number(row.flat_fee_cents),
    maxUnits: Number(row.flat_fee_max_units),
  };
}
