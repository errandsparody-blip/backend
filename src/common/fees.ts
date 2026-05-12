/**
 * Fee calculations from the configuration table.
 * PRD §6.3.
 */

import { BadRequestException, InternalServerErrorException } from "@nestjs/common";
import type { StorageTier } from "@prisma/client";

import type { PrismaService } from "./prisma.service";

/**
 * Thrown when a declared tier needs a manual quote that hasn't been
 * configured yet. NestJS maps this to 400 + the stable code so the
 * frontend can render actionable copy.
 */
export class NegotiatedTierError extends BadRequestException {
  constructor(public readonly tier: StorageTier) {
    super({
      message: `${tier} pallets are priced per-quote. Contact support to set up a rate before submitting.`,
      code: "psn_negotiated_tier",
      tier,
    });
  }
}

/**
 * Thrown when the fee schedule row is missing a tier that the vendor has
 * declared. This is an operational gap — usually a stale seed in prod
 * that predates a tier being added — and not the vendor's fault. We
 * surface a 500 with a stable code so it lights up in Sentry distinctly
 * from "real" 500s, but the user-facing message tells them the same
 * thing as the negotiated case (contact support).
 *
 * Without this, the function would `"negotiated" in undefined` and throw
 * a raw TypeError, which became a generic 500 on the wire.
 */
export class MissingTierFeeError extends InternalServerErrorException {
  constructor(public readonly tier: StorageTier) {
    super({
      message: `${tier} fee is not configured on this environment. Contact support to set up a rate before submitting.`,
      code: "psn_tier_misconfigured",
      tier,
    });
  }
}

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
 *
 * Two modes, distinguished by whether the vendor declared any pallets:
 *
 *   LOOSE MODE (declared.PALLET is 0 or absent)
 *     Each box contributes stocking + first-month storage (the full
 *     `totalCents` from the schedule). Monthly storage rolls per-SKU
 *     starting on the 1st.
 *
 *   PALLET MODE (declared.PALLET >= 1)
 *     Each box on a pallet contributes ONLY its stocking fee — the
 *     pallet's $45/month covers storage going forward, so charging
 *     per-box first-month storage on top would double-bill. PALLET
 *     itself contributes its monthly-storage rate × pallet count as
 *     the pallet's first-month charge (the "first month included in
 *     onboarding" pattern, just at the pallet rate). PALLET stays in
 *     `schedule.onboarding` as `{ negotiated: true }` so we read the
 *     storage figure from `schedule.monthlyStorage.PALLET` instead.
 *
 * Throws NegotiatedTierError (400, code = `psn_negotiated_tier`) for
 * non-PALLET tiers that are marked negotiated — those still need a
 * manual quote regardless of mode.
 */
export function computeOnboardingFeeCents(
  schedule: FeeSchedule,
  declared: DeclaredBoxCounts,
): { totalCents: number; perTier: Array<{ tier: StorageTier; count: number; subtotalCents: number }> } {
  const perTier: Array<{ tier: StorageTier; count: number; subtotalCents: number }> = [];
  let totalCents = 0;

  const palletCount = Math.max(0, Number(declared.PALLET ?? 0));
  const isPalletMode = palletCount > 0;

  for (const [tier, count] of Object.entries(declared) as Array<[StorageTier, number]>) {
    if (!count || count <= 0) continue;

    // PALLET tier — only charged in pallet mode (loose mode shouldn't
    // include it; if it does, that's a misuse and we ignore it). The
    // pallet's first-month storage uses the monthly rate from the
    // schedule's monthlyStorage table, NOT the onboarding table (which
    // keeps PALLET as `negotiated` so the box loop below doesn't try
    // to read totalCents off it).
    if (tier === "PALLET") {
      if (!isPalletMode) continue;
      const palletFirstMonth = schedule.monthlyStorage?.PALLET;
      if (typeof palletFirstMonth !== "number" || !Number.isFinite(palletFirstMonth)) {
        // PALLET monthly rate isn't configured. Fall back to surfacing
        // the tier as negotiated so finance is forced to set the rate
        // before vendors can submit pallet PSNs.
        throw new NegotiatedTierError(tier);
      }
      const subtotal = palletFirstMonth * count;
      perTier.push({ tier, count, subtotalCents: subtotal });
      totalCents += subtotal;
      continue;
    }

    // Box tiers (SMALL / MEDIUM / LARGE / X_LARGE).
    const fee = schedule.onboarding[tier];
    // Defensive: if the schedule was seeded before this tier existed, `fee`
    // is undefined. `"negotiated" in undefined` would throw a raw TypeError
    // and surface as a generic 500. Convert it to a structured exception so
    // the frontend can render a helpful banner and Sentry can tag it.
    if (!fee) {
      throw new MissingTierFeeError(tier);
    }
    if ("negotiated" in fee && fee.negotiated) {
      throw new NegotiatedTierError(tier);
    }

    if (isPalletMode) {
      // Stocking only — the pallet's monthly storage covers the rest.
      const stocking = (fee as { stockingCents?: number }).stockingCents;
      if (typeof stocking !== "number" || !Number.isFinite(stocking)) {
        throw new MissingTierFeeError(tier);
      }
      const subtotal = stocking * count;
      perTier.push({ tier, count, subtotalCents: subtotal });
      totalCents += subtotal;
    } else {
      // Loose mode — full stocking + first-month storage per box.
      const totalCentsForTier = (fee as { totalCents?: number }).totalCents;
      if (typeof totalCentsForTier !== "number" || !Number.isFinite(totalCentsForTier)) {
        // Same defence as above: an inconsistent config row should produce
        // a structured response, not a NaN that propagates into the ledger.
        throw new MissingTierFeeError(tier);
      }
      const subtotal = totalCentsForTier * count;
      perTier.push({ tier, count, subtotalCents: subtotal });
      totalCents += subtotal;
    }
  }

  return { totalCents, perTier };
}

/**
 * Load the fee schedule from the configuration table.
 *
 * Throws an InternalServerErrorException with a stable code when the row
 * is missing. The plain `Error` that lived here previously would surface
 * as a generic 500 with no code, which the catch-all wrapped as
 * "An unexpected error occurred." The structured form lets the frontend
 * catalog render a meaningful banner and Sentry tags the gap distinctly
 * from runtime crashes.
 */
export async function loadFeeSchedule(prisma: PrismaService): Promise<FeeSchedule> {
  const row = await prisma.configuration.findUnique({ where: { key: "fee_schedule" } });
  if (!row) {
    throw new InternalServerErrorException({
      message:
        "Fee schedule is not configured on this environment. Contact support before submitting.",
      code: "fee_schedule_missing",
    });
  }
  return row.value as unknown as FeeSchedule;
}
