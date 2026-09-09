import { StorefrontTaxService } from "./storefront-tax.service";

function makeService(configValue: unknown) {
  const prisma = {
    configuration: { findUnique: jest.fn().mockResolvedValue(configValue ? { value: configValue } : null) },
  };
  return new StorefrontTaxService(prisma as never);
}

describe("StorefrontTaxService", () => {
  it("is $0 when no rates are configured (tax disabled)", async () => {
    const svc = makeService(null);
    expect(await svc.taxFor("TX", 10000)).toBe(0);
  });

  it("computes destination tax when the state has a rate", async () => {
    const svc = makeService({ TX: 825 });
    expect(await svc.taxFor("TX", 10000)).toBe(825); // 8.25% of $100
    expect(await svc.taxFor("tx", 5000)).toBe(413); // case-insensitive, rounded
  });

  it("is $0 for a state with no configured rate", async () => {
    const svc = makeService({ TX: 825 });
    expect(await svc.taxFor("CA", 10000)).toBe(0);
  });

  it("ignores malformed config entries", async () => {
    const svc = makeService({ TX: 825, "1": 100, CA: -5, NY: 20000 });
    const rates = await svc.loadRates();
    expect(rates).toEqual({ TX: 825 });
  });

  it("computeTaxCents guards zero/negative base", () => {
    const svc = makeService(null);
    expect(svc.computeTaxCents({ TX: 825 }, "TX", 0)).toBe(0);
  });
});
