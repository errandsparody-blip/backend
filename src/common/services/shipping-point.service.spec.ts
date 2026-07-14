/**
 * ShippingPointService — behavioural tests.
 *
 * Covers the pure resolution logic (bucket math, boundary rules,
 * fallbacks, product-level sums). The DB is faked with a minimal
 * in-memory shim; we exercise the branches that matter for
 * Fulfillment v2 correctness:
 *
 *   1. sum × quantity — five units of a 0.5-point product = 2.5
 *   2. boundary rules — half-open EXCEPT the last bucket
 *   3. clamp above the top bucket — never returns $0
 *   4. fallback when config row is missing OR invalid
 *   5. unassigned products propagate correctly (allAssigned=false)
 *   6. write validation rejects overlapping / bad-shape tables
 *
 * No Prisma is spun up; every persistence call is a stub.
 */

import { Test, type TestingModule } from "@nestjs/testing";

import { PrismaService } from "../prisma.service";
import { DEFAULT_SHIPPING_POINT_RANGES } from "../schemas/shipping-points";

import { ShippingPointService } from "./shipping-point.service";

// ---------------------------------------------------------------------------
// Minimal Prisma double — only the surface ShippingPointService touches.
// ---------------------------------------------------------------------------

interface FakeProduct {
  id: string;
  shippingPoints: unknown; // number | string | Decimal-shape | null
}

interface FakeConfig {
  key: string;
  value: unknown;
  description?: string | null;
}

class FakePrisma {
  products: FakeProduct[] = [];
  configs: FakeConfig[] = [];

  product = {
    findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
      return this.products.find((p) => p.id === where.id) ?? null;
    }),
    findMany: jest.fn(
      async ({ where }: { where: { id: { in: string[] } } }) => {
        const ids = new Set(where.id.in);
        return this.products.filter((p) => ids.has(p.id));
      },
    ),
  };

  configuration = {
    findUnique: jest.fn(async ({ where }: { where: { key: string } }) => {
      return this.configs.find((c) => c.key === where.key) ?? null;
    }),
    upsert: jest.fn(
      async ({
        where,
        create,
        update,
      }: {
        where: { key: string };
        create: FakeConfig;
        update: { value: unknown };
      }) => {
        const existing = this.configs.find((c) => c.key === where.key);
        if (existing) {
          existing.value = update.value;
          return existing;
        }
        this.configs.push(create);
        return create;
      },
    ),
  };
}

// ---------------------------------------------------------------------------

describe("ShippingPointService", () => {
  let svc: ShippingPointService;
  let prisma: FakePrisma;

  beforeEach(async () => {
    prisma = new FakePrisma();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ShippingPointService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    svc = moduleRef.get(ShippingPointService);
  });

  // -------------------------------------------------------------------------
  // Product-level reads
  // -------------------------------------------------------------------------

  it("getPoints: returns null for a missing product (never throws)", async () => {
    await expect(svc.getPoints("does-not-exist")).resolves.toBeNull();
  });

  it("getPoints: returns null for a product with unassigned shipping points", async () => {
    prisma.products.push({ id: "p1", shippingPoints: null });
    await expect(svc.getPoints("p1")).resolves.toBeNull();
  });

  it("getPoints: normalises the three Decimal representations Prisma can return", async () => {
    // Fresh client: object with .toNumber()
    prisma.products.push({
      id: "p-obj",
      shippingPoints: { toNumber: () => 1.25 },
    });
    // Stale client: bare number
    prisma.products.push({ id: "p-num", shippingPoints: 0.75 });
    // Stringified (older driver): base-10 string
    prisma.products.push({ id: "p-str", shippingPoints: "2.5" });
    // Corrupt value: NaN, must degrade to null
    prisma.products.push({ id: "p-nan", shippingPoints: "not-a-number" });

    await expect(svc.getPoints("p-obj")).resolves.toBe(1.25);
    await expect(svc.getPoints("p-num")).resolves.toBe(0.75);
    await expect(svc.getPoints("p-str")).resolves.toBe(2.5);
    await expect(svc.getPoints("p-nan")).resolves.toBeNull();
  });

  // -------------------------------------------------------------------------
  // sumForLines — multiplies by quantity, tracks unassigned
  // -------------------------------------------------------------------------

  it("sumForLines: multiplies each product's points by its line quantity", async () => {
    prisma.products.push(
      { id: "p1", shippingPoints: 0.5 },
      { id: "p2", shippingPoints: 1.5 },
    );
    const res = await svc.sumForLines([
      { productId: "p1", quantity: 5 }, // 2.5
      { productId: "p2", quantity: 2 }, // 3.0
    ]);
    expect(res.totalPoints).toBeCloseTo(5.5);
    expect(res.allAssigned).toBe(true);
    expect(res.resolutions).toHaveLength(2);
  });

  it("sumForLines: unassigned product blocks 'allAssigned' but still contributes 0 to the sum", async () => {
    prisma.products.push(
      { id: "p1", shippingPoints: 1.0 },
      { id: "p2", shippingPoints: null }, // unassigned
    );
    const res = await svc.sumForLines([
      { productId: "p1", quantity: 3 },
      { productId: "p2", quantity: 10 },
    ]);
    expect(res.totalPoints).toBeCloseTo(3.0);
    expect(res.allAssigned).toBe(false);
    const p2 = res.resolutions.find((r) => r.productId === "p2");
    expect(p2?.assigned).toBe(false);
    expect(p2?.points).toBeNull();
  });

  it("sumForLines: empty lines returns zero, allAssigned=true, no DB call", async () => {
    const res = await svc.sumForLines([]);
    expect(res.totalPoints).toBe(0);
    expect(res.allAssigned).toBe(true);
    expect(res.resolutions).toEqual([]);
    expect(prisma.product.findMany).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // resolveRange — boundary rules + clamping
  // -------------------------------------------------------------------------

  it("resolveRange: interior of a bucket returns that bucket", async () => {
    // 0.25 sits inside the first default bucket [0, 0.5) → $5-8 (500..800 cents).
    const r = await svc.resolveRange(0.25);
    expect(r).toEqual({ dollarsMin: 500, dollarsMax: 800 });
  });

  it("resolveRange: pointsMax boundary belongs to the NEXT bucket (half-open on the right)", async () => {
    // 0.5 is the boundary between bucket [0, 0.5) and bucket [0.5, 1.5).
    // Half-open on the right means 0.5 → second bucket ($8-12).
    const r = await svc.resolveRange(0.5);
    expect(r).toEqual({ dollarsMin: 800, dollarsMax: 1200 });
  });

  it("resolveRange: LAST bucket is inclusive on the right so the top doesn't fall through", async () => {
    // Last default bucket is [3, 5]. 5 is the top — must resolve to
    // the last bucket, not fall through to the clamp path.
    const r = await svc.resolveRange(5);
    expect(r).toEqual({ dollarsMin: 1800, dollarsMax: 2500 });
  });

  it("resolveRange: sums ABOVE the top bucket clamp to the top bucket (never $0)", async () => {
    // 12.7 exceeds every default bucket. Must clamp to the top
    // bucket's range so wallet validation still catches under-funded
    // vendors instead of sailing through with $0.
    const r = await svc.resolveRange(12.7);
    expect(r).toEqual({ dollarsMin: 1800, dollarsMax: 2500 });
  });

  it("resolveRange: 0 points still resolves to the first bucket, never null", async () => {
    const r = await svc.resolveRange(0);
    expect(r).toEqual({ dollarsMin: 500, dollarsMax: 800 });
  });

  // -------------------------------------------------------------------------
  // Config load / fallback
  // -------------------------------------------------------------------------

  it("resolveRange: falls back to compiled-in defaults when no config row is set", async () => {
    // No config row seeded. Every resolve should use DEFAULT_SHIPPING_POINT_RANGES.
    const r = await svc.resolveRange(1);
    const bucketFor1 = DEFAULT_SHIPPING_POINT_RANGES.buckets[1]!; // [0.5, 1.5)
    expect(r).toEqual({
      dollarsMin: bucketFor1.dollarsMin,
      dollarsMax: bucketFor1.dollarsMax,
    });
  });

  it("resolveRange: falls back to defaults when the config row shape is invalid", async () => {
    prisma.configs.push({
      key: "shipping_point_estimate_ranges",
      value: { buckets: "not-an-array" },
    });
    const r = await svc.resolveRange(1);
    const bucketFor1 = DEFAULT_SHIPPING_POINT_RANGES.buckets[1]!;
    expect(r).toEqual({
      dollarsMin: bucketFor1.dollarsMin,
      dollarsMax: bucketFor1.dollarsMax,
    });
  });

  // -------------------------------------------------------------------------
  // writeTable — validation
  // -------------------------------------------------------------------------

  it("writeTable: rejects overlapping buckets so the resolver stays deterministic", async () => {
    await expect(
      svc.writeTable({
        buckets: [
          { pointsMin: 0, pointsMax: 2, dollarsMin: 500, dollarsMax: 800 },
          { pointsMin: 1, pointsMax: 3, dollarsMin: 800, dollarsMax: 1200 }, // overlaps [0,2)
        ],
      }),
    ).rejects.toThrow(/invalid/);
  });

  it("writeTable: rejects a bucket with dollarsMin > dollarsMax", async () => {
    await expect(
      svc.writeTable({
        buckets: [
          { pointsMin: 0, pointsMax: 1, dollarsMin: 800, dollarsMax: 500 },
        ],
      }),
    ).rejects.toThrow(/invalid/);
  });

  it("writeTable: rejects an empty bucket list (would silently produce $0)", async () => {
    await expect(svc.writeTable({ buckets: [] })).rejects.toThrow(/invalid/);
  });

  it("writeTable: accepts a well-formed table + subsequent resolve reads the new value", async () => {
    await svc.writeTable({
      buckets: [
        { pointsMin: 0, pointsMax: 10, dollarsMin: 100, dollarsMax: 200 },
      ],
    });
    const r = await svc.resolveRange(5);
    expect(r).toEqual({ dollarsMin: 100, dollarsMax: 200 });
  });
});
