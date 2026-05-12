/**
 * VendorService — vendor self-management. Strict tenant isolation: every
 * method takes vendorId as the first parameter. Admin operations live on a
 * separate AdminVendorService (P1+) that goes through the assume-vendor flow.
 *
 * Implementation Plan §4.3, §6.1.
 */

import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { KycStatus, VendorStatus } from "@prisma/client";

import { loadFeeSchedule, type FeeSchedule } from "../../common/fees";
import { PrismaService } from "../../common/prisma.service";
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
  /** Sum of rate × count across all tiers with a configured rate. */
  monthlyEstimateCents: number;
  /** SKU count sitting in negotiated tiers (e.g. PALLET) — excluded from the dollar total. */
  negotiatedTierSkuCount: number;
  /** Total active SKUs (whether or not they have a configured rate). */
  activeSkuCount: number;
  /** ISO timestamp of the next storage charge (1st of next month, 02:00 UTC). */
  nextChargeAt: string;
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

    const [tierAgg, skus, recentStorage, allPsnsForContribution] = await Promise.all([
      // Per-tier current SKU count — the canonical input to the monthly bill.
      this.prisma.sku.groupBy({
        by: ["storageTier"],
        where: {
          vendorId,
          status: "ACTIVE",
          OR: [{ quantityAvailable: { gt: 0 } }, { quantityReserved: { gt: 0 } }],
        },
        _count: { _all: true },
      }),
      // Per-SKU snapshot so the per-PSN contribution view can attribute
      // monthly cost to the PSN(s) that filled the bucket. Limited to
      // active buckets with stock so we don't query everything ever.
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

    // 1. Per-tier monthly estimate.
    const perTier: VendorRecurringStorage["perTier"] = [];
    let monthlyEstimateCents = 0;
    let negotiatedTierSkuCount = 0;
    for (const row of tierAgg) {
      const tier = row.storageTier;
      const count = row._count._all;
      const rateCents = schedule?.monthlyStorage?.[tier] ?? null;
      const subtotalCents = rateCents != null ? rateCents * count : null;
      if (subtotalCents != null) monthlyEstimateCents += subtotalCents;
      if (rateCents == null) negotiatedTierSkuCount += count;
      perTier.push({
        tier: String(tier),
        skuCount: count,
        rateCents,
        subtotalCents,
      });
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

    const skuToTier = new Map<string, string>();
    for (const s of skus) {
      skuToTier.set(s.id, String(s.storageTier));
    }

    /** rateCents per active SKU bucket */
    const skuToRate = new Map<string, number | null>();
    for (const s of skus) {
      const tier = String(s.storageTier);
      const rate = schedule?.monthlyStorage?.[s.storageTier] ?? null;
      // Cast through string lookup because StorageTier enum values are
      // exactly what we used as keys in monthlyStorage.
      void tier;
      skuToRate.set(s.id, rate);
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
      });
    }
    perPsn.sort((a, b) => b.monthlyEstimateCents - a.monthlyEstimateCents);

    // 3. Next charge date — the 1st of next month at 02:00 UTC, matching the cron.
    const now = new Date();
    const nextCharge = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 2, 0, 0));

    return {
      vendorId,
      monthlyEstimateCents,
      negotiatedTierSkuCount,
      activeSkuCount: skus.length,
      nextChargeAt: nextCharge.toISOString(),
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
   * Pre-conditions:
   *   - Current kycStatus is PENDING or REQUIRES_RESUBMISSION (the only states
   *     from which a vendor can submit for review). APPROVED vendors stay
   *     approved; REJECTED vendors must contact support.
   *   - At least one social handle is provided. Without any web presence the
   *     reviewer has nothing to verify.
   *
   * Result: kycStatus → IN_PROGRESS, kycSubmittedAt set, audit entry written.
   * The admin queue picks it up automatically.
   */
  async submitKyc(vendorId: string, actorId: string): Promise<VendorProfile> {
    const vendor = await this.prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor) throw new NotFoundException();

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

    await this.prisma.vendor.update({
      where: { id: vendorId },
      data: {
        kycStatus: KycStatus.IN_PROGRESS,
        kycSubmittedAt: new Date(),
        // Clearing the previous reviewer note signals to the admin that this
        // is a fresh submission, not a re-review of the same evidence.
        kycRejectionReason: null,
      },
    });

    await this.audit.log({
      actorId,
      action: "vendor.kyc_submitted",
      resourceType: "vendor",
      resourceId: vendorId,
      beforeState: { kycStatus: vendor.kycStatus },
      afterState: { kycStatus: KycStatus.IN_PROGRESS },
    });

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
