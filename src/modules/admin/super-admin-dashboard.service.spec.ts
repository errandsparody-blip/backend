/**
 * SuperAdminDashboardService — response-shape and defensive-defaults tests.
 *
 * Verifies:
 *   * The snapshot contains every documented field, even against a
 *     fully empty database (no null / undefined leaks — every field
 *     is a number, string, or defined object).
 *   * Vendor status buckets are zero-filled for every VendorStatus.
 *   * The 7d success rate is 0% (not NaN) when no imports exist.
 */

import type { PrismaService } from "../../common/prisma.service";

import { SuperAdminDashboardService } from "./super-admin-dashboard.service";

// Every aggregate returns an "empty" shape matching Prisma's real
// null-sum contract; every list returns []. This mirrors what the DB
// gives us on a fresh install.
class EmptyPrisma {
  order = {
    aggregate: jest.fn(async () => ({
      _sum: {
        totalChargedCents: null,
        fulfillmentFeeCents: null,
        shippingFeeCents: null,
      },
    })),
    groupBy: jest.fn<
      Promise<Array<{ status: string; _count: { _all: number } }>>,
      [unknown]
    >(async () => []),
    findMany: jest.fn(async () => []),
  };
  vendor = {
    groupBy: jest.fn<
      Promise<Array<{ status: string; _count: { _all: number } }>>,
      [unknown]
    >(async () => []),
    findMany: jest.fn(async () => []),
  };
  wallet = {
    aggregate: jest.fn(async () => ({ _sum: { balanceCents: null } })),
    count: jest.fn(async () => 0),
  };
  product = { count: jest.fn(async () => 0) };
  packagingOption = { count: jest.fn(async () => 0) };
  inventoryLocation = { count: jest.fn(async () => 0) };
  orderImportJob = {
    count: jest.fn(async () => 0),
    aggregate: jest.fn<
      Promise<{ _sum: { successCount: number | null; rowCount: number | null } }>,
      [unknown]
    >(async () => ({
      _sum: { successCount: null, rowCount: null },
    })),
  };
  $queryRaw = jest.fn(async () => [{ count: 0 }]);
}

describe("SuperAdminDashboardService.snapshot", () => {
  it("returns a fully-populated snapshot against an empty database", async () => {
    const prisma = new EmptyPrisma();
    const svc = new SuperAdminDashboardService(
      prisma as unknown as PrismaService,
    );
    const s = await svc.snapshot();

    // Revenue — every window zero, never null/undefined.
    expect(s.revenue.last24hCents).toBe(0);
    expect(s.revenue.last7dCents).toBe(0);
    expect(s.revenue.last30dCents).toBe(0);
    expect(s.revenue.last30dFulfillmentCents).toBe(0);
    expect(s.revenue.last30dShippingCents).toBe(0);

    // Wallets.
    expect(s.wallets.totalBalanceCents).toBe(0);
    expect(s.wallets.vendorCount).toBe(0);
    expect(s.wallets.lowBalanceCount).toBe(0);

    // Vendors — every bucket present with zero even when groupBy is empty.
    expect(s.vendors.total).toBe(0);
    expect(s.vendors.byStatus.ACTIVE).toBe(0);
    expect(s.vendors.byStatus.PENDING_KYC).toBe(0);
    expect(s.vendors.byStatus.SUSPENDED).toBe(0);
    expect(s.vendors.byStatus.CLOSED).toBe(0);

    // Orders — buckets empty, in-flight zero.
    expect(s.orders.total).toBe(0);
    expect(s.orders.v2InFlight).toBe(0);
    expect(s.orders.byStatus).toEqual({});

    // Warehouse.
    expect(s.warehouse.packagingOptionsActive).toBe(0);
    expect(s.warehouse.inventoryLocationsActive).toBe(0);
    expect(s.warehouse.productsWithBarcode).toBe(0);
    expect(s.warehouse.productsTotal).toBe(0);

    // Imports — success rate must be 0 (not NaN) when no rows.
    expect(s.imports.last24h).toBe(0);
    expect(s.imports.last7d).toBe(0);
    expect(s.imports.successRate7dPercent).toBe(0);
    expect(Number.isNaN(s.imports.successRate7dPercent)).toBe(false);

    // Recent activity lists are arrays, never undefined.
    expect(Array.isArray(s.recent.orders)).toBe(true);
    expect(Array.isArray(s.recent.vendors)).toBe(true);

    // Generated-at is an ISO string.
    expect(() => new Date(s.generatedAt).toISOString()).not.toThrow();
  });

  it("sums vendor buckets and orders when data is present", async () => {
    const prisma = new EmptyPrisma();
    prisma.vendor.groupBy.mockResolvedValueOnce([
      { status: "ACTIVE", _count: { _all: 5 } },
      { status: "SUSPENDED", _count: { _all: 1 } },
    ]);
    prisma.order.groupBy.mockResolvedValueOnce([
      { status: "PENDING_PACKING", _count: { _all: 3 } },
      { status: "DELIVERED", _count: { _all: 7 } },
      { status: "AWAITING_WALLET_FUNDING", _count: { _all: 2 } },
    ]);
    prisma.orderImportJob.aggregate.mockResolvedValueOnce({
      _sum: { successCount: 8, rowCount: 10 },
    });
    const svc = new SuperAdminDashboardService(
      prisma as unknown as PrismaService,
    );
    const s = await svc.snapshot();

    expect(s.vendors.total).toBe(6);
    expect(s.vendors.byStatus.ACTIVE).toBe(5);
    expect(s.vendors.byStatus.SUSPENDED).toBe(1);
    expect(s.vendors.byStatus.PENDING_KYC).toBe(0);

    expect(s.orders.total).toBe(12);
    // PENDING_PACKING + AWAITING_WALLET_FUNDING are v2 in-flight.
    expect(s.orders.v2InFlight).toBe(5);

    // 8/10 → 80% success rate, integer, no fractional leak.
    expect(s.imports.successRate7dPercent).toBe(80);
  });
});
