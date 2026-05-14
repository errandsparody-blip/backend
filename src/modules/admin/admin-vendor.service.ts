/**
 * AdminVendorService — vendor lifecycle operations performed by USA Errands
 * staff (KYC review, manual social verification). Every state-changing method
 * writes an audit entry and emits a notification + email to the vendor.
 *
 * KYC state machine (matches the Prisma KycStatus enum):
 *
 *   PENDING               → IN_PROGRESS / REQUIRES_RESUBMISSION / REJECTED / APPROVED
 *   IN_PROGRESS           → APPROVED / REJECTED / REQUIRES_RESUBMISSION
 *   REQUIRES_RESUBMISSION → APPROVED / REJECTED / REQUIRES_RESUBMISSION
 *   APPROVED              → REJECTED   (only — admin can suspend later)
 *   REJECTED              → APPROVED   (admin re-review only)
 *   EXPIRED               → REQUIRES_RESUBMISSION
 *
 * Vendor.status mirrors the terminal state: APPROVED + agreement-accepted
 * promotes to ACTIVE, REJECTED demotes to SUSPENDED.
 *
 * Two reviewers required for any change to this file (Implementation Plan §17.1).
 */

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { KycStatus, VendorStatus } from "@prisma/client";

import { loadFeeSchedule, type FeeSchedule } from "../../common/fees";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../audit/audit.service";
import {
  kycApprovedTemplate,
  kycRejectedTemplate,
  kycResubmissionTemplate,
} from "../email/email-templates";
import { NotificationService } from "../notifications/notification.service";

interface ActorContext {
  /** Admin user id performing the action. Required for audit. */
  actorId: string;
  /** Optional admin-only note attached to the audit entry. Never emailed. */
  notes?: string;
}

/**
 * Aggregated operational view of a vendor — returned by
 * GET /admin/vendors/:id/overview. Every money field is in CENTS so the
 * frontend formats once. Counts are total / by-status so the dashboard
 * cards can render without re-summing arrays on the wire.
 */
export interface VendorOverview {
  vendorId: string;
  psns: {
    total: number;
    byStatus: Record<string, number>;
    recent: Array<{
      id: string;
      status: string;
      carrier: string | null;
      masterTracking: string | null;
      declaredBoxCounts: Record<string, number>;
      onboardingFeeCents: number | null;
      submittedAt: string | null;
      receivedAt: string | null;
      createdAt: string;
    }>;
  };
  orders: {
    total: number;
    byStatus: Record<string, number>;
    lifetimeRevenueCents: number;
    recent: Array<{
      id: string;
      orderNumber: number;
      externalReference: string | null;
      status: string;
      recipientName: string;
      destination: string;
      carrier: string | null;
      trackingNumber: string | null;
      totalChargedCents: number;
      submittedAt: string | null;
      shippedAt: string | null;
      deliveredAt: string | null;
      createdAt: string;
    }>;
  };
  returns: {
    total: number;
    byStatus: Record<string, number>;
    recent: Array<{
      id: string;
      status: string;
      reason: string | null;
      handlingFeeCents: number | null;
      totalRefundCents: number | null;
      createdAt: string;
      inspectedAt: string | null;
    }>;
  };
  inventory: {
    activeSkus: number;
    perTier: Array<{
      tier: string;
      skuCount: number;
      rateCents: number | null;
      subtotalCents: number | null;
    }>;
  };
  recurringStorage: {
    /** Sum of (rate × sku-count) across all tiers with a configured rate. */
    monthlyEstimateCents: number;
    /** SKU count sitting in a negotiated-tier bucket (e.g. PALLET). */
    negotiatedTierSkuCount: number;
    perTier: Array<{
      tier: string;
      skuCount: number;
      rateCents: number | null;
      subtotalCents: number | null;
    }>;
  };
  spend: {
    /** Absolute total of all negative-sign ledger entries (everything they've paid us). */
    lifetimeSpendCents: number;
    /** Sum of positive DEPOSIT entries — gross top-ups, before refunds. */
    lifetimeDepositCents: number;
    /** Sum of REFUND + MANUAL_CREDIT + REVERSAL — money returned to the vendor. */
    lifetimeRefundCents: number;
    /** Sum of unresolved receiving-hold extra charges (vendor owes). */
    outstandingHoldsCents: number;
    /** Per-ledger-type net + row count. Frontend renders the spend breakdown from this. */
    byType: Record<string, { count: number; netCents: number }>;
  };
  ledger: {
    recent: Array<{
      id: string;
      type: string;
      amountCents: number;
      balanceAfterCents: number | null;
      description: string;
      referenceType: string | null;
      referenceId: string | null;
      createdAt: string;
    }>;
  };
  holds: Array<{
    id: string;
    psnId: string;
    extraChargeCents: number;
    reasonCode: string;
    reasonNote: string;
    createdAt: string;
    releaseAfter: string;
    vendorPaidAt: string | null;
  }>;
}

/** Reduce a [{status, count}] array into `{total, byStatus}`. Defensive helper for groupBy outputs. */
function collapseCounts(
  rows: Array<{ status: string; count: number }>,
): { total: number; byStatus: Record<string, number> } {
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + r.count;
    total += r.count;
  }
  return { total, byStatus };
}

@Injectable()
export class AdminVendorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  /**
   * Full vendor detail for the admin review screen. Includes the primary
   * owner contact (the first user on the vendor row) so the admin can reach
   * out via email if something is unclear, and the wallet balance for context.
   */
  async getVendorDetail(vendorId: string) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
      include: {
        wallet: true,
        users: {
          // Primary contact = the original signup user. They're always the
          // VENDOR role; sub-users are VENDOR_SUB_USER and added later.
          where: { role: "VENDOR" },
          orderBy: { createdAt: "asc" },
          take: 1,
          select: { id: true, email: true, emailVerified: true, mfaEnrolled: true },
        },
      },
    });
    if (!vendor) throw new NotFoundException();

    const primaryUser = vendor.users[0] ?? null;

    return {
      id: vendor.id,
      businessName: vendor.businessName,
      country: vendor.country,
      kycStatus: vendor.kycStatus,
      kycSubmittedAt: vendor.kycSubmittedAt,
      kycApprovedAt: vendor.kycApprovedAt,
      kycRejectedAt: vendor.kycRejectedAt,
      kycRejectionReason: vendor.kycRejectionReason,
      kycDecidedBy: vendor.kycDecidedBy,
      agreementAcceptedAt: vendor.agreementAcceptedAt,
      agreementVersion: vendor.agreementVersion,
      status: vendor.status,
      instagramHandle: vendor.instagramHandle,
      tiktokHandle: vendor.tiktokHandle,
      xHandle: vendor.xHandle,
      websiteUrl: vendor.websiteUrl,
      socialVerifiedAt: vendor.socialVerifiedAt,
      socialVerifiedBy: vendor.socialVerifiedBy,
      createdAt: vendor.createdAt,
      updatedAt: vendor.updatedAt,
      primaryUser,
      wallet: vendor.wallet
        ? {
            balanceCents: vendor.wallet.balanceCents,
            status: vendor.wallet.status,
            lowBalanceThresholdCents: vendor.wallet.lowBalanceThresholdCents,
          }
        : null,
    };
  }

  // ---------------------------------------------------------------------------
  // Operational overview — everything the vendor has done on the platform.
  //
  // Returned in a single round-trip so the admin detail page renders without
  // a waterfall of dependent fetches. Each section is intentionally capped
  // (recent 10 PSNs/orders/returns, 25 ledger entries) — anything more is a
  // drill-down to the dedicated PSN / orders / finance pages, which already
  // exist with filters + pagination.
  //
  // Money is reported in CENTS (consistent with the rest of the API) so the
  // frontend formats once at the render boundary. Lifetime totals are the
  // ABSOLUTE value of debits within each LedgerEntryType — i.e. "how much has
  // this vendor paid us for storage." Deposits are reported separately as
  // positive sums.
  // ---------------------------------------------------------------------------

  async getVendorOverview(vendorId: string): Promise<VendorOverview> {
    // 1. Verify vendor exists FIRST so the rest of the queries don't all
    //    return empty arrays for a non-existent id and the admin sees a clear
    //    404 instead of an empty overview.
    const exists = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException();

    // 2. Run aggregate queries in parallel — none of them depend on each
    //    other, so Promise.all keeps the round-trip tight. We rely on the
    //    `ledger_entries(vendor_id, created_at)` and per-table vendorId
    //    indexes added in earlier migrations; no new index needed.
    //
    // Every individual query is wrapped in `.catch()` so a single bad
    // query degrades that one section to empty rather than 500'ing the
    // whole overview. Without this guard, a single column rename or
    // missing migration silently took down the entire vendor detail
    // page (production incident: psnHold field-name mismatch). Logging
    // happens inline so the issue is still visible in Sentry / stdout
    // but the admin sees the rest of the data.
    const onErr =
      (label: string) =>
      <T>(fallback: T) =>
      (err: unknown): T => {
        // eslint-disable-next-line no-console
        console.warn(`[admin-vendor.overview] ${label} query failed:`, err);
        return fallback;
      };

    const [
      psnsByStatus,
      psnsRecent,
      ordersByStatus,
      ordersRecent,
      returnsByStatus,
      returnsRecent,
      ledgerByType,
      ledgerRecent,
      skuTierAgg,
      activeHolds,
    ] = await Promise.all([
      this.prisma.psn
        .groupBy({
          by: ["status"],
          where: { vendorId },
          _count: { _all: true },
        })
        .catch(
          onErr("psn.groupBy")(
            [] as Array<{ status: unknown; _count: { _all: number } }>,
          ),
        ),
      this.prisma.psn
        .findMany({
          where: { vendorId },
          orderBy: { createdAt: "desc" },
          take: 10,
          select: {
            id: true,
            status: true,
            carrier: true,
            masterTracking: true,
            declaredBoxCounts: true,
            submittedAt: true,
            receivedAt: true,
            createdAt: true,
            onboardingFeeCents: true,
          },
        })
        .catch(
          onErr("psn.findMany")(
            [] as Array<{
              id: string;
              status: unknown;
              carrier: string | null;
              masterTracking: string | null;
              declaredBoxCounts: unknown;
              submittedAt: Date | null;
              receivedAt: Date | null;
              createdAt: Date;
              onboardingFeeCents: number | null;
            }>,
          ),
        ),
      this.prisma.order
        .groupBy({
          by: ["status"],
          where: { vendorId },
          _count: { _all: true },
          _sum: { totalChargedCents: true },
        })
        .catch(
          onErr("order.groupBy")(
            [] as Array<{
              status: unknown;
              _count: { _all: number };
              _sum: { totalChargedCents: number | null };
            }>,
          ),
        ),
      this.prisma.order
        .findMany({
          where: { vendorId },
          orderBy: { createdAt: "desc" },
          take: 10,
          select: {
            id: true,
            orderNumber: true,
            externalReference: true,
            status: true,
            recipientName: true,
            shipCity: true,
            shipState: true,
            shipCountry: true,
            carrier: true,
            trackingNumber: true,
            totalChargedCents: true,
            submittedAt: true,
            shippedAt: true,
            deliveredAt: true,
            createdAt: true,
          },
        })
        .catch(
          onErr("order.findMany")(
            [] as Array<{
              id: string;
              orderNumber: number;
              externalReference: string | null;
              status: unknown;
              recipientName: string;
              shipCity: string;
              shipState: string;
              shipCountry: string;
              carrier: string | null;
              trackingNumber: string | null;
              totalChargedCents: number;
              submittedAt: Date | null;
              shippedAt: Date | null;
              deliveredAt: Date | null;
              createdAt: Date;
            }>,
          ),
        ),
      this.prisma.return
        .groupBy({
          by: ["status"],
          where: { vendorId },
          _count: { _all: true },
        })
        .catch(
          onErr("return.groupBy")(
            [] as Array<{ status: unknown; _count: { _all: number } }>,
          ),
        ),
      this.prisma.return
        .findMany({
          where: { vendorId },
          orderBy: { createdAt: "desc" },
          take: 10,
          select: {
            id: true,
            status: true,
            reason: true,
            // The Return model splits the refund-side amounts into two
            // columns: refundAmountCents (paid back to vendor) and
            // restockFeeCents (kept by USA Errands). We surface both so
            // the admin can spot a return that cost the vendor money.
            refundAmountCents: true,
            restockFeeCents: true,
            createdAt: true,
            inspectedAt: true,
          },
        })
        .catch(
          onErr("return.findMany")(
            [] as Array<{
              id: string;
              status: unknown;
              reason: unknown;
              refundAmountCents: number;
              restockFeeCents: number;
              createdAt: Date;
              inspectedAt: Date | null;
            }>,
          ),
        ),
      // Lifetime spend / inflow per ledger category. Sum the SIGNED amount
      // and we'll surface the absolute value of negative buckets as "paid",
      // and the positive value of DEPOSIT as "deposited."
      this.prisma.ledgerEntry
        .groupBy({
          by: ["type"],
          where: { vendorId },
          _count: { _all: true },
          _sum: { amountCents: true },
        })
        .catch(
          onErr("ledger.groupBy")(
            [] as Array<{
              type: unknown;
              _count: { _all: number };
              _sum: { amountCents: number | null };
            }>,
          ),
        ),
      this.prisma.ledgerEntry
        .findMany({
          where: { vendorId },
          orderBy: { createdAt: "desc" },
          take: 25,
          select: {
            id: true,
            type: true,
            amountCents: true,
            balanceAfterCents: true,
            description: true,
            referenceType: true,
            referenceId: true,
            createdAt: true,
          },
        })
        .catch(
          onErr("ledger.findMany")(
            [] as Array<{
              id: string;
              type: unknown;
              amountCents: number;
              balanceAfterCents: number | null;
              description: string;
              referenceType: string | null;
              referenceId: string | null;
              createdAt: Date;
            }>,
          ),
        ),
      // Active inventory by storage tier — drives the recurring-storage
      // estimate. We count SKU rows with stock > 0; the storage-billing cron
      // charges per SKU bucket so the count maps 1:1 to next month's bill.
      this.prisma.sku
        .groupBy({
          by: ["storageTier"],
          where: {
            vendorId,
            status: "ACTIVE",
            // Either available or reserved counts as "occupying a slot" for
            // storage billing purposes — matches the cron's view of the world.
            OR: [{ quantityAvailable: { gt: 0 } }, { quantityReserved: { gt: 0 } }],
          },
          _count: { _all: true },
        })
        .catch(
          onErr("sku.groupBy")(
            [] as Array<{ storageTier: unknown; _count: { _all: number } }>,
          ),
        ),
      // Outstanding receiving holds (Phase 2 admin workflow). The PsnHold
      // model uses `status: PsnHoldStatus` (PENDING_PAYMENT / PAID /
      // CANCELLED / AUTO_RETURNED) — "outstanding" means status =
      // PENDING_PAYMENT. The `paidAt` timestamp captures when the wallet
      // debit cleared (null until then).
      //
      // The cast through `unknown` rides out a stale generated Prisma
      // client; the field names below MUST match the live schema or this
      // call 500s. Validated against schema.prisma:
      //   id, psnId, extraChargeCents, reasonCode, reasonNote, status,
      //   createdAt, releaseAfter, paidAt, ledgerEntryId
      (this.prisma as unknown as {
        psnHold: {
          findMany: (args: unknown) => Promise<
            Array<{
              id: string;
              psnId: string;
              extraChargeCents: number;
              reasonCode: string;
              reasonNote: string;
              status: string;
              createdAt: Date;
              releaseAfter: Date;
              paidAt: Date | null;
            }>
          >;
        };
      }).psnHold
        .findMany({
          where: {
            psn: { vendorId },
            status: "PENDING_PAYMENT",
          },
          orderBy: { createdAt: "desc" },
          take: 10,
          select: {
            id: true,
            psnId: true,
            extraChargeCents: true,
            reasonCode: true,
            reasonNote: true,
            status: true,
            createdAt: true,
            releaseAfter: true,
            paidAt: true,
          },
        })
        // Defensive — psnHold ships in migration 0020 but if a future
        // schema change drifts the column names, we don't want it to
        // 500 the entire overview endpoint. Return an empty list and
        // log so the rest of the page still renders.
        .catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.warn("[admin-vendor.overview] psnHold query failed:", err);
          return [] as Array<{
            id: string;
            psnId: string;
            extraChargeCents: number;
            reasonCode: string;
            reasonNote: string;
            status: string;
            createdAt: Date;
            releaseAfter: Date;
            paidAt: Date | null;
          }>;
        }),
    ]);

    // 3. Fold ledger group-by into a typed bucket map so the frontend doesn't
    //    have to guess at enum names. Lifetime spend is the absolute total of
    //    all negative-sign categories.
    const ledgerBuckets: Record<string, { count: number; netCents: number }> = {};
    let lifetimeSpendCents = 0;
    let lifetimeDepositCents = 0;
    let lifetimeRefundCents = 0;
    for (const row of ledgerByType) {
      const net = row._sum.amountCents ?? 0;
      // `row.type` is the LedgerEntryType enum, but the generated client
      // can lag the database (migration 0019 added REFUND / PURCHASE_FEE
      // etc.). Comparing as a plain string keeps TS happy across both
      // pre- and post-generate builds.
      const t = row.type as unknown as string;
      ledgerBuckets[t] = { count: row._count._all, netCents: net };
      if (t === "DEPOSIT") {
        lifetimeDepositCents += net; // positive
      } else if (t === "REFUND" || t === "MANUAL_CREDIT" || t === "REVERSAL") {
        lifetimeRefundCents += net; // positive (credits back to wallet)
      } else if (net < 0) {
        lifetimeSpendCents += Math.abs(net);
      }
    }

    // 4. Recurring storage estimate. Pull the live fee_schedule config row
    //    and multiply each tier's monthlyStorage rate by the count of active
    //    SKUs in that tier. PALLET (null rate) is reported as "negotiated"
    //    with no dollar figure so finance knows to look it up manually.
    const fees = await this.safelyLoadFees();
    const tierBreakdown: VendorOverview["recurringStorage"]["perTier"] = [];
    let recurringMonthlyCents = 0;
    let negotiatedTierCount = 0;
    for (const row of skuTierAgg) {
      const tier = row.storageTier as keyof FeeSchedule["monthlyStorage"];
      const count = row._count._all;
      const rateCents = fees?.monthlyStorage?.[tier] ?? null;
      const subtotal = rateCents != null ? rateCents * count : null;
      if (subtotal != null) recurringMonthlyCents += subtotal;
      if (rateCents == null) negotiatedTierCount += count;
      tierBreakdown.push({
        tier: String(tier),
        skuCount: count,
        rateCents,
        subtotalCents: subtotal,
      });
    }

    // 5. Lifetime PSN / order / return counts derived from the same group-by
    //    so the dashboard tile and the table footer can't disagree.
    const psnCounts = collapseCounts(psnsByStatus.map((r) => ({ status: r.status as string, count: r._count._all })));
    const orderCounts = collapseCounts(ordersByStatus.map((r) => ({ status: r.status as string, count: r._count._all })));
    const returnCounts = collapseCounts(returnsByStatus.map((r) => ({ status: r.status as string, count: r._count._all })));

    const lifetimeOrderRevenueCents = ordersByStatus.reduce(
      (acc, r) => acc + (r._sum.totalChargedCents ?? 0),
      0,
    );

    // 6. Total active SKUs + total units in storage — used by the inventory
    //    stats tile.
    const totalActiveSkus = skuTierAgg.reduce((acc, r) => acc + r._count._all, 0);

    const outstandingHoldsCents = activeHolds.reduce(
      (acc, h) => acc + h.extraChargeCents,
      0,
    );

    return {
      vendorId,
      psns: {
        total: psnCounts.total,
        byStatus: psnCounts.byStatus,
        recent: psnsRecent.map((p) => ({
          id: p.id,
          status: p.status as string,
          carrier: p.carrier,
          masterTracking: p.masterTracking,
          declaredBoxCounts: (p.declaredBoxCounts ?? {}) as Record<string, number>,
          onboardingFeeCents: p.onboardingFeeCents,
          submittedAt: p.submittedAt?.toISOString() ?? null,
          receivedAt: p.receivedAt?.toISOString() ?? null,
          createdAt: p.createdAt.toISOString(),
        })),
      },
      orders: {
        total: orderCounts.total,
        byStatus: orderCounts.byStatus,
        lifetimeRevenueCents: lifetimeOrderRevenueCents,
        recent: ordersRecent.map((o) => ({
          id: o.id,
          orderNumber: o.orderNumber,
          externalReference: o.externalReference,
          status: o.status as string,
          recipientName: o.recipientName,
          destination: `${o.shipCity}, ${o.shipState}, ${o.shipCountry}`,
          carrier: o.carrier,
          trackingNumber: o.trackingNumber,
          totalChargedCents: o.totalChargedCents,
          submittedAt: o.submittedAt?.toISOString() ?? null,
          shippedAt: o.shippedAt?.toISOString() ?? null,
          deliveredAt: o.deliveredAt?.toISOString() ?? null,
          createdAt: o.createdAt.toISOString(),
        })),
      },
      returns: {
        total: returnCounts.total,
        byStatus: returnCounts.byStatus,
        recent: returnsRecent.map((r) => ({
          id: r.id,
          status: r.status as string,
          // `reason` is typed `unknown` on the catch-fallback path so we
          // cast it into the API contract shape here. Real reasons are
          // the ReturnReason enum (a stringly-typed enum on the DB side),
          // which serialises cleanly to `string | null` for clients.
          reason: r.reason == null ? null : String(r.reason),
          handlingFeeCents: r.restockFeeCents,
          totalRefundCents: r.refundAmountCents,
          createdAt: r.createdAt.toISOString(),
          inspectedAt: r.inspectedAt?.toISOString() ?? null,
        })),
      },
      inventory: {
        activeSkus: totalActiveSkus,
        perTier: tierBreakdown,
      },
      recurringStorage: {
        monthlyEstimateCents: recurringMonthlyCents,
        negotiatedTierSkuCount: negotiatedTierCount,
        perTier: tierBreakdown,
      },
      spend: {
        lifetimeSpendCents,
        lifetimeDepositCents,
        lifetimeRefundCents,
        outstandingHoldsCents,
        byType: ledgerBuckets,
      },
      ledger: {
        recent: ledgerRecent.map((l) => ({
          id: l.id,
          type: l.type as string,
          amountCents: l.amountCents,
          balanceAfterCents: l.balanceAfterCents,
          description: l.description,
          referenceType: l.referenceType,
          referenceId: l.referenceId,
          createdAt: l.createdAt.toISOString(),
        })),
      },
      holds: activeHolds.map((h) => ({
        id: h.id,
        psnId: h.psnId,
        extraChargeCents: h.extraChargeCents,
        reasonCode: h.reasonCode,
        reasonNote: h.reasonNote,
        createdAt: h.createdAt.toISOString(),
        releaseAfter: h.releaseAfter.toISOString(),
        // PsnHold has a `paidAt` column (null while the hold is
        // PENDING_PAYMENT). We surface it under `vendorPaidAt` on the
        // wire so the frontend doesn't have to know the underlying
        // column name — matches the rest of this payload's "the
        // *vendor* side of it" framing.
        vendorPaidAt: h.paidAt?.toISOString() ?? null,
      })),
    };
  }

  /**
   * Pulling the fee schedule shouldn't poison the entire overview if the
   * configuration row is missing — show what we can and let the frontend
   * render "not configured" for the recurring estimate. Logging happens
   * inside `loadFeeSchedule`.
   */
  private async safelyLoadFees(): Promise<FeeSchedule | null> {
    try {
      return await loadFeeSchedule(this.prisma);
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // KYC decisions
  // ---------------------------------------------------------------------------

  async approveKyc(vendorId: string, ctx: ActorContext) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
      include: {
        users: { where: { role: "VENDOR" }, take: 1, select: { id: true, email: true } },
      },
    });
    if (!vendor) throw new NotFoundException();

    if (vendor.kycStatus === KycStatus.APPROVED) {
      // Idempotent — re-approving an already-approved vendor is a no-op.
      return this.getVendorDetail(vendorId);
    }
    if (vendor.status === VendorStatus.CLOSED) {
      throw new BadRequestException({
        message: "Cannot approve KYC on a closed account.",
        code: "vendor_closed",
      });
    }

    const now = new Date();
    // Promote to ACTIVE only if the agreement is also signed. Otherwise the
    // vendor stays at PENDING_KYC until they accept.
    const becomingActive = vendor.agreementAcceptedAt !== null;

    await this.prisma.vendor.update({
      where: { id: vendorId },
      data: {
        kycStatus: KycStatus.APPROVED,
        kycApprovedAt: now,
        kycRejectedAt: null,
        kycRejectionReason: null,
        kycDecidedBy: ctx.actorId,
        ...(becomingActive ? { status: VendorStatus.ACTIVE } : {}),
      },
    });

    await this.audit.log({
      actorId: ctx.actorId,
      action: "vendor.kyc_approved",
      resourceType: "vendor",
      resourceId: vendorId,
      beforeState: { kycStatus: vendor.kycStatus, status: vendor.status },
      afterState: {
        kycStatus: KycStatus.APPROVED,
        status: becomingActive ? VendorStatus.ACTIVE : vendor.status,
        notes: ctx.notes ?? null,
      },
    });

    await this.notifyVendor({
      vendorId,
      type: "vendor.kyc_approved",
      severity: "INFO",
      title: "KYC approved",
      body: becomingActive
        ? "Your account is fully active. Submit your first PSN to ship inventory in."
        : "KYC is approved. Accept the vendor agreement to activate your account.",
      href: becomingActive ? "/dashboard" : "/settings/agreement",
      email: kycApprovedTemplate({ businessName: vendor.businessName }),
      ownerUserId: vendor.users[0]?.id ?? null,
    });

    return this.getVendorDetail(vendorId);
  }

  async rejectKyc(vendorId: string, reason: string, ctx: ActorContext) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
      include: {
        users: { where: { role: "VENDOR" }, take: 1, select: { id: true, email: true } },
      },
    });
    if (!vendor) throw new NotFoundException();
    if (vendor.kycStatus === KycStatus.REJECTED) {
      // Idempotent: re-rejecting (perhaps with a different reason) updates the
      // reason text but stays in REJECTED.
    }

    const now = new Date();
    await this.prisma.vendor.update({
      where: { id: vendorId },
      data: {
        kycStatus: KycStatus.REJECTED,
        kycRejectedAt: now,
        kycRejectionReason: reason,
        kycDecidedBy: ctx.actorId,
        status: VendorStatus.SUSPENDED,
      },
    });

    await this.audit.log({
      actorId: ctx.actorId,
      action: "vendor.kyc_rejected",
      resourceType: "vendor",
      resourceId: vendorId,
      beforeState: { kycStatus: vendor.kycStatus, status: vendor.status },
      // Reason is part of the audit trail — operationally critical record of
      // why the decision was made. NOT scrubbed even though it's user-facing.
      afterState: {
        kycStatus: KycStatus.REJECTED,
        status: VendorStatus.SUSPENDED,
        reason,
        notes: ctx.notes ?? null,
      },
    });

    await this.notifyVendor({
      vendorId,
      type: "vendor.kyc_rejected",
      severity: "WARNING",
      title: "KYC review outcome",
      body: "We can't proceed with onboarding right now. See your inbox for details.",
      email: kycRejectedTemplate({ businessName: vendor.businessName, reason }),
      ownerUserId: vendor.users[0]?.id ?? null,
    });

    return this.getVendorDetail(vendorId);
  }

  async requestResubmission(vendorId: string, reason: string, ctx: ActorContext) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
      include: {
        users: { where: { role: "VENDOR" }, take: 1, select: { id: true, email: true } },
      },
    });
    if (!vendor) throw new NotFoundException();

    if (vendor.kycStatus === KycStatus.APPROVED) {
      throw new BadRequestException({
        message: "Already approved. Reject first if you need to undo.",
        code: "vendor_already_approved",
      });
    }
    if (vendor.status === VendorStatus.CLOSED) {
      throw new ForbiddenException({
        message: "Account is closed.",
        code: "vendor_closed",
      });
    }

    await this.prisma.vendor.update({
      where: { id: vendorId },
      data: {
        kycStatus: KycStatus.REQUIRES_RESUBMISSION,
        kycRejectionReason: reason, // surface the same field so the vendor sees the latest message
        kycDecidedBy: ctx.actorId,
      },
    });

    await this.audit.log({
      actorId: ctx.actorId,
      action: "vendor.kyc_resubmission_requested",
      resourceType: "vendor",
      resourceId: vendorId,
      beforeState: { kycStatus: vendor.kycStatus },
      afterState: {
        kycStatus: KycStatus.REQUIRES_RESUBMISSION,
        reason,
        notes: ctx.notes ?? null,
      },
    });

    await this.notifyVendor({
      vendorId,
      type: "vendor.kyc_resubmission_requested",
      severity: "WARNING",
      title: "Action needed: KYC resubmission",
      body: "We need a few details corrected. Open settings to fix and we'll re-review.",
      href: "/settings",
      email: kycResubmissionTemplate({ businessName: vendor.businessName, reason }),
      ownerUserId: vendor.users[0]?.id ?? null,
    });

    return this.getVendorDetail(vendorId);
  }

  // ---------------------------------------------------------------------------
  // Social verification
  // ---------------------------------------------------------------------------

  /**
   * Mark the vendor's social presence as reviewed. Internal-only — does not
   * email the vendor (it's a reviewer's checkpoint, not a decision they need
   * to act on).
   *
   * Calling this on a vendor with NO handles set is rejected — you can't
   * verify what isn't there.
   */
  async markSocialVerified(vendorId: string, ctx: ActorContext) {
    const vendor = await this.prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor) throw new NotFoundException();

    const hasAnyHandle =
      !!vendor.instagramHandle || !!vendor.tiktokHandle || !!vendor.xHandle || !!vendor.websiteUrl;
    if (!hasAnyHandle) {
      throw new BadRequestException({
        message: "Vendor has no social handles to verify.",
        code: "vendor_no_social_handles",
      });
    }

    await this.prisma.vendor.update({
      where: { id: vendorId },
      data: {
        socialVerifiedAt: new Date(),
        socialVerifiedBy: ctx.actorId,
      },
    });

    await this.audit.log({
      actorId: ctx.actorId,
      action: "vendor.social_verified",
      resourceType: "vendor",
      resourceId: vendorId,
      afterState: {
        instagramHandle: vendor.instagramHandle,
        tiktokHandle: vendor.tiktokHandle,
        xHandle: vendor.xHandle,
        websiteUrl: vendor.websiteUrl,
        notes: ctx.notes ?? null,
      },
    });

    return this.getVendorDetail(vendorId);
  }

  // ---------------------------------------------------------------------------

  private async notifyVendor(args: {
    vendorId: string;
    type: string;
    severity: "INFO" | "WARNING" | "ERROR";
    title: string;
    body: string;
    href?: string;
    email: { subject: string; html: string; text: string };
    ownerUserId: string | null;
  }) {
    await this.notifications.emit({
      vendorId: args.vendorId,
      type: args.type,
      severity: args.severity,
      title: args.title,
      body: args.body,
      ...(args.href ? { href: args.href } : {}),
      email: { subject: args.email.subject, html: args.email.html, text: args.email.text },
    });
    // EmailService is invoked through NotificationService.emit when an email
    // payload is supplied — sending it here too would double-deliver. Left
    // commented for posterity in case the notifications module changes.
    // if (args.ownerUserId) {
    //   await this.email.send({ to: ..., type: args.type, userId: args.ownerUserId, ... });
    // }
  }
}
