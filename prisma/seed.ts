/**
 * Seed configuration values from PRD v1.3 §6.3.
 * Idempotent — safe to re-run.
 *
 *   pnpm prisma:seed
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// =============================================================================
// FEE_SCHEDULE — published "Per-Box & Pallet Storage Pricing" guide (May 2026
// refresh). Numbers must match the marketing /pricing page and the
// storage-tier guide modal verbatim; any change here MUST be mirrored in
// both surfaces (FALLBACK_TIERS in src/lib/storage-tiers.ts on the web side,
// and the marketing page itself).
//
// PALLET keeps `negotiated: true` for onboarding because the policy says
// per-box stocking + first-month fees still apply for every box ON a
// pallet — i.e. there's no separate "pallet onboarding" charge to compute
// in isolation. The PALLET tier on the PSN form represents the SHIPPING
// container; the boxes inside it carry their own tier's onboarding fees.
//
// Monthly storage for PALLET IS a real number now ($45) — billed per
// pallet-slot occupied. The storage-billing cron applies it just like any
// other tier rate.
// =============================================================================
const FEE_SCHEDULE = {
  onboarding: {
    SMALL: { stockingCents: 1200, firstMonthStorageCents: 900, totalCents: 2100 },
    MEDIUM: { stockingCents: 2200, firstMonthStorageCents: 1400, totalCents: 3600 },
    LARGE: { stockingCents: 4000, firstMonthStorageCents: 1800, totalCents: 5800 },
    X_LARGE: { stockingCents: 6000, firstMonthStorageCents: 2500, totalCents: 8500 },
    // Per-box fees apply to boxes on the pallet, not the pallet itself.
    // Declaring PALLET on a PSN without an accompanying box tier currently
    // triggers a 400 with code `psn_negotiated_tier` — that's the right
    // behaviour: the vendor must specify what tier of boxes is on the pallet.
    PALLET: { negotiated: true },
  },
  monthlyStorage: {
    SMALL: 900,
    MEDIUM: 1400,
    LARGE: 1800,
    X_LARGE: 2500,
    // Standard 40×48 pallet, up to 60 inches stacked. ~66.7 ft³ of
    // low-touch storage. Mixed-tier pallets are prohibited (see policy).
    PALLET: 4500,
  },
  fulfillment: {
    baseCents: 299,
    perAdditionalUnitCents: 99,
  },
  returnsHandlingCents: 600,
};

// Inches × inches × inches (L × W × H). maxWeightOz is an internal heuristic
// used by the product-form's auto-suggest — not part of the published guide.
// The guide quotes dimensions only; weight caps are USA Errands-internal
// stack-stability guardrails.
const TIER_DIMENSIONS = {
  SMALL: { lengthIn: 16, widthIn: 12, heightIn: 12, maxWeightOz: 480 },
  MEDIUM: { lengthIn: 18, widthIn: 18, heightIn: 16, maxWeightOz: 800 },
  LARGE: { lengthIn: 18, widthIn: 18, heightIn: 24, maxWeightOz: 1280 },
  X_LARGE: { lengthIn: 24, widthIn: 18, heightIn: 24, maxWeightOz: 1920 },
  // Standard U.S. pallet — 40×48 base × 60 in stacked height. Quoted in
  // the marketing page; renders in the storage-tier guide modal too.
  PALLET: { lengthIn: 48, widthIn: 40, heightIn: 60, maxWeightOz: 24000 },
};

const REPACKAGING_FEES = {
  // Anchored to the new stocking fees — repackaging is roughly two-thirds
  // of stocking since the labor profile is similar (unbox, repack, label).
  SMALL: 800,
  MEDIUM: 1500,
  LARGE: 2700,
  X_LARGE: 4000,
};

// =============================================================================
// Pallet policy — surfaced in the storage-tier guide modal and used by the
// PSN-create flow to render the "max boxes per pallet" hint. The numbers
// are the published "approximate maximum quantity of boxes per pallet"
// from the pricing guide; actual allowable quantities vary per the
// stack-stability rules in the policy text.
//
// `mixedTiersAllowed: false` encodes the rule that all boxes on a single
// pallet must be the same tier. We don't enforce this in the DB; the PSN
// schema doesn't tie boxes to specific pallets. The frontend reads this
// flag and renders an explicit warning when a vendor declares PALLET
// alongside a heterogeneous box mix on the same PSN.
// =============================================================================
const PALLET_POLICY = {
  mixedTiersAllowed: false,
  maxBoxesPerPallet: {
    SMALL: 50,
    MEDIUM: 12,
    LARGE: 8,
    X_LARGE: 8,
  },
};

const QUARANTINE_DAILY_FEE_CENTS = 200;

async function upsertConfig(key: string, value: unknown, description: string): Promise<void> {
  await prisma.configuration.upsert({
    where: { key },
    update: { value: value as object, description },
    create: { key, value: value as object, description },
  });
}

async function main(): Promise<void> {
  await upsertConfig("fee_schedule", FEE_SCHEDULE, "Published storage tier + pallet pricing (May 2026 refresh).");
  await upsertConfig("tier_dimensions", TIER_DIMENSIONS, "Standardized inbound box + pallet dimensions per tier.");
  await upsertConfig("repackaging_fees", REPACKAGING_FEES, "Per-tier repackaging fees for non-standard inbound packaging.");
  await upsertConfig("quarantine_daily_fee_cents", QUARANTINE_DAILY_FEE_CENTS, "Daily fee for the 14-day Hold disposition.");
  await upsertConfig(
    "pallet_policy",
    PALLET_POLICY,
    "Pallet rules — uniform tier per pallet + approximate maximum box counts per pallet.",
  );
  // 1.1 — May 2026 refresh: tightened storage-tier audit language, abandoned
  // inventory window clarified, and acceptance-trail wording aligned with the
  // production sign-up UX. Bump again any time the legal text materially
  // changes so the AgreementVersionGuard forces every active vendor to
  // re-accept on their next write.
  await upsertConfig("agreement_version", "1.2", "Current Vendor Agreement version users must accept.");
  await upsertConfig(
    "reassessment_threshold",
    { utilizationPctMax: 80, consecutiveDaysMin: 60, autoApplyAfterDays: 14 },
    "PRD §6.3.5 — quarterly downsize trigger.",
  );

  // eslint-disable-next-line no-console
  console.warn("[seed] configuration seeded.");
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
