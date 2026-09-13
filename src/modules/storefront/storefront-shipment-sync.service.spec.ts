import { StorefrontShipmentSyncService } from "./storefront-shipment-sync.service";

function sqlText(q: { strings?: readonly string[]; sql?: string }): string {
  if (q.strings) return q.strings.join(" ");
  return String(q.sql ?? "");
}

const PRIMARY_ROW = {
  id: "so1",
  reference: "SF-000001",
  buyer_email: "buyer@gmail.com",
  buyer_name: "Jane",
  store_name: "Acme",
  business_name: "Acme LLC",
  cart_group_id: null as string | null,
};

function makeService(row: typeof PRIMARY_ROW, siblings: Array<{ reference: string; fulfillment_order_id: string | null }> = []) {
  const executed: string[] = [];
  const prisma = {
    $queryRaw: jest.fn(async (q: never) => {
      const t = sqlText(q);
      // Sibling consolidation UPDATE … RETURNING reference, fulfillment_order_id
      if (t.includes("status = 'FULFILLING'")) return siblings;
      // Primary UPDATE … RETURNING so.id …
      if (t.includes("RETURNING so.id")) return [row];
      return [];
    }),
    $executeRaw: jest.fn(async (q: never) => {
      executed.push(sqlText(q));
      return 1;
    }),
  };
  const email = { send: jest.fn().mockResolvedValue({ ok: true }) };
  const service = new StorefrontShipmentSyncService(prisma as never, email as never);
  return { service, email, prisma, executed };
}

const INFO = { trackingNumber: "1Z999", carrier: "UPS" };

describe("StorefrontShipmentSyncService (single order)", () => {
  it("emails the single order and does not consolidate when there's no cart group", async () => {
    const { service, email, executed } = makeService({ ...PRIMARY_ROW, cart_group_id: null });
    await service.syncFromFulfillmentOrder("fo1", INFO);
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(email.send.mock.calls[0][0].idempotencyKey).toBe("storefront_tracking:SF-000001");
    // No consolidation writes.
    expect(executed).toHaveLength(0);
  });
});

describe("StorefrontShipmentSyncService (consolidated cart)", () => {
  const OLD = process.env.STOREFRONT_CONSOLIDATE_SHIPMENTS;
  afterAll(() => {
    process.env.STOREFRONT_CONSOLIDATE_SHIPMENTS = OLD;
  });

  it("ships siblings on the same tracking and sends ONE combined email when enabled", async () => {
    process.env.STOREFRONT_CONSOLIDATE_SHIPMENTS = "true";
    const { service, email, executed } = makeService(
      { ...PRIMARY_ROW, cart_group_id: "cg1" },
      [{ reference: "SF-000002", fulfillment_order_id: "fo2" }],
    );
    await service.syncFromFulfillmentOrder("fo1", INFO);

    // Primary flagged + sibling fulfillment order linked → at least two writes.
    expect(executed.some((s) => s.includes("is_consolidated_primary = true"))).toBe(true);
    expect(executed.some((s) => s.includes("consolidated_into_order_id"))).toBe(true);
    // Exactly one email, keyed by the cart group (not per sub-order).
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(email.send.mock.calls[0][0].idempotencyKey).toBe("storefront_tracking_group:cg1");
  });

  it("stays per-order when the flag is off even for a cart group", async () => {
    process.env.STOREFRONT_CONSOLIDATE_SHIPMENTS = "false";
    const { service, email, executed } = makeService({ ...PRIMARY_ROW, cart_group_id: "cg1" });
    await service.syncFromFulfillmentOrder("fo1", INFO);
    expect(executed).toHaveLength(0);
    expect(email.send.mock.calls[0][0].idempotencyKey).toBe("storefront_tracking:SF-000001");
  });
});
