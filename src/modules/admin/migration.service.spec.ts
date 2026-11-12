import { BadRequestException } from "@nestjs/common";

import { MigrationService } from "./migration.service";

/**
 * readiness() issues, in order:
 *   1. configuration.findUnique (flag)
 *   2. $queryRaw — CA order vendors
 *   3. $queryRaw — CA stock vendors
 *   4. $queryRaw — CA stock count
 */
function makeService(opts: {
  flagEnabled?: boolean;
  caOrderVendors?: Array<{ vendor_id: string; business_name: string; n: number }>;
  caStockVendorIds?: string[];
}) {
  const queue: unknown[] = [
    opts.caOrderVendors ?? [],
    (opts.caStockVendorIds ?? []).map((v) => ({ vendor_id: v })),
    [{ n: (opts.caStockVendorIds ?? []).length }],
  ];
  const upsert = jest.fn().mockResolvedValue({});
  const prisma = {
    configuration: {
      findUnique: jest.fn().mockResolvedValue(
        opts.flagEnabled ? { value: { enabled: true } } : null,
      ),
      upsert,
    },
    $queryRaw: jest.fn().mockImplementation(() => Promise.resolve(queue.shift() ?? [])),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const svc = new MigrationService(prisma as never, audit as never);
  return { svc, upsert, prisma, audit };
}

describe("MigrationService — USA + Canada cutover (Phase 3)", () => {
  it("readiness flags vendors with CA orders but no CA stock (Dishie checkpoint)", async () => {
    const { svc } = makeService({
      caOrderVendors: [
        { vendor_id: "dishie", business_name: "Dishie Skincare", n: 4 },
        { vendor_id: "ok", business_name: "Has Stock", n: 2 },
      ],
      caStockVendorIds: ["ok"],
    });
    const r = await svc.readiness();
    expect(r.countryRoutingEnabled).toBe(false);
    expect(r.vendorsNeedingCanadaStock).toEqual([
      { vendorId: "dishie", businessName: "Dishie Skincare", canadaOrderCount: 4 },
    ]);
  });

  it("refuses to enable routing without explicit confirmation", async () => {
    const { svc, upsert } = makeService({});
    await expect(svc.enableCountryRouting("admin", { confirm: false })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  it("blocks cutover when a vendor has Canada orders but no Canada stock", async () => {
    const { svc, upsert } = makeService({
      caOrderVendors: [{ vendor_id: "dishie", business_name: "Dishie Skincare", n: 4 }],
      caStockVendorIds: [],
    });
    await expect(
      svc.enableCountryRouting("admin", { confirm: true }),
    ).rejects.toMatchObject({ response: { code: "migration_pending_canada_stock" } });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("enables routing when the pending-Canada vendors are acknowledged", async () => {
    const { svc, upsert, audit } = makeService({
      caOrderVendors: [{ vendor_id: "dishie", business_name: "Dishie Skincare", n: 4 }],
      caStockVendorIds: [],
    });
    const res = await svc.enableCountryRouting("admin", {
      confirm: true,
      acknowledgePendingCanada: true,
    });
    expect(res).toEqual({ enabled: true, flaggedVendors: 1 });
    expect(upsert).toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalled();
  });

  it("enables routing cleanly when there are no pending-Canada vendors", async () => {
    const { svc, upsert } = makeService({ caOrderVendors: [], caStockVendorIds: [] });
    const res = await svc.enableCountryRouting("admin", { confirm: true });
    expect(res).toEqual({ enabled: true, flaggedVendors: 0 });
    expect(upsert).toHaveBeenCalled();
  });

  it("disable-routing flips the flag off", async () => {
    const { svc, upsert } = makeService({ flagEnabled: true });
    const res = await svc.disableCountryRouting("admin");
    expect(res).toEqual({ enabled: false });
    expect(upsert).toHaveBeenCalled();
  });
});
