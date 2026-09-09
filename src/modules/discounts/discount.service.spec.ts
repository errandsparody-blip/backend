import { DiscountService } from "./discount.service";

function sqlText(q: { strings?: readonly string[]; sql?: string }): string {
  if (q.strings) return q.strings.join(" ");
  return String(q.sql ?? "");
}

const VENDOR = "11111111-1111-1111-1111-111111111111";

function row(over: Record<string, unknown> = {}) {
  return {
    id: "dc1",
    code: "SAVE10",
    scope: "VENDOR",
    discount_type: "PERCENT",
    value_bps: 1000,
    value_cents: null,
    active: true,
    starts_at: null,
    ends_at: null,
    min_subtotal_cents: null,
    max_redemptions: null,
    redemption_count: 0,
    ...over,
  };
}

function makeService(handlers: {
  vendorRow?: Record<string, unknown> | null;
  mkRow?: Record<string, unknown> | null;
  targets?: Array<{ vendor_id: string }>;
}) {
  const prisma = {
    $queryRaw: jest.fn(async (q: never) => {
      const t = sqlText(q);
      if (t.includes("scope = 'VENDOR'")) return handlers.vendorRow ? [handlers.vendorRow] : [];
      if (t.includes("scope = 'MARKETPLACE'")) return handlers.mkRow ? [handlers.mkRow] : [];
      if (t.includes("FROM discount_code_vendors")) return handlers.targets ?? [];
      return [];
    }),
  };
  return new DiscountService(prisma as never);
}

describe("DiscountService.resolve", () => {
  it("applies a vendor PERCENT code (10% of subtotal)", async () => {
    const svc = makeService({ vendorRow: row() });
    const res = await svc.resolve(VENDOR, "save10", 5000);
    expect(res).toEqual({ ok: true, id: "dc1", code: "SAVE10", discountCents: 500 });
  });

  it("caps a FIXED code at the subtotal", async () => {
    const svc = makeService({
      vendorRow: row({ discount_type: "FIXED", value_bps: null, value_cents: 9999 }),
    });
    const res = await svc.resolve(VENDOR, "SAVE10", 4000);
    expect(res.ok && res.discountCents).toBe(4000);
  });

  it("rejects an expired code", async () => {
    const svc = makeService({ vendorRow: row({ ends_at: new Date(Date.now() - 1000) }) });
    const res = await svc.resolve(VENDOR, "SAVE10", 5000);
    expect(res).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects when below the minimum subtotal", async () => {
    const svc = makeService({ vendorRow: row({ min_subtotal_cents: 10000 }) });
    const res = await svc.resolve(VENDOR, "SAVE10", 5000);
    expect(res).toEqual({ ok: false, reason: "below_minimum" });
  });

  it("rejects when the redemption cap is reached", async () => {
    const svc = makeService({ vendorRow: row({ max_redemptions: 5, redemption_count: 5 }) });
    const res = await svc.resolve(VENDOR, "SAVE10", 5000);
    expect(res).toEqual({ ok: false, reason: "redemption_limit" });
  });

  it("applies a marketplace code that targets all vendors (no target rows)", async () => {
    const svc = makeService({
      vendorRow: null,
      mkRow: row({ id: "mk1", scope: "MARKETPLACE", code: "BLKFRI", value_bps: 2000 }),
      targets: [],
    });
    const res = await svc.resolve(VENDOR, "BLKFRI", 5000);
    expect(res).toEqual({ ok: true, id: "mk1", code: "BLKFRI", discountCents: 1000 });
  });

  it("rejects a marketplace code that targets other vendors only", async () => {
    const svc = makeService({
      vendorRow: null,
      mkRow: row({ id: "mk1", scope: "MARKETPLACE", code: "BLKFRI" }),
      targets: [{ vendor_id: "someone-else" }],
    });
    const res = await svc.resolve(VENDOR, "BLKFRI", 5000);
    expect(res).toEqual({ ok: false, reason: "not_applicable" });
  });

  it("returns not_found for an unknown code", async () => {
    const svc = makeService({ vendorRow: null, mkRow: null });
    const res = await svc.resolve(VENDOR, "NOPE", 5000);
    expect(res).toEqual({ ok: false, reason: "not_found" });
  });
});
