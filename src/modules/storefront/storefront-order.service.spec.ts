import { StorefrontOrderService } from "./storefront-order.service";
import type { ParsedPaymentEvent } from "../payments/payment-processor.interface";

function sqlText(q: { strings?: readonly string[]; sql?: string }): string {
  if (q.strings) return q.strings.join(" ");
  return String(q.sql ?? "");
}

function makeService(opts: {
  order: {
    id: string;
    reference: string;
    status: string;
    total_cents: number;
    currency: string;
    items: Array<{ productId: string; qty: number }>;
  } | null;
  updateReturns: Array<{ id: string }>; // [] = already processed
}) {
  const prisma = {
    $queryRaw: jest.fn(async (q: never) => {
      const t = sqlText(q);
      // Order of checks matters: the conditional flip is also on storefront_orders.
      if (t.includes("UPDATE storefront_orders")) return opts.updateReturns;
      if (t.includes("FROM storefront_orders")) return opts.order ? [opts.order] : [];
      return [];
    }),
  };
  const fulfillment = { createForPaidOrder: jest.fn().mockResolvedValue("ord-f") };
  const registry = { get: jest.fn() };
  const email = { send: jest.fn().mockResolvedValue({ ok: true }) };
  const service = new StorefrontOrderService(
    prisma as never,
    fulfillment as never,
    registry as never,
    email as never,
  );
  return service;
}

function makeRefundService(orderRow: Record<string, unknown> | null, updateReturns: Array<{ id: string }>) {
  const refund = jest.fn().mockResolvedValue({ refundId: "re_1" });
  const skuUpdates: string[] = [];
  const prisma = {
    $queryRaw: jest.fn(async (q: never) => {
      if (sqlText(q).includes("FROM storefront_orders")) return orderRow ? [orderRow] : [];
      return [];
    }),
    $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        $queryRaw: jest.fn(async (q: never) =>
          sqlText(q).includes("UPDATE storefront_orders") ? updateReturns : [],
        ),
        $executeRaw: jest.fn(async (q: never) => {
          if (sqlText(q).includes("UPDATE skus")) skuUpdates.push("sku");
          return 1;
        }),
        inventoryMovement: { create: jest.fn().mockResolvedValue({}) },
      }),
    ),
  };
  const registry = { get: jest.fn().mockReturnValue({ refund }) };
  const email = { send: jest.fn().mockResolvedValue({ ok: true }) };
  const service = new StorefrontOrderService(
    prisma as never,
    { createForPaidOrder: jest.fn() } as never,
    registry as never,
    email as never,
  );
  return { service, refund, email, skuUpdates };
}

function refundableOrder(over: Record<string, unknown> = {}) {
  return {
    id: "ord1",
    status: "PAID",
    processor: "STRIPE",
    payment_ref: "pi_1",
    total_cents: 6100,
    items: [{ allocations: [{ skuId: "sku1", qty: 2 }] }],
    buyer_email: "b@x.com",
    buyer_name: "B",
    vendor_id: "v1",
    fulfillment_order_id: "ford1",
    store_name: "Acme",
    business_name: "Acme LLC",
    ...over,
  };
}

describe("StorefrontOrderService.refund", () => {
  it("refunds via the processor, restocks a not-yet-shipped order, and emails the buyer", async () => {
    const { service, refund, email, skuUpdates } = makeRefundService(refundableOrder(), [{ id: "ord1" }]);
    const res = await service.refund("SF-000001", "admin", undefined);
    expect(res.refundId).toBe("re_1");
    expect(res.amountCents).toBe(6100);
    expect(refund).toHaveBeenCalledWith(
      expect.objectContaining({ paymentRef: "pi_1", amountCents: undefined }), // full refund
    );
    expect(skuUpdates.length).toBe(1); // restocked
    expect(email.send).toHaveBeenCalled();
  });

  it("does NOT restock a shipped order", async () => {
    const { service, skuUpdates } = makeRefundService(
      refundableOrder({ status: "SHIPPED" }),
      [{ id: "ord1" }],
    );
    await service.refund("SF-000001", "admin");
    expect(skuUpdates.length).toBe(0);
  });

  it("rejects refunding an already-refunded order", async () => {
    const { service } = makeRefundService(refundableOrder({ status: "REFUNDED" }), []);
    await expect(service.refund("SF-000001", "admin")).rejects.toBeTruthy();
  });

  it("passes a partial amount through to the processor", async () => {
    const { service, refund } = makeRefundService(refundableOrder(), [{ id: "ord1" }]);
    await service.refund("SF-000001", "admin", 1000);
    expect(refund).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 1000 }));
  });
});

const paidEvent: ParsedPaymentEvent = {
  type: "paid",
  reference: "SF-000001",
  paymentRef: "pi_1",
  amountCents: 6100,
  currency: "USD",
};

const order = {
  id: "ord1",
  reference: "SF-000001",
  status: "PENDING_PAYMENT",
  total_cents: 6100,
  currency: "USD",
  items: [{ productId: "p1", qty: 2 }],
};

describe("StorefrontOrderService.markPaidFromEvent", () => {
  it("ignores non-paid events", async () => {
    const svc = makeService({ order, updateReturns: [{ id: "ord1" }] });
    const res = await svc.markPaidFromEvent({ ...paidEvent, type: "other" });
    expect(res).toEqual({ handled: false, reason: "not_paid_event" });
  });

  it("returns order_not_found when nothing matches", async () => {
    const svc = makeService({ order: null, updateReturns: [] });
    const res = await svc.markPaidFromEvent(paidEvent);
    expect(res.reason).toBe("order_not_found");
  });

  it("refuses to mark paid on an amount mismatch", async () => {
    const svc = makeService({ order, updateReturns: [{ id: "ord1" }] });
    const res = await svc.markPaidFromEvent({ ...paidEvent, amountCents: 9999 });
    expect(res.reason).toBe("amount_mismatch");
    expect(res.handled).toBe(false);
  });

  it("marks paid + commits stock on the first webhook", async () => {
    const svc = makeService({ order, updateReturns: [{ id: "ord1" }] });
    const res = await svc.markPaidFromEvent(paidEvent);
    expect(res.handled).toBe(true);
    expect(res.reference).toBe("SF-000001");
  });

  it("is idempotent — a duplicate webhook is a no-op", async () => {
    const svc = makeService({ order, updateReturns: [] }); // conditional update hits 0 rows
    const res = await svc.markPaidFromEvent(paidEvent);
    expect(res.reason).toBe("already_processed");
    expect(res.handled).toBe(false);
  });
});
