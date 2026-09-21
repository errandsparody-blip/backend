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
  // lookupForBuyer support: the anchor row + the per-sub-order rows.
  anchor?: { cart_group_id: string | null; buyer_name: string | null } | null;
  lookupRows?: Array<Record<string, unknown>>;
}) {
  const executed: string[] = [];
  const prisma = {
    $queryRaw: jest.fn(async (q: never) => {
      const t = sqlText(q);
      // Order matters: the lookup sub-order list contains a storefront_return_requests
      // sub-select, so match its distinctive columns FIRST.
      if (t.includes("cart_group_id, buyer_name FROM storefront_orders"))
        return opts.anchor ? [opts.anchor] : [];
      if (t.includes("open_return")) return opts.lookupRows ?? [];
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
  const notifications = { emit: jest.fn().mockResolvedValue(undefined) };
  const service = new StorefrontReturnService(
    prisma as never,
    { refund } as never,
    email as never,
    notifications as never,
  );
  return { service, executed, refund, email, notifications };
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

describe("StorefrontReturnService.lookupForBuyer", () => {
  it("maps sub-orders with per-order returnability + reasons", async () => {
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const { service } = make({
      anchor: { cart_group_id: "cg1", buyer_name: "B" },
      lookupRows: [
        {
          reference: "SF-1", status: "SHIPPED", shipped_at: recent, items: [{ name: "Tee", qty: 1 }],
          store_name: "Acme", business_name: "Acme LLC", returns_allowed: true, return_window_days: 30,
          open_return: null, resolved_return: null,
        },
        {
          reference: "SF-2", status: "PAID", shipped_at: null, items: [{ name: "Mug", qty: 2 }],
          store_name: "Bravo", business_name: "Bravo LLC", returns_allowed: true, return_window_days: 30,
          open_return: null, resolved_return: null,
        },
      ],
    });
    const res = await service.lookupForBuyer("SF-1", "b@x.com");
    expect(res.buyerName).toBe("B");
    expect(res.subOrders).toHaveLength(2);
    expect(res.subOrders[0]).toMatchObject({ reference: "SF-1", returnable: true, reason: null });
    expect(res.subOrders[1]).toMatchObject({ reference: "SF-2", returnable: false });
    expect(res.subOrders[1]!.reason).toMatch(/not shipped/i);
  });

  it("404s an order that isn't the buyer's", async () => {
    const { service } = make({ anchor: null });
    await expect(service.lookupForBuyer("SF-1", "b@x.com")).rejects.toBeTruthy();
  });
});

describe("StorefrontReturnService.requestCartReturn", () => {
  it("opens a return per selected order, stamping the tracking number", async () => {
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const { service, executed } = make({
      order: {
        id: "o1", status: "SHIPPED", buyer_name: "B", store_name: "Acme", business_name: "Acme LLC",
        returns_allowed: true, return_window_days: 30, shipped_at: recent,
      },
    });
    const res = await service.requestCartReturn("b@x.com", ["SF-1", "SF-2"], "Wrong size", "1Z-TRACK");
    expect(res.created).toHaveLength(2);
    expect(res.skipped).toHaveLength(0);
    // The insert carries the return tracking column.
    expect(executed.some((s) => s.includes("return_tracking_number"))).toBe(true);
  });

  it("throws when nothing could be returned", async () => {
    const { service } = make({ order: null }); // resolveBuyerOrder → null → not found
    await expect(
      service.requestCartReturn("b@x.com", ["SF-9"], "x", "1Z-TRACK"),
    ).rejects.toBeTruthy();
  });
});

describe("StorefrontReturnService.markReceived", () => {
  it("stamps received on an open request", async () => {
    const { service, executed } = make({
      request: {
        status: "REQUESTED", reference: "SR-1", order_reference: "SF-1", buyer_email: "b@x.com",
        buyer_name: "B", store_name: "Acme", business_name: "Acme LLC",
      },
    });
    const res = await service.markReceived("rr1", "wh-user");
    expect(res.id).toBe("rr1");
    expect(executed.some((s) => s.includes("received_at = COALESCE(received_at, now())"))).toBe(true);
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
