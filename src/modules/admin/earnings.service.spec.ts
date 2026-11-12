import { EarningsService } from "./earnings.service";

function makeService(opts: {
  platformBps?: number;
  processingBps?: number;
  gross?: number;
  adminCountry?: string | null;
}) {
  const configuration = {
    findUnique: jest.fn().mockImplementation(({ where }: { where: { key: string } }) => {
      if (where.key === "admin_platform_fee_bps") {
        return Promise.resolve(opts.platformBps !== undefined ? { value: { bps: opts.platformBps } } : null);
      }
      if (where.key === "admin_processing_fee_bps") {
        return Promise.resolve(opts.processingBps !== undefined ? { value: { bps: opts.processingBps } } : null);
      }
      return Promise.resolve(null);
    }),
    upsert: jest.fn(),
  };
  const prisma = {
    configuration,
    $queryRaw: jest.fn().mockImplementation((q: unknown) => {
      const s = JSON.stringify(q);
      if (s.includes("admin_country")) {
        return Promise.resolve([{ admin_country: opts.adminCountry ?? "US" }]);
      }
      return Promise.resolve([{ gross: BigInt(opts.gross ?? 0) }]);
    }),
  };
  return new EarningsService(prisma as never, { log: jest.fn() } as never);
}

describe("EarningsService", () => {
  it("defaults to 6% platform, 0% processing", async () => {
    const s = makeService({});
    expect(await s.getFeeSettings()).toEqual({ platformBps: 600, processingBps: 0 });
  });

  it("fulfillment: platform fee off gross, processing off the remainder", async () => {
    // gross 10000; platform 6% = 600; remainder 9400; processing 10% = 940; net 8460.
    const s = makeService({ platformBps: 600, processingBps: 1000, gross: 10_000 });
    const b = await s.fulfillmentEarnings("a", new Date("2026-11-01"), new Date("2026-12-01"));
    expect(b.grossCents).toBe(10_000);
    expect(b.platformFeeCents).toBe(600);
    expect(b.processingFeeCents).toBe(940);
    expect(b.netCents).toBe(8_460);
  });

  it("storage USA: 100%, no deduction", async () => {
    const s = makeService({ processingBps: 1000, gross: 5_000, adminCountry: "US" });
    const b = await s.storageEarnings("a", new Date("2026-11-01"), new Date("2026-12-01"));
    expect(b.grossCents).toBe(5_000);
    expect(b.processingFeeCents).toBe(0);
    expect(b.netCents).toBe(5_000);
  });

  it("storage Canada: processing fee only, no platform fee", async () => {
    // gross 5000; processing 10% = 500; net 4500; platform fee 0.
    const s = makeService({ platformBps: 600, processingBps: 1000, gross: 5_000, adminCountry: "CA" });
    const b = await s.storageEarnings("a", new Date("2026-11-01"), new Date("2026-12-01"));
    expect(b.grossCents).toBe(5_000);
    expect(b.platformFeeCents).toBe(0);
    expect(b.processingFeeCents).toBe(500);
    expect(b.netCents).toBe(4_500);
  });
});
