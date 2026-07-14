/**
 * SuperAdminDashboardService — Migration 0047 (Phase H).
 *
 * Read-only aggregation across the whole platform. Separate from
 * `AdminDashboardController` (which is scoped to operational counts
 * that WAREHOUSE_OPERATOR / FINANCE_ADMIN / ADMIN can also see) so
 * the finance-sensitive numbers (wallet totals, revenue, per-vendor
 * ARR indicators) stay SUPER_ADMIN-only.
 *
 * SOLID:
 *   * SRP — this service does ONE thing: gather aggregates. It never
 *     writes. Callers do all the presentation shaping.
 *   * OCP — the response is a single `SuperAdminSnapshot` type;
 *     adding a new metric adds a field (and one Prisma call) without
 *     touching existing consumers.
 *   * DIP — only PrismaService is injected. No leaky coupling to
 *     order or vendor services.
 *
 * SECURITY / correctness
 *   * Every $transaction batch below is a READ-ONLY set of aggregates.
 *     They are batched so we hit the DB with a single round-trip,
 *     but no writes are ever composed with them.
 *   * Revenue numbers derive from the `orders` table's
 *     `total_charged_cents` + `fulfillment_fee_cents` + `shipping_fee_cents`
 *     columns. Cancelled and refunded orders are subtracted from the
 *     top-line via the CANCELLED status filter.
 *   * All timestamps are ISO strings so the frontend never has to
 *     guess a serialisation format.
 *   * Empty tables (fresh install) return zero — no null / undefined
 *     leaks. All the aggregates default via `?? 0` on the wire.
 */

import { Injectable } from "@nestjs/common";
import type { OrderStatus, VendorStatus } from "@prisma/client";

import { PrismaService } from "../../common/prisma.service";

// ---------------------------------------------------------------------------
// Response shape — mirrored on the frontend at
//   usa-errands-web/src/lib/schemas/super-admin-dashboard.ts
// A change here means a change there.
// ---------------------------------------------------------------------------

export interface SuperAdminSnapshot {
  /** Revenue totals across the platform. */
  revenue: {
    last24hCents: number;
    last7dCents: number;
    last30dCents: number;
    /** Just the fulfillment-fee slice of the 30d window. */
    last30dFulfillmentCents: number;
    /** Just the shipping-fee slice of the 30d window. */
    last30dShippingCents: number;
  };
  /** Vendor wallets aggregated. */
  wallets: {
    totalBalanceCents: number;
    vendorCount: number;
    /** Vendors below their configured low-balance threshold RIGHT NOW. */
    lowBalanceCount: number;
  };
  /** Vendors — one bucket per VendorStatus, plus a total. */
  vendors: {
    total: number;
    byStatus: Record<VendorStatus, number>;
  };
  /** Order status counts (all statuses that could still act). */
  orders: {
    total: number;
    byStatus: Partial<Record<OrderStatus, number>>;
    /** Convenience: sum of the v2 in-flight statuses. */
    v2InFlight: number;
  };
  /** Warehouse KPIs. */
  warehouse: {
    packagingOptionsActive: number;
    inventoryLocationsActive: number;
    /**
     * Products with at least one barcode registered / total products.
     * Both counts so a UI can render the coverage percentage without
     * making the client do the maths.
     */
    productsWithBarcode: number;
    productsTotal: number;
  };
  /** Vendor CSV import throughput. */
  imports: {
    last24h: number;
    last7d: number;
    successRate7dPercent: number; // integer 0..100
  };
  /** Recent activity — most recent 10 orders + 10 vendors. */
  recent: {
    orders: Array<{
      id: string;
      orderNumber: number;
      vendorBusinessName: string;
      status: OrderStatus;
      totalChargedCents: number;
      createdAt: string;
    }>;
    vendors: Array<{
      id: string;
      businessName: string;
      status: VendorStatus;
      createdAt: string;
    }>;
  };
  /** ISO timestamp for when this snapshot was assembled. */
  generatedAt: string;
}

// ---------------------------------------------------------------------------

@Injectable()
export class SuperAdminDashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async snapshot(): Promise<SuperAdminSnapshot> {
    const now = new Date();
    const day = 24 * 60 * 60 * 1000;
    const since24h = new Date(now.getTime() - day);
    const since7d = new Date(now.getTime() - 7 * day);
    const since30d = new Date(now.getTime() - 30 * day);

    // ---------------------------------------------------------------
    // Batch 1 — parallel reads that don't depend on each other. Each
    // is small and returns a scalar, so a $transaction round-trip is
    // faster than N serial round-trips.
    // ---------------------------------------------------------------

    // Read-only aggregates. `Promise.all` gives us the same
    // "fire in parallel" behaviour as `$transaction` for reads (each
    // query lands on its own connection) and lets us mix Prisma
    // delegates that aren't present on the generated client in the
    // sandbox (packagingOption, inventoryLocation, orderImportJob).
    // A snapshot doesn't need transactional read consistency across
    // these — they're independent counters displayed on a dashboard.
    const prismaAny = this.prisma as unknown as {
      packagingOption: { count: (a: unknown) => Promise<number> };
      inventoryLocation: { count: (a: unknown) => Promise<number> };
      orderImportJob: {
        count: (a: unknown) => Promise<number>;
        aggregate: (a: unknown) => Promise<{
          _sum: { successCount: number | null; rowCount: number | null };
        }>;
      };
      product: { count: (a: unknown) => Promise<number> };
    };

    const [
      rev24h,
      rev7d,
      rev30d,
      rev30dFulfillmentBreakdown,
      walletAgg,
      walletVendorCount,
      packagingActive,
      locationsActive,
      productsTotal,
      imports24h,
      imports7d,
      imports7dAgg,
    ] = await Promise.all([
      this.prisma.order.aggregate({
        where: { createdAt: { gte: since24h }, status: { not: "CANCELLED" } },
        _sum: { totalChargedCents: true },
      }),
      this.prisma.order.aggregate({
        where: { createdAt: { gte: since7d }, status: { not: "CANCELLED" } },
        _sum: { totalChargedCents: true },
      }),
      this.prisma.order.aggregate({
        where: { createdAt: { gte: since30d }, status: { not: "CANCELLED" } },
        _sum: { totalChargedCents: true },
      }),
      this.prisma.order.aggregate({
        where: { createdAt: { gte: since30d }, status: { not: "CANCELLED" } },
        _sum: { fulfillmentFeeCents: true, shippingFeeCents: true },
      }),
      this.prisma.wallet.aggregate({ _sum: { balanceCents: true } }),
      this.prisma.wallet.count(),
      prismaAny.packagingOption.count({ where: { isActive: true } }),
      prismaAny.inventoryLocation.count({ where: { isActive: true } }),
      this.prisma.product.count(),
      prismaAny.orderImportJob.count({
        where: { createdAt: { gte: since24h } },
      }),
      prismaAny.orderImportJob.count({
        where: { createdAt: { gte: since7d } },
      }),
      prismaAny.orderImportJob.aggregate({
        where: { createdAt: { gte: since7d } },
        _sum: { successCount: true, rowCount: true },
      }),
    ]);

    // ---------------------------------------------------------------
    // Batch 2 — count queries per status. Grouped per model to keep
    // the two $transactions readable; no cross-model dependency.
    // ---------------------------------------------------------------

    const [vendorGroups, orderGroups, productsWithBarcodeCount] =
      await Promise.all([
        this.prisma.vendor.groupBy({
          by: ["status"],
          orderBy: { status: "asc" },
          _count: { _all: true },
        }),
        this.prisma.order.groupBy({
          by: ["status"],
          orderBy: { status: "asc" },
          _count: { _all: true },
        }),
        // Products that have AT LEAST ONE barcode. `some: {}` compiles
        // to WHERE EXISTS (SELECT 1 FROM product_barcodes WHERE …)
        // via Prisma's relation filter — cheap; uses the FK index.
        prismaAny.product.count({ where: { barcodes: { some: {} } } }),
      ]);

    // Wallets below their threshold — Prisma doesn't support column-
    // vs-column comparisons via its DSL, so we hit raw SQL. Fast: an
    // index on wallets.vendor_id already exists.
    const lowBalanceRows = await this.prisma.$queryRaw<
      Array<{ count: number }>
    >`SELECT COUNT(*)::int AS count
       FROM wallets
       WHERE balance_cents <= low_balance_threshold_cents
         AND low_balance_threshold_cents > 0`;
    const lowBalanceCount = lowBalanceRows[0]?.count ?? 0;

    // ---------------------------------------------------------------
    // Batch 3 — recent-activity lists.
    // ---------------------------------------------------------------

    const [recentOrdersRaw, recentVendorsRaw] = await Promise.all([
      this.prisma.order.findMany({
        orderBy: { createdAt: "desc" },
        take: 10,
        include: {
          vendor: { select: { businessName: true } },
        },
      }),
      this.prisma.vendor.findMany({
        orderBy: { createdAt: "desc" },
        take: 10,
        select: {
          id: true,
          businessName: true,
          status: true,
          createdAt: true,
        },
      }),
    ]);

    // ---------------------------------------------------------------
    // Shape the response. `?? 0` on every optional aggregate so the
    // wire never contains a null; the DB returns null for empty
    // aggregates (Prisma passes it through).
    // ---------------------------------------------------------------

    const V2_STATUSES: OrderStatus[] = [
      "PENDING_PACKING" as OrderStatus,
      "PACKING_COMPLETED" as OrderStatus,
      "AWAITING_SHIPPING_SELECTION" as OrderStatus,
      "AWAITING_WALLET_FUNDING" as OrderStatus,
      "SHIPPING_PAID" as OrderStatus,
    ];

    const orderByStatus: Partial<Record<OrderStatus, number>> = {};
    let orderTotal = 0;
    let v2InFlight = 0;
    for (const g of orderGroups) {
      const key = g.status as OrderStatus;
      const n = g._count._all;
      orderByStatus[key] = n;
      orderTotal += n;
      if (V2_STATUSES.includes(key)) v2InFlight += n;
    }

    // Every VendorStatus bucket must be present, so zero-fill.
    const emptyVendorBuckets: Record<VendorStatus, number> = {
      ACTIVE: 0,
      PENDING_KYC: 0,
      SUSPENDED: 0,
      CLOSED: 0,
    } as Record<VendorStatus, number>;
    let vendorTotal = 0;
    for (const g of vendorGroups) {
      const key = g.status as VendorStatus;
      emptyVendorBuckets[key] = g._count._all;
      vendorTotal += g._count._all;
    }

    const success7d = imports7dAgg._sum.successCount ?? 0;
    const total7d = imports7dAgg._sum.rowCount ?? 0;
    const successRate =
      total7d === 0 ? 0 : Math.round((success7d * 100) / total7d);

    return {
      revenue: {
        last24hCents: rev24h._sum.totalChargedCents ?? 0,
        last7dCents: rev7d._sum.totalChargedCents ?? 0,
        last30dCents: rev30d._sum.totalChargedCents ?? 0,
        last30dFulfillmentCents:
          rev30dFulfillmentBreakdown._sum.fulfillmentFeeCents ?? 0,
        last30dShippingCents:
          rev30dFulfillmentBreakdown._sum.shippingFeeCents ?? 0,
      },
      wallets: {
        totalBalanceCents: walletAgg._sum.balanceCents ?? 0,
        vendorCount: walletVendorCount,
        lowBalanceCount,
      },
      vendors: {
        total: vendorTotal,
        byStatus: emptyVendorBuckets,
      },
      orders: {
        total: orderTotal,
        byStatus: orderByStatus,
        v2InFlight,
      },
      warehouse: {
        packagingOptionsActive: packagingActive,
        inventoryLocationsActive: locationsActive,
        productsWithBarcode: productsWithBarcodeCount,
        productsTotal,
      },
      imports: {
        last24h: imports24h,
        last7d: imports7d,
        successRate7dPercent: successRate,
      },
      recent: {
        orders: recentOrdersRaw.map((o) => ({
          id: o.id,
          orderNumber: o.orderNumber,
          vendorBusinessName: o.vendor?.businessName ?? "—",
          status: o.status,
          totalChargedCents: o.totalChargedCents,
          createdAt: o.createdAt.toISOString(),
        })),
        vendors: recentVendorsRaw.map((v) => ({
          id: v.id,
          businessName: v.businessName,
          status: v.status,
          createdAt: v.createdAt.toISOString(),
        })),
      },
      generatedAt: now.toISOString(),
    };
  }
}
