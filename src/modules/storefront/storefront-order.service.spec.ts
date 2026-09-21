import { StorefrontOrderService } from "./storefront-order.service";

function sqlText(q: { strings?: readonly string[]; sql?: string }): string {
  if (q.strings) return q.strings.join(" ");
  return String(q.sql ?? "");
}

interface SubRow {
  id: string;
  reference: string;
  status: string;
  total_cents: number;
  platform_fee_cents: number;
  currency: string;
  vendor_id: string;
  processor: string;
  payout_status: string;
  returns_allowed?: boolean | null;
  return_window_days?: number | null;
}

function makeSvc(subs: SubRow[]) {
  const transferToVendor = jest.fn().mockResolvedValue({ transferId: "tr_1" });
  const registry = { get: jest.fn().mockReturnValue({ transferToVendor }) };
  const fulfillment = { createForPaidOrder: jest.fn().mockResolvedValue("ord_f") };
  const executed: string[] = [];
  const prisma = {
    $queryRaw: jest.fn(async (q: never) => {
      const t = sqlText(q);
      if (t.includes("FROM storefront_orders") && t.includes("cart_group_id")) return subs;
      // Conditional paid-flip (UPDATE … RETURNING id).
      if (t.includes("UPDATE") && t.includes("status = 'PAID'")) return [{ id: "flipped" }];
      if (t.includes("FROM vendor_payout_accounts")) return [{ external_account_id: "acct_v" }];
      return [];
    }),
    $executeRaw: jest.fn(async (q: never) => {
      executed.push(sqlText(q));
      return 1;
    }),
  };
  const email = { send: jest.fn().mockResolvedValue({ ok: true }) };
  const svc = new StorefrontOrderService(
    prisma as never,
    fulfillment as never,
    registry as never,
    email as never,
  );
  return { svc, transferToVendor, fulfillment, prisma, executed };
}

// Default: vendors take no returns → paid out immediately (window = 0).
const SUBS: SubRow[] = [
  { id: "o1", reference: "SF-000001", status: "PENDING_PAYMENT", total_cents: 3600, platform_fee_cents: 1100, currency: "USD", vendor_id: "v1", processor: "STRIPE", payout_status: "PENDING", returns_allowed: false, return_window_days: 0 },
  { id: "o2", reference: "SF-000002", status: "PENDING_PAYMENT", total_cents: 5450, platform_fee_cents: 450, currency: "USD", vendor_id: "v2", processor: "STRIPE", payout_status: "PENDING", returns_allowed: false, return_window_days: 0 },
];

describe("StorefrontOrderService.distributeCartPayment (unified cart)", () => {
  const cartEvent = {
    type: "paid" as const,
    reference: "CART-abc",
    paymentRef: "pi_cart",
    amountCents: 9050, // 3600 + 5450
    currency: "USD",
  };

  it("marks every sub-order paid, bridges fulfillment, and pays each vendor their share", async () => {
    const { svc, transferToVendor, fulfillment } = makeSvc(SUBS);
    const res = await svc.markPaidFromEvent(cartEvent as never);
    expect(res.handled).toBe(true);
    expect(fulfillment.createForPaidOrder).toHaveBeenCalledTimes(2);
    // Vendor payout = total − platform fee.
    expect(transferToVendor).toHaveBeenCalledTimes(2);
    const amounts = transferToVendor.mock.calls
      .map((c) => (c[0] as { amountCents: number }).amountCents)
      .sort((a, b) => a - b);
    expect(amounts).toEqual([2500, 5000]); // 3600−1100, 5450−450
    // Idempotency: each transfer is keyed on the sub-order reference.
    const refs = transferToVendor.mock.calls.map((c) => (c[0] as { reference: string }).reference).sort();
    expect(refs).toEqual(["SF-000001", "SF-000002"]);
  });

  it("rejects a platform charge whose amount doesn't match the cart total", async () => {
    const { svc, transferToVendor } = makeSvc(SUBS);
    const res = await svc.markPaidFromEvent({ ...cartEvent, amountCents: 9999 } as never);
    expect(res.handled).toBe(false);
    expect(res.reason).toBe("amount_mismatch");
    expect(transferToVendor).not.toHaveBeenCalled();
  });

  it("does not pay out a vendor whose sub-order was already distributed", async () => {
    const paidOut = SUBS.map((s) => ({ ...s, payout_status: "PAID" as const }));
    const { svc, transferToVendor } = makeSvc(paidOut);
    await svc.markPaidFromEvent(cartEvent as never);
    expect(transferToVendor).not.toHaveBeenCalled();
  });

  it("HOLDS the vendor share (no immediate payout) when the vendor accepts returns", async () => {
    const held = SUBS.map((s) => ({ ...s, returns_allowed: true, return_window_days: 30 }));
    const { svc, transferToVendor, executed } = makeSvc(held);
    const res = await svc.markPaidFromEvent(cartEvent as never);
    expect(res.handled).toBe(true);
    // No transfer at payment time — the share is held for the return window.
    expect(transferToVendor).not.toHaveBeenCalled();
    expect(executed.some((s) => s.includes("payout_status = 'HELD'"))).toBe(true);
  });
});
