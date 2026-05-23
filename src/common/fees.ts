/**
 * Fee calculations from the configuration table.
 * PRD §6.3.
 */

import { BadRequestException, InternalServerErrorException } from "@nestjs/common";
import type { ShippingMode, StorageTier } from "@prisma/client";

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
 * Thrown when a PSN declaration is inconsistent with its shipping mode
 * (e.g. PALLET mode with no PALLET tier, ADD_TO_PALLET with multiple
 * box tiers, or ADD_TO_PALLET with a PALLET tier). These shouldn't be
 * reachable from a well-behaved client — the frontend gates each mode's
 * inputs — but the server validates explicitly so a malformed POST or
 * a future client bug surfaces with a structured 400 instead of silently
 * producing the wrong charge.
 */
export class InvalidShippingDeclarationError extends BadRequestException {
  constructor(message: string) {
    super({ message, code: "psn_invalid_shipping_declaration" });
  }
}

/**
 * Sum onboarding fees for a declared mix of boxes under an explicit
 * shipping mode. The mode used to be inferred from `declared.PALLET > 0`
 * but ADD_TO_PALLET ships with the same shape as LOOSE (box tiers, no
 * PALLET key), so the mode is now passed in explicitly. See migration
 * 0033 for the full history.
 *
 *   LOOSE
 *     Each box contributes stocking + first-month storage (the full
 *     `totalCents` from the schedule). Monthly storage rolls per-SKU
 *     starting on the 1st. PALLET tier in the declaration is rejected
 *     as an inconsistent declaration (use PALLET mode for that).
 *
 *   PALLET
 *     Each box on a pallet contributes ONLY its stocking fee — the
 *     pallet's monthly $45 covers storage going forward, so charging
 *     per-box first-month storage on top would double-bill. PALLET
 *     itself contributes its monthly-storage rate × pallet count as
 *     the pallet's first-month charge. Must declare at least 1 PALLET
 *     and at least 1 box tier.
 *
 *   ADD_TO_PALLET
 *     Vendor is shipping boxes onto an existing pallet they already
 *     have at the warehouse. Each box pays stocking only — no new
 *     pallet line, no per-box first-month storage. The existing
 *     pallet's $45/mo continues to cover storage. Must declare EXACTLY
 *     ONE box tier (pallets are uniform-tier per policy) and zero
 *     PALLET tier (no new pallet is being created). Capacity + tier
 *     match are confirmed off-platform with admin; admin rejects at
 *     receive if the boxes don't fit / don't match the existing pallet.
 *
 * Throws NegotiatedTierError (400) for non-PALLET tiers marked negotiated
 * and InvalidShippingDeclarationError (400) for mode/declaration mismatches.
 */
export function computeOnboardingFeeCents(
  schedule: FeeSchedule,
  declared: DeclaredBoxCounts,
  mode: ShippingMode,
): { totalCents: number; perTier: Array<{ tier: StorageTier; count: number; subtotalCents: number }> } {
  const perTier: Array<{ tier: StorageTier; count: number; subtotalCents: number }> = [];
  let totalCents = 0;

  const palletCount = Math.max(0, Number(declared.PALLET ?? 0));
  const boxTiersDeclared = (Object.entries(declared) as Array<[StorageTier, number]>).filter(
    ([t, c]) => t !== "PALLET" && Number(c) > 0,
  );

  // Mode-specific declaration validation. Each branch enforces the shape
  // it expects so an inconsistent POST fails fast with a stable code
  // rather than producing a silently-wrong total.
  if (mode === "PALLET" && palletCount === 0) {
    throw new InvalidShippingDeclarationError(
      "PALLET mode requires at least 1 pallet in the declaration.",
    );
  }
  if (mode === "LOOSE" && palletCount > 0) {
    throw new InvalidShippingDeclarationError(
      "LOOSE mode cannot include a PALLET tier — switch to PALLET mode to create a pallet.",
    );
  }
  if (mode === "ADD_TO_PALLET") {
    if (palletCount > 0) {
      throw new InvalidShippingDeclarationError(
        "ADD_TO_PALLET mode cannot create a new pallet — remove the PALLET tier from the declaration.",
      );
    }
    if (boxTiersDeclared.length === 0) {
      throw new InvalidShippingDeclarationError(
        "ADD_TO_PALLET mode requires exactly one box tier with a positive count.",
      );
    }
    if (boxTiersDeclared.length > 1) {
      throw new InvalidShippingDeclarationError(
        "ADD_TO_PALLET mode requires exactly one box tier — pallets are uniform-tier per policy.",
      );
    }
  }

  const isPalletMode = mode === "PALLET";
  const isAddToPalletMode = mode === "ADD_TO_PALLET";

  for (const [tier, count] of Object.entries(declared) as Array<[StorageTier, number]>) {
    if (!count || count <= 0) continue;

    // PALLET tier — only the PALLET mode creates a new pallet, which is
    // billed at the monthly-storage rate (the "first month included in
    // onboarding" pattern). LOOSE and ADD_TO_PALLET both rejected any
    // PALLET tier above, so by the time we get here in those modes the
    // count is guaranteed zero and we never enter this branch.
    if (tier === "PALLET") {
      if (!isPalletMode) continue; // belt-and-braces — should be unreachable
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

    if (isPalletMode || isAddToPalletMode) {
      // Stocking only — either the new pallet's monthly $45 (PALLET mode)
      // or the existing pallet's already-billed $45/mo (ADD_TO_PALLET mode)
      // covers storage for these boxes. Charging per-box first-month
      // storage on top would double-bill the vendor.
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
