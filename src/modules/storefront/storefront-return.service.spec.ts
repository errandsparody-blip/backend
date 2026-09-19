import { BadRequestException } from "@nestjs/common";

import { StorefrontReturnService } from "./storefront-return.service";

function sqlText(q: { strings?: readonly string[]; sql?: string }): string {
  if (q.strings) return q.strings.join(" ");
  return String(q.sql ?? "");
}

function make(opts: {
  order?: {
    id: string;
    status: string;
    buyer_name: string | null;
    store_name: string | null;
    business_name: string;
    shipped_at?: Date | null;
    returns_allowed?: boolean | null;
    return_window_days?: number | null;
  } | null;
  request?: {
    status: string;
    reference: string;
    order_reference: string;
    buyer_email: string;
    buyer_name: string | null;
    store_name: string | null;
    business_name: string;
  } | null;
}) {
  const executed: string[] = [];
  const prisma = {
    $queryRaw: jest.fn(async (q: never) => {
      const t = sqlText(q);
      if (t.includes("FROM storefront_return_requests")) return opts.request ? [opts.request] : [];
      if (t.includes("FROM storefront_orders")) return opts.order ? [opts.order] : [];
      if (t.includes("nextval")) return [{ n: 1n }];
      return [];
    }),
    $executeRaw: jest.fn(async (q: never) => {
      executed.push(sqlText(q));
      return 1;
    }),
  };
  const refund = jest.fn().mockResolvedValue({ refundId: "re_1", amountCents: 6100 });
  const email = { send: jest.fn().mockResolvedValue({ ok: true }) };
  const service = new StorefrontReturnService(
    prisma as never,
    { refund } as never,
    email as never,
  );
  return { service, executed, refund, email };
}

describe("StorefrontReturnService.requestReturn", () => {
  it("creates a request for a shipped order + emails the buyer", async () => {
    const { service, executed, email } = make({
      order: { id: "o1", status: "SHIPPED", buyer_name: "B", store_name: "Acme", business_name: "Acme LLC" },
    });
    const res = await service.requestReturn("b@x.com", "SF-000001", "Wrong size");
    expect(res.reference).toBe("SR-000001");
    expect(res.status).toBe("REQUESTED");
    expect(executed.some((s) => s.includes("INSERT INTO storefront_return_requests"))).toBe(true);
    expect(email.send).toHaveBeenCalled();
  });

  it("rejects a return on an order that hasn't shipped", async () => {
    const { service } = make({
      order: { id: "o1", status: "PAID", buyer_name: null, store_name: null, business_name: "Acme LLC" },
    });
    await expect(service.requestReturn("b@x.com", "SF-1", "x")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("404s an order that isn't the buyer's", async () => {
    const { service } = make({ order: null });
    await expect(service.requestReturn("b@x.com", "SF-1", "x")).rejects.toBeTruthy();
  });

  it("rejects a return when the store doesn't accept returns", async () => {
    const { service } = make({
      order: {
        id: "o1", status: "SHIPPED", buyer_name: "B", store_name: "Acme", business_name: "Acme LLC",
        returns_allowed: false,
      },
    });
    await expect(service.requestReturn("b@x.com", "SF-1", "x")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("rejects a return past the vendor's window", async () => {
    const shippedLongAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const { service } = make({
      order: {
        id: "o1", status: "SHIPPED", buyer_name: "B", store_name: "Acme", business_name: "Acme LLC",
        returns_allowed: true, return_window_days: 30, shipped_at: shippedLongAgo,
      },
    });
    await expect(service.requestReturn("b@x.com", "SF-1", "x")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("allows a return inside the vendor's window", async () => {
    const shippedRecently = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const { service, executed } = make({
      order: {
        id: "o1", status: "SHIPPED", buyer_name: "B", store_name: "Acme", business_name: "Acme LLC",
        returns_allowed: true, return_window_days: 30, shipped_at: shippedRecently,
      },
    });
    const res = await service.requestReturn("b@x.com", "SF-000001", "Wrong size");
    expect(res.status).toBe("REQUESTED");
    expect(executed.some((s) => s.includes("INSERT INTO storefront_return_requests"))).toBe(true);
  });
});

describe("StorefrontReturnService.approve / reject", () => {
  const openReq = {
    status: "REQUESTED",
    reference: "SR-000001",
    order_reference: "SF-000001",
    buyer_email: "b@x.com",
    buyer_name: "B",
    store_name: "Acme",
    business_name: "Acme LLC",
  };

  it("approve() issues a refund and marks approved", async () => {
    const { service, refund, executed } = make({ request: openReq });
    const res = await service.approve("rr1", "admin");
    expect(refund).toHaveBeenCalledWith("SF-000001", "admin", undefined);
    expect(res.refundId).toBe("re_1");
    expect(executed.some((s) => s.includes("SET status = 'APPROVED'"))).toBe(true);
  });

  it("reject() marks rejected + emails the buyer", async () => {
    const { service, email, executed } = make({ request: openReq });
    const res = await service.reject("rr1", "admin", "Outside window");
    expect(res.status).toBe("REJECTED");
    expect(executed.some((s) => s.includes("SET status = 'REJECTED'"))).toBe(true);
    expect(email.send).toHaveBeenCalled();
  });

  it("refuses to act on a non-open request", async () => {
    const { service } = make({ request: { ...openReq, status: "APPROVED" } });
    await expect(service.approve("rr1", "admin")).rejects.toBeTruthy();
  });
});
