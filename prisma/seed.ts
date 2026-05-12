/**
 * Seed configuration values from PRD v1.3 §6.3.
 * Idempotent — safe to re-run.
 *
 *   pnpm prisma:seed
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const FEE_SCHEDULE = {
  // PRD §6.3.1 — onboarding fee = stocking + first month storage
  onboarding: {
    SMALL: { stockingCents: 2500, firstMonthStorageCents: 900, totalCents: 3400 },
    MEDIUM: { stockingCents: 4000, firstMonthStorageCents: 1500, totalCents: 5500 },
    LARGE: { stockingCents: 6000, firstMonthStorageCents: 2500, totalCents: 8500 },
    X_LARGE: { stockingCents: 9000, firstMonthStorageCents: 3000, totalCents: 12000 },
    PALLET: { negotiated: true },
  },
  // PRD §6.3.2 — monthly storage
  monthlyStorage: {
    SMALL: 900,
    MEDIUM: 1500,
    LARGE: 2500,
    X_LARGE: 3000,
    PALLET: null,
  },
  // PRD §6.3.3
  fulfillment: {
    baseCents: 299,
    perAdditionalUnitCents: 99,
  },
  // PRD §6.3.4
  returnsHandlingCents: 600,
};

const TIER_DIMENSIONS = {
  // Inches × inches × inches (L × W × H), max weight in oz.
  // Anchored to common 3PL standards. Adjust before launch — PRD §14.1 open item.
  SMALL: { lengthIn: 12, widthIn: 9, heightIn: 4, maxWeightOz: 80 },
  MEDIUM: { lengthIn: 14, widthIn: 11, heightIn: 6, maxWeightOz: 240 },
  LARGE: { lengthIn: 18, widthIn: 14, heightIn: 10, maxWeightOz: 480 },
  X_LARGE: { lengthIn: 24, widthIn: 18, heightIn: 14, maxWeightOz: 960 },
};

const REPACKAGING_FEES = {
  // PRD §14.1 — TBD anchors. Confirm before launch.
  SMALL: 800,
  MEDIUM: 1200,
  LARGE: 1800,
  X_LARGE: 2400,
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
  await upsertConfig("fee_schedule", FEE_SCHEDULE, "PRD §6.3 — onboarding, storage, fulfillment, returns.");
  await upsertConfig("tier_dimensions", TIER_DIMENSIONS, "Standardized inbound box dimensions per tier.");
  await upsertConfig("repackaging_fees", REPACKAGING_FEES, "Per-tier repackaging fees for non-standard inbound packaging.");
  await upsertConfig("quarantine_daily_fee_cents", QUARANTINE_DAILY_FEE_CENTS, "Daily fee for the 14-day Hold disposition.");
  // 1.1 — May 2026 refresh: tightened storage-tier audit language, abandoned
  // inventory window clarified, and acceptance-trail wording aligned with the
  // production sign-up UX. Bump again any time the legal text materially
  // changes so the AgreementVersionGuard forces every active vendor to
  // re-accept on their next write.
  await upsertConfig("agreement_version", "1.1", "Current Vendor Agreement version users must accept.");
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
