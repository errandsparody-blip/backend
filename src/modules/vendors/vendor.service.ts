/**
 * VendorService — vendor self-management. Strict tenant isolation: every
 * method takes vendorId as the first parameter. Admin operations live on a
 * separate AdminVendorService (P1+) that goes through the assume-vendor flow.
 *
 * Implementation Plan §4.3, §6.1.
 */

import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { KycStatus, Prisma, VendorStatus } from "@prisma/client";

import { loadFeeSchedule, type FeeSchedule } from "../../common/fees";
import { PrismaService } from "../../common/prisma.service";
import type { SubmitKycV2Input } from "../../common/schemas/vendor.schema";
import { AuditService } from "../audit/audit.service";
import { opsNewKycTemplate } from "../email/email-templates";
import { OpsAlertService } from "../notifications/ops-alert.service";

import { AgreementService } from "./agreement.service";

export interface VendorProfile {
  id: string;
  businessName: string;
  country: string;
  kycStatus: KycStatus;
  agreementAcceptedAt: Date | null;
  agreementVersion: string | null;
  /**
   * The version the vendor MUST be on. Read from the `agreement_version`
   * configuration row at request time. The frontend posts this value back
   * when the vendor accepts so the client and server agree on what was
   * signed.
   */
  currentAgreementVersion: string;
  /**
   * True when `agreementAcceptedAt` is set AND the accepted version
   * matches the current published version. Pre-computed here so the
   * frontend doesn't need to know about version comparison logic.
   */
  agreementUpToDate: boolean;
  status: VendorStatus;
  createdAt: Date;

  // Public social presence — surfaced so the vendor can see what they've set
  // and the admin reviewer can verify it. All optional.
  instagramHandle: string | null;
  tiktokHandle: string | null;
  xHandle: string | null;
  websiteUrl: string | null;
  socialVerifiedAt: Date | null;

  /**
   * KYC v2 — structured data captured by the multi-step wizard. Every field
   * is nullable; the wizard pre-fills from whatever the vendor has saved so
   * far. See migration 0030 / the vendor.schema.ts SubmitKycV2Input for
   * the field-level rules.
   */
  kycV2: {
    businessType: string | null;
    businessTypeOther: string | null;
    businessRegistrationNumber: string | null;
    businessRegistrationCountry: string | null;
    businessIndustry: string | null;
    businessIndustryOther: string | null;
    contactFullName: string | null;
    contactPosition: string | null;
    contactPhone: string | null;
    contactAddressLine1: string | null;
    contactAddressLine2: string | null;
    contactCountry: string | null;
    idType: string | null;
    idNumber: string | null;
    idExpirationDate: string | null;
    // KYC v2 Phase 2 — public R2 URLs for the four document uploads
    // collected on the wizard's "Business verification" step (see
    // migration 0032). Null until the vendor uploads each file.
    idFrontUrl: string | null;
    idBackUrl: string | null;
    idSelfieUrl: string | null;
    businessDocUrl: string | null;
    productsStoredDescription: string | null;
    monthlyInventoryVolume: string | null;
    monthlyOrderVolume: string | null;
    primaryShippingCountries: string | null;
    requiresReturnsHandling: boolean | null;
    productHazards: string[];
  };
}

/**
 * Vendor-facing recurring storage snapshot returned by
 * GET /v1/vendors/me/recurring-storage. Money is in cents; dates are ISO.
 *
 * The `perPsn` list attributes monthly cost back to the originating
 * Pre-Shipment Notice so vendors see "PSN-abcd1234 is costing me $X per
 * month." Attribution is proportional — when multiple PSNs contributed to
 * the same SKU bucket (restocks), each PSN's share is its
 * acceptedQty / sum-of-acceptedQty for that bucket.
 */
export interface VendorRecurringStorage {
  vendorId: string;
  /**
   * Total monthly storage cost across ALL active inventory the vendor
   * currently holds, valued at each SKU's tier rate. This is the
   * steady-state recurring cost ("once everything is past its grace
   * period, this is what storage costs you per month") and the
   * answer to "how much am I paying to keep my stuff?".
   *
   * NOT the next-charge amount — under the 30-day rolling cycle each
   * SKU bills on its own anchor date, so a single calendar day's
   * charge can be a subset of this total. See `nextChargeAmountCents`
   * for the very next debit.
   */
  monthlyTotalCents: number;
  /**
   * The next debit amount. Sum of rates for the SKUs whose
   * `nextBillingDate` falls on the next charge date (which itself
   * surfaces as `nextChargeAt`). When the vendor has no inventory
   * past its receiving-fee grace period this is zero.
   */
  nextChargeAmountCents: number;
  /**
   * Back-compat alias for `nextChargeAmountCents`. Older frontend
   * code reads `monthlyEstimateCents` for the same number.
   * @deprecated use `nextChargeAmountCents`.
   */
  monthlyEstimateCents: number;
  /** SKU count sitting in negotiated-rate tiers (e.g. PALLET) — excluded from the dollar totals. */
  negotiatedTierSkuCount: number;
  /** Total active SKUs eligible for billing on the next cron run. */
  activeSkuCount: number;
  /**
   * SKUs that have stock but whose `nextBillingDate` is AFTER the
   * next charge date. Their first 30-day cycle was prepaid via the
   * receiving fee at intake, so they're skipped on the upcoming run
   * and start contributing on the next cycle. Surfaced separately so
   * the vendor sees "yes, you have more inventory than the next
   * charge suggests — the new boxes don't kick in for a bit."
   */
  coveredAtIntakeSkuCount: number;
  /**
   * ISO timestamp of the EARLIEST upcoming charge — i.e. the SKU
   * with the soonest `nextBillingDate`. Under the 30-day cycle this
   * is no longer guaranteed to be the 1st of the month; each SKU
   * carries its own 30-day anchor.
   */
  nextChargeAt: string;
  /**
   * Inventory grouped by the date on which each cohort next bills,
   * itemised by box size. Answers the vendor-facing question: "what
   * am I being charged for, and when does each piece start hitting
   * my account?". There is one group per distinct billing date — so
   * a vendor who's recently received a shipment will typically have
   * two groups (the already-billing cohort and the receiving-fee-
   * covered cohort that starts 30 days from when it was received).
   * Pallet lines carry null rates and are listed for visibility but
   * excluded from the group total.
   */
  upcomingCharges: Array<{
    /** ISO date on which this group's SKUs next bill. */
    startsBilling: string;
    /** Sum of subtotal_cents across lines whose rate is not null. */
    totalCents: number;
    lines: Array<{
      tier: string;
      quantity: number;
      rateCents: number | null;
      subtotalCents: number | null;
    }>;
  }>;
  /**
   * Steady-state inventory grouped by box size across the vendor's
   * full active stock — NOT filtered to "eligible for next charge".
   * This is the answer to "how much is each tier costing me per
   * month?" and resolves the confusion where a recently-received
   * tier didn't show up because its first cycle was still covered
   * by the receiving fee. Each row's subtotal is the long-run
   * monthly cost for that tier.
   */
  perTier: Array<{
    tier: string;
    skuCount: number;
    rateCents: number | null;
    subtotalCents: number | null;
  }>;
  perPsn: Array<{
    psnId: string;
    status: string;
    receivedAt: string | null;
    carrier: string | null;
    masterTracking: string | null;
    declaredBoxCounts: Record<string, number>;
    contributingSkuCount: number;
    contributingTierCounts: Record<string, number>;
    monthlyEstimateCents: number;
    /**
     * Migration 0034 — earliest `nextBillingDate` among this PSN's
     * contributing SKUs. When all contributing SKUs share the same
     * billing date (the common case), this is THAT date. When a PSN
     * filled multiple buckets with different intake months, this is
     * the soonest of those dates — the vendor sees "PSN X first bills
     * on Y" which is the actionable bit. Null when no contributing
     * SKUs survive (rare; shouldn't render in that case anyway).
     */
    firstBillingDate: string | null;
  }>;
  history: Array<{
    id: string;
    amountCents: number;
    balanceAfterCents: number | null;
    description: string;
    createdAt: string;
  }>;
}

@Injectable()
export class VendorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly agreement: AgreementService,
    private readonly opsAlerts: OpsAlertService,
  ) {}

  /**
   * Vendor-facing recurring storage breakdown.
   *
   * Same math as the monthly cron (StorageBillingJob.computeVendorLiability)
   * so what the vendor sees here is what they'll be charged on the 1st.
   * The cron filters on `quantityAvailable > 0`; we widen the filter to
   * include reserved-only buckets so a vendor whose stock is fully
   * promised to in-flight orders still sees their bill — they're still
   * occupying warehouse space.
   *
   * The per-PSN contribution map answers "which PSN brought this
   * inventory?" by grouping accepted SKUs back to their originating
   * PSN line. A single SKU bucket can be the target of multiple PSNs
   * (restocks), so we attribute proportionally by accepted quantity.
   */
  async getRecurringStorage(vendorId: string): Promise<VendorRecurringStorage> {
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
      select: { id: true },
    });
    if (!vendor) throw new NotFoundException();

    const schedule = await this.safelyLoadFees();

    // 30-day rolling cycle model. Each SKU carries its own
    // `nextBillingDate` anchored to the day it was received plus 30
    // days. The vendor sees one or more upcoming charges, each on a
    // specific day, not a single first-of-the-month total.
    const now = new Date();

    // Today at UTC midnight — the threshold the daily cron uses for
    // "due now". Anything with nextBillingDate <= today is overdue
    // and will bill on the next daily run.
    const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    // Pull every active SKU with stock + its nextBillingDate so we can
    // (a) compute steady-state monthly cost across the full inventory
    // and (b) group by the per-SKU billing date for the upcoming
    // charges view.
    const [allActiveSkus, recentStorage, allPsnsForContribution] = await Promise.all([
      this.prisma.sku.findMany({
        where: {
          vendorId,
          status: "ACTIVE",
          OR: [{ quantityAvailable: { gt: 0 } }, { quantityReserved: { gt: 0 } }],
        },
        select: {
          id: true,
          storageTier: true,
          quantityAvailable: true,
          quantityReserved: true,
          nextBillingDate: true,
        },
      }),
      // Last twelve STORAGE ledger entries — the billing history list.
      this.prisma.ledgerEntry.findMany({
        where: { vendorId, type: "STORAGE" },
        orderBy: { createdAt: "desc" },
        take: 12,
        select: {
          id: true,
          amountCents: true,
          balanceAfterCents: true,
          description: true,
          createdAt: true,
        },
      }),
      // Every PSN with received lines. We re-derive contribution at request
      // time so a PSN that was later cancelled or had its lines reversed
      // shows up correctly. Capped at 100 PSNs which is well above the
      // active inventory size for any single vendor in v1 — well past 100
      // the truncation degrades gracefully (we just lose history).
      this.prisma.psn.findMany({
        where: {
          vendorId,
          status: { in: ["RECEIVED", "PARTIALLY_RECEIVED", "DISCREPANCY"] },
        },
        orderBy: { receivedAt: "desc" },
        take: 100,
        select: {
          id: true,
          status: true,
          receivedAt: true,
          declaredBoxCounts: true,
          masterTracking: true,
          carrier: true,
          lines: {
            select: {
              skuId: true,
              acceptedQty: true,
            },
          },
        },
      }),
    ]);

    // Count SKUs still inside their 30-day receiving-fee grace
    // period — surfaced in the headline as "+ N more · first month
    // covered" so the vendor isn't surprised by an inventory count
    // higher than the next charge implies.
    const deferredCount = allActiveSkus.filter((s) => s.nextBillingDate > todayUtc).length;

    // Per-tier breakdown across ALL active inventory (not just due-now).
    // This is the steady-state "what does my storage cost per month
    // when everything is past its grace period" view — the answer to
    // the question "I have a medium box and a large box, why does the
    // tier table only show one?". Deferred SKUs still show up here at
    // their full rate; the upcoming charges section below handles the
    // separate question of WHEN each cohort actually bills.
    const perTierCounts = new Map<string, number>();
    for (const s of allActiveSkus) {
      const tier = String(s.storageTier);
      perTierCounts.set(tier, (perTierCounts.get(tier) ?? 0) + 1);
    }
    const perTier: VendorRecurringStorage["perTier"] = [];
    let monthlyTotalCents = 0;
    let negotiatedTierSkuCount = 0;
    for (const [tier, count] of perTierCounts) {
      const rateCents =
        schedule?.monthlyStorage?.[tier as keyof NonNullable<typeof schedule>["monthlyStorage"]] ??
        null;
      const subtotalCents = rateCents != null ? rateCents * count : null;
      if (subtotalCents != null) monthlyTotalCents += subtotalCents;
      if (rateCents == null) negotiatedTierSkuCount += count;
      perTier.push({ tier, skuCount: count, rateCents, subtotalCents });
    }
    // Sort so the same tier ordering is stable across requests (matters
    // for snapshot tests + a calm UI that doesn't reflow each refresh).
    perTier.sort((a, b) => a.tier.localeCompare(b.tier));

    // Upcoming charges — group every active SKU by its own
    // `nextBillingDate`, then itemise each group by storage tier.
    // This is the receipt-style view the vendor needs: one card per
    // billing date, each holding one line per box size with
    // quantity, rate, and subtotal.
    //
    // Under the 30-day cycle every SKU carries its own anchor date,
    // so each "cohort" naturally groups by received-day. SKUs that
    // are past due (nextBillingDate <= today) all collapse into one
    // group keyed by today's date — they'll bill on tonight's run.
    //
    // Pallet inventory carries a null rate (negotiated per quote);
    // it still appears in its group's lines for visibility but is
    // excluded from the group total.
    const upcomingGroups = new Map<
      string,
      Map<string, { quantity: number; rateCents: number | null }>
    >();
    for (const s of allActiveSkus) {
      // Clamp past-due dates up to today so they group together as
      // "next charge". Future dates keep their own anchor day.
      const billingDate = s.nextBillingDate < todayUtc ? todayUtc : s.nextBillingDate;
      const groupKey = new Date(
        Date.UTC(
          billingDate.getUTCFullYear(),
          billingDate.getUTCMonth(),
          billingDate.getUTCDate(),
        ),
      ).toISOString();
      const tier = String(s.storageTier);
      const rate =
        schedule?.monthlyStorage?.[
          tier as keyof NonNullable<typeof schedule>["monthlyStorage"]
        ] ?? null;
      let tierMap = upcomingGroups.get(groupKey);
      if (!tierMap) {
        tierMap = new Map();
        upcomingGroups.set(groupKey, tierMap);
      }
      const existing = tierMap.get(tier);
      if (existing) {
        existing.quantity += 1;
      } else {
        tierMap.set(tier, { quantity: 1, rateCents: rate });
      }
    }
    const upcomingCharges: VendorRecurringStorage["upcomingCharges"] = [];
    // Stable chronological order by start date so the cards render
    // earliest-first regardless of Map insertion order.
    for (const startsBilling of Array.from(upcomingGroups.keys()).sort()) {
      const tierMap = upcomingGroups.get(startsBilling)!;
      const lines: VendorRecurringStorage["upcomingCharges"][number]["lines"] = [];
      let totalCents = 0;
      // Order lines alphabetically by tier for stable diffs and
      // predictable UI ordering across renders.
      for (const tier of Array.from(tierMap.keys()).sort()) {
        const { quantity, rateCents } = tierMap.get(tier)!;
        const subtotalCents = rateCents != null ? rateCents * quantity : null;
        if (subtotalCents != null) totalCents += subtotalCents;
        lines.push({ tier, quantity, rateCents, subtotalCents });
      }
      upcomingCharges.push({ startsBilling, totalCents, lines });
    }

    // 2. Per-PSN contribution. We need to map each SKU bucket → its monthly
    //    cost (rate per slot, since billing is one row per SKU bucket), then
    //    split that cost across the PSNs that filled the bucket. The cron
    //    treats each SKU row as a single tier-priced slot — so the bucket's
    //    monthly cost is exactly that rate, regardless of qty inside.
    //
    //    Attribution rule: each PSN line gets a share of its bucket's
    //    monthly cost weighted by accepted_qty / sum(accepted_qty for bucket
    //    across all PSNs). Old PSNs whose lines were fully shipped out (qty
    //    is now somewhere else) still appear if there's anything left in
    //    that bucket — the rule attributes by historical contribution to
    //    the bucket, not current ownership.
    //
    //    Returns whole cents per PSN; rounding error totals to ≤ # of
    //    contributing PSNs which is acceptable for a UI estimate.

    // Maps cover ALL active SKUs (eligible + deferred) — the per-PSN
    // attribution loop below needs to look up tier + rate + billing
    // date for every SKU a PSN ever shipped, not just the ones eligible
    // for the next cron run. Otherwise a PSN whose entire contribution
    // is currently deferred would render as "0 SKUs" (wrong).
    const skuToTier = new Map<string, string>();
    const skuToRate = new Map<string, number | null>();
    const skuToBillingDate = new Map<string, Date>();
    for (const s of allActiveSkus) {
      const tier = String(s.storageTier);
      skuToTier.set(s.id, tier);
      const rate =
        schedule?.monthlyStorage?.[
          tier as keyof NonNullable<typeof schedule>["monthlyStorage"]
        ] ?? null;
      skuToRate.set(s.id, rate);
      skuToBillingDate.set(s.id, s.nextBillingDate);
    }

    // sum of acceptedQty per SKU (across all PSN lines we found)
    const skuTotalAccepted = new Map<string, number>();
    for (const p of allPsnsForContribution) {
      for (const line of p.lines) {
        if (!line.skuId || line.acceptedQty <= 0) continue;
        skuTotalAccepted.set(line.skuId, (skuTotalAccepted.get(line.skuId) ?? 0) + line.acceptedQty);
      }
    }

    const perPsn: VendorRecurringStorage["perPsn"] = [];
    for (const p of allPsnsForContribution) {
      let psnMonthlyCents = 0;
      let psnSkuCount = 0;
      const tierCounts: Record<string, number> = {};
      // Earliest nextBillingDate across the contributing SKUs — the
      // "PSN starts billing on" date the vendor sees in the table. Kept
      // as a Date during the loop and serialised once at the end.
      let firstBillingDate: Date | null = null;
      for (const line of p.lines) {
        if (!line.skuId || line.acceptedQty <= 0) continue;
        const rate = skuToRate.get(line.skuId);
        if (rate == null) continue; // bucket is gone (no current stock) or negotiable
        const total = skuTotalAccepted.get(line.skuId) ?? 0;
        if (total <= 0) continue;
        const share = line.acceptedQty / total;
        psnMonthlyCents += Math.round(rate * share);
        psnSkuCount += 1;
        const tier = skuToTier.get(line.skuId);
        if (tier) tierCounts[tier] = (tierCounts[tier] ?? 0) + 1;
        const skuDate = skuToBillingDate.get(line.skuId);
        if (skuDate && (firstBillingDate === null || skuDate < firstBillingDate)) {
          firstBillingDate = skuDate;
        }
      }
      if (psnMonthlyCents === 0 && psnSkuCount === 0) continue;
      perPsn.push({
        psnId: p.id,
        status: String(p.status),
        receivedAt: p.receivedAt?.toISOString() ?? null,
        carrier: p.carrier ?? null,
        masterTracking: p.masterTracking ?? null,
        declaredBoxCounts: (p.declaredBoxCounts ?? {}) as Record<string, number>,
        contributingSkuCount: psnSkuCount,
        contributingTierCounts: tierCounts,
        monthlyEstimateCents: psnMonthlyCents,
        firstBillingDate: firstBillingDate?.toISOString() ?? null,
      });
    }
    perPsn.sort((a, b) => b.monthlyEstimateCents - a.monthlyEstimateCents);

    // Next charge = the earliest upcoming-charges group. If there's
    // no inventory at all, fall back to today as the date with a $0
    // amount — the page renders an empty state in that case.
    const firstUpcoming = upcomingCharges[0];
    const nextChargeAt = (firstUpcoming?.startsBilling ?? todayUtc.toISOString());
    const nextChargeAmountCents = firstUpcoming?.totalCents ?? 0;

    return {
      vendorId,
      // monthlyTotalCents = steady-state recurring cost across all
      // active inventory. monthlyEstimateCents is the legacy alias
      // for nextChargeAmountCents (kept for older clients).
      monthlyTotalCents,
      nextChargeAmountCents,
      monthlyEstimateCents: nextChargeAmountCents,
      negotiatedTierSkuCount,
      activeSkuCount: allActiveSkus.length,
      coveredAtIntakeSkuCount: deferredCount,
      nextChargeAt,
      upcomingCharges,
      perTier,
      perPsn,
      history: recentStorage.map((l) => ({
        id: l.id,
        amountCents: l.amountCents,
        balanceAfterCents: l.balanceAfterCents,
        description: l.description,
        createdAt: l.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Pulling the fee schedule shouldn't poison the recurring view if the
   * configuration row is missing — render whatever we can and let the
   * frontend show "not configured" for the dollar totals.
   */
  private async safelyLoadFees(): Promise<FeeSchedule | null> {
    try {
      return await loadFeeSchedule(this.prisma);
    } catch {
      return null;
    }
  }

  async getProfile(vendorId: string): Promise<VendorProfile> {
    const vendor = await this.prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor) throw new NotFoundException();
    const currentAgreementVersion = await this.agreement.getCurrentVersion();
    const agreementUpToDate =
      vendor.agreementAcceptedAt !== null && vendor.agreementVersion === currentAgreementVersion;
    return {
      id: vendor.id,
      businessName: vendor.businessName,
      country: vendor.country,
      kycStatus: vendor.kycStatus,
      agreementAcceptedAt: vendor.agreementAcceptedAt,
      agreementVersion: vendor.agreementVersion,
      currentAgreementVersion,
      agreementUpToDate,
      status: vendor.status,
      createdAt: vendor.createdAt,
      instagramHandle: vendor.instagramHandle,
      tiktokHandle: vendor.tiktokHandle,
      xHandle: vendor.xHandle,
      websiteUrl: vendor.websiteUrl,
      socialVerifiedAt: vendor.socialVerifiedAt,
      kycV2: {
        businessType: vendor.businessType ?? null,
        businessTypeOther: vendor.businessTypeOther ?? null,
        businessRegistrationNumber: vendor.businessRegistrationNumber ?? null,
        businessRegistrationCountry: vendor.businessRegistrationCountry ?? null,
        businessIndustry: vendor.businessIndustry ?? null,
        businessIndustryOther: vendor.businessIndustryOther ?? null,
        contactFullName: vendor.contactFullName ?? null,
        contactPosition: vendor.contactPosition ?? null,
        contactPhone: vendor.contactPhone ?? null,
        contactAddressLine1: vendor.contactAddressLine1 ?? null,
        contactAddressLine2: vendor.contactAddressLine2 ?? null,
        contactCountry: vendor.contactCountry ?? null,
        idType: vendor.idType ?? null,
        idNumber: vendor.idNumber ?? null,
        // ISO date string for round-tripping with the wizard's <input type="date">.
        idExpirationDate: vendor.idExpirationDate
          ? vendor.idExpirationDate.toISOString().slice(0, 10)
          : null,
        idFrontUrl: vendor.idFrontUrl ?? null,
        idBackUrl: vendor.idBackUrl ?? null,
        idSelfieUrl: vendor.idSelfieUrl ?? null,
        businessDocUrl: vendor.businessDocUrl ?? null,
        productsStoredDescription: vendor.productsStoredDescription ?? null,
        monthlyInventoryVolume: vendor.monthlyInventoryVolume ?? null,
        monthlyOrderVolume: vendor.monthlyOrderVolume ?? null,
        primaryShippingCountries: vendor.primaryShippingCountries ?? null,
        requiresReturnsHandling: vendor.requiresReturnsHandling ?? null,
        productHazards: vendor.productHazards ?? [],
      },
    };
  }

  /**
   * Update the vendor's editable profile fields.
   *
   * Social-handle changes RESET the social verification stamp — once a vendor
   * edits any handle, the admin's previous "I checked, they look real" call
   * is no longer valid against the new profile. The reviewer queue picks the
   * vendor back up automatically.
   */
  async updateProfile(
    vendorId: string,
    actorId: string,
    patch: {
      businessName?: string;
      instagramHandle?: string | null;
      tiktokHandle?: string | null;
      xHandle?: string | null;
      websiteUrl?: string | null;
    },
  ): Promise<VendorProfile> {
    const before = await this.prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!before) throw new NotFoundException();

    const handleChanged =
      (patch.instagramHandle !== undefined && patch.instagramHandle !== before.instagramHandle) ||
      (patch.tiktokHandle !== undefined && patch.tiktokHandle !== before.tiktokHandle) ||
      (patch.xHandle !== undefined && patch.xHandle !== before.xHandle) ||
      (patch.websiteUrl !== undefined && patch.websiteUrl !== before.websiteUrl);

    const updated = await this.prisma.vendor.update({
      where: { id: vendorId },
      data: {
        ...patch,
        // Re-verification required after any social edit.
        ...(handleChanged
          ? { socialVerifiedAt: null, socialVerifiedBy: null }
          : {}),
      },
    });
    await this.audit.log({
      actorId,
      action: "vendor.profile_updated",
      resourceType: "vendor",
      resourceId: vendorId,
      beforeState: {
        businessName: before.businessName,
        instagramHandle: before.instagramHandle,
        tiktokHandle: before.tiktokHandle,
        xHandle: before.xHandle,
        websiteUrl: before.websiteUrl,
      },
      afterState: {
        businessName: updated.businessName,
        instagramHandle: updated.instagramHandle,
        tiktokHandle: updated.tiktokHandle,
        xHandle: updated.xHandle,
        websiteUrl: updated.websiteUrl,
        socialReverificationRequired: handleChanged,
      },
    });
    return this.getProfile(vendorId);
  }

  /**
   * Accept the vendor agreement. Records timestamp + version. Idempotent: if
   * already accepted at the current version, this is a no-op.
   *
   * The frontend must post the version it just displayed to the user. We
   * compare it against the published `agreement_version` config and refuse
   * if they disagree — that means the published terms changed between the
   * page render and the click, and the vendor's "I accept" no longer
   * applies to what we want them to be agreeing to.
   */
  async acceptAgreement(
    vendorId: string,
    actorId: string,
    version: string,
    signatureName?: string,
  ): Promise<VendorProfile> {
    const vendor = await this.prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor) throw new NotFoundException();

    const currentVersion = await this.agreement.getCurrentVersion();
    if (version !== currentVersion) {
      throw new BadRequestException({
        message:
          "The terms changed while this page was open. Reload the agreement and accept the latest version.",
        code: "agreement_version_mismatch",
        currentAgreementVersion: currentVersion,
        postedVersion: version,
      });
    }

    if (vendor.agreementAcceptedAt && vendor.agreementVersion === version) {
      return this.getProfile(vendorId);
    }
    await this.prisma.vendor.update({
      where: { id: vendorId },
      data: {
        agreementAcceptedAt: new Date(),
        agreementVersion: version,
        // Once both KYC + agreement clear, the vendor becomes ACTIVE.
        ...(vendor.kycStatus === KycStatus.APPROVED ? { status: VendorStatus.ACTIVE } : {}),
      },
    });
    await this.audit.log({
      actorId,
      action: "vendor.agreement_accepted",
      resourceType: "vendor",
      resourceId: vendorId,
      // signatureName lands in the audit JSON next to actor + timestamp,
      // forming the e-signature record. Fine to be null for legacy
      // acceptances that predate the typed-name capture.
      afterState: { version, ...(signatureName ? { signatureName } : {}) },
    });
    return this.getProfile(vendorId);
  }

  /**
   * Vendor self-submits their account for KYC review.
   *
   * The expanded KYC v2 form is collected by a multi-step wizard. The wizard
   * calls this endpoint on every "Next" with the running set of fields so
   * partial progress survives a tab close. The FINAL submission is signalled
   * by `submitForReview: true` being present in the input — at that point we:
   *   - stamp `kycSubmittedAt = now()` (never trust a client-supplied
   *     timestamp),
   *   - flip kycStatus PENDING/REQUIRES_RESUBMISSION/EXPIRED → IN_PROGRESS,
   *   - require at least one social handle / business website (still the
   *     reviewer's first-line check), and
   *   - emit the ops alert + audit row so the admin queue picks it up.
   *
   * Partial saves only persist the supplied fields and do NOT change kyc
   * status. Each supplied field overwrites the existing column; legacy
   * vendors without any v2 data are left alone if nothing is supplied.
   */
  async submitKyc(
    vendorId: string,
    actorId: string,
    input: SubmitKycV2Input = {},
  ): Promise<VendorProfile> {
    const vendor = await this.prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor) throw new NotFoundException();

    const isFinalSubmit = input.submitForReview === true;

    if (isFinalSubmit) {
      if (
        vendor.kycStatus !== KycStatus.PENDING &&
        vendor.kycStatus !== KycStatus.REQUIRES_RESUBMISSION &&
        vendor.kycStatus !== KycStatus.EXPIRED
      ) {
        throw new BadRequestException({
          message: "KYC cannot be submitted in the current state.",
          code: "kyc_not_submittable",
        });
      }

      const hasAnyHandle =
        !!vendor.instagramHandle ||
        !!vendor.tiktokHandle ||
        !!vendor.xHandle ||
        !!vendor.websiteUrl;
      if (!hasAnyHandle) {
        throw new BadRequestException({
          message: "Add at least one social handle or your business website before submitting.",
          code: "kyc_needs_social_handles",
        });
      }
    }

    // Build the persisted-fields object. We only set keys whose values are
    // explicitly present in the input — `undefined` means "the wizard didn't
    // surface this step yet, leave the existing column untouched". Empty
    // strings should also not overwrite (they imply "cleared by the form
    // reset"). Booleans and array fields are passed through as-is once
    // they appear in the payload.
    const data: Prisma.VendorUpdateInput = {};
    const assign = <K extends keyof Prisma.VendorUpdateInput>(
      key: K,
      value: Prisma.VendorUpdateInput[K] | undefined,
    ): void => {
      if (value !== undefined) {
        data[key] = value;
      }
    };

    assign("businessType", input.businessType);
    assign("businessTypeOther", input.businessTypeOther);
    assign("businessRegistrationNumber", input.businessRegistrationNumber);
    assign("businessRegistrationCountry", input.businessRegistrationCountry);
    assign("businessIndustry", input.businessIndustry);
    assign("businessIndustryOther", input.businessIndustryOther);

    assign("contactFullName", input.contactFullName);
    assign("contactPosition", input.contactPosition);
    assign("contactPhone", input.contactPhone);
    assign("contactAddressLine1", input.contactAddressLine1);
    assign("contactAddressLine2", input.contactAddressLine2);
    assign("contactCountry", input.contactCountry);

    assign("idType", input.idType);
    assign("idNumber", input.idNumber);
    // Prisma expects a Date for @db.Date columns; Zod gives us an ISO string.
    if (input.idExpirationDate !== undefined) {
      data.idExpirationDate = new Date(`${input.idExpirationDate}T00:00:00.000Z`);
    }

    // Section 4 — Business verification document URLs (migration 0032).
    // The wizard PUTs each file to R2 with a presigned URL and posts the
    // resulting publicUrl back through this endpoint; we just persist it.
    assign("idFrontUrl", input.idFrontUrl);
    assign("idBackUrl", input.idBackUrl);
    assign("idSelfieUrl", input.idSelfieUrl);
    assign("businessDocUrl", input.businessDocUrl);

    assign("productsStoredDescription", input.productsStoredDescription);
    assign("monthlyInventoryVolume", input.monthlyInventoryVolume);
    assign("monthlyOrderVolume", input.monthlyOrderVolume);

    assign("primaryShippingCountries", input.primaryShippingCountries);
    assign("requiresReturnsHandling", input.requiresReturnsHandling);
    if (input.productHazards !== undefined) {
      data.productHazards = { set: input.productHazards };
    }

    // Sections 7 & 8 omitted — no funding-method / billing-email /
    // compliance-signature assignments here.

    if (isFinalSubmit) {
      data.kycStatus = KycStatus.IN_PROGRESS;
      data.kycSubmittedAt = new Date();
      // Clearing the previous reviewer note signals to the admin that this
      // is a fresh submission, not a re-review of the same evidence.
      data.kycRejectionReason = null;
    }

    await this.prisma.vendor.update({
      where: { id: vendorId },
      data,
    });

    await this.audit.log({
      actorId,
      action: isFinalSubmit ? "vendor.kyc_v2_submitted" : "vendor.kyc_v2_progress_saved",
      resourceType: "vendor",
      resourceId: vendorId,
      beforeState: { kycStatus: vendor.kycStatus },
      // Don't echo the entire payload — it contains contact PII / id numbers.
      // Log the field keys that were touched so the audit log shows the
      // shape of the change without recording the values themselves.
      afterState: {
        kycStatus: isFinalSubmit ? KycStatus.IN_PROGRESS : vendor.kycStatus,
        fieldsTouched: Object.keys(data),
        finalSubmit: isFinalSubmit,
      },
    });

    if (!isFinalSubmit) {
      // Partial save — return the refreshed profile, don't fire the ops alert.
      return this.getProfile(vendorId);
    }

    // Ops alert — admin team needs to know to review.
    const ops = opsNewKycTemplate({
      vendorId,
      vendorBusinessName: vendor.businessName,
    });
    void this.opsAlerts
      .send({
        // Type is `ops.vendor.kyc_submitted` (not `ops.kyc.*`) so that
        // after the in-app fanout strips the `ops.` prefix, the leading
        // segment is `vendor` and the notification buckets into the
        // admin sidebar's "Vendors" tab badge. A bare `kyc` category
        // would have no matching tab.
        type: "ops.vendor.kyc_submitted",
        subject: ops.subject,
        html: ops.html,
        text: ops.text,
        // Re-submissions should re-alert; key includes the kycSubmittedAt
        // timestamp so each fresh submission produces a distinct dedupe key.
        idempotencyKey: `ops:kyc:${vendorId}:${Date.now()}`,
        // Admin click → vendor detail page with the KYC review actions.
        href: `/admin/vendors/${vendorId}`,
        severity: "WARNING",
      })
      .catch(() => undefined);

    return this.getProfile(vendorId);
  }

  /**
   * Mark the vendor's KYC status. Called by the KYC webhook handler (P1.6).
   * Activates the vendor if the agreement is also signed.
   */
  async setKycStatus(vendorId: string, status: KycStatus, providerId: string | null): Promise<void> {
    const vendor = await this.prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor) throw new NotFoundException();

    const now = new Date();
    const becomingActive =
      status === KycStatus.APPROVED && vendor.agreementAcceptedAt !== null;

    await this.prisma.vendor.update({
      where: { id: vendorId },
      data: {
        kycStatus: status,
        kycProviderId: providerId ?? vendor.kycProviderId,
        kycSubmittedAt: vendor.kycSubmittedAt ?? (status === KycStatus.IN_PROGRESS ? now : null),
        kycApprovedAt: status === KycStatus.APPROVED ? now : vendor.kycApprovedAt,
        ...(becomingActive ? { status: VendorStatus.ACTIVE } : {}),
        ...(status === KycStatus.REJECTED ? { status: VendorStatus.SUSPENDED } : {}),
      },
    });

    await this.audit.log({
      action: "vendor.kyc_status_changed",
      resourceType: "vendor",
      resourceId: vendorId,
      beforeState: { kycStatus: vendor.kycStatus },
      afterState: { kycStatus: status, providerId },
    });
  }
}
