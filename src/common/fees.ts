/**
 * Fee calculations from the configuration table.
 * PRD §6.3.
 */

import type { StorageTier } from "@prisma/client";

import type { PrismaService } from "./prisma.service";

export interface FeeSchedule {
  onboarding: Record<
    StorageTier,
    | { stockingCents: number; firstMonthStorageCents: number; totalCents: number; negotiated?: false }
    | { negotiated: true }
  >;
  monthlyStorage: Record<StorageTier, number | null>;
  fulfillment: { baseCents: number; perAdditionalUnitCents: number };
  returnsHandlingCents: number;
}

export type DeclaredBoxCounts = Partial<Record<StorageTier, number>>;

/**
 * Sum onboarding fees for a declared mix of boxes.
 * Throws if any tier present has `negotiated=true` and no explicit override.
 */
export function computeOnboardingFeeCents(
  schedule: FeeSchedule,
  declared: DeclaredBoxCounts,
): { totalCents: number; perTier: Array<{ tier: StorageTier; count: number; subtotalCents: number }> } {
  const perTier: Array<{ tier: StorageTier; count: number; subtotalCents: number }> = [];
  let totalCents = 0;

  for (const [tier, count] of Object.entries(declared) as Array<[StorageTier, number]>) {
    if (!count || count <= 0) continue;
    const fee = schedule.onboarding[tier];
    if ("negotiated" in fee && fee.negotiated) {
      throw new Error(
        `Tier ${tier} requires a negotiated quote — ask the vendor to contact us before submitting.`,
      );
    }
    const subtotal = (fee as { totalCents: number }).totalCents * count;
    perTier.push({ tier, count, subtotalCents: subtotal });
    totalCents += subtotal;
  }

  return { totalCents, perTier };
}

/** Load the fee schedule from the configuration table. Throws if missing. */
export async function loadFeeSchedule(prisma: PrismaService): Promise<FeeSchedule> {
  const row = await prisma.configuration.findUnique({ where: { key: "fee_schedule" } });
  if (!row) throw new Error("fee_schedule configuration is missing — run prisma:seed.");
  return row.value as unknown as FeeSchedule;
}
