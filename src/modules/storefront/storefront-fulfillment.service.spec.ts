import { StorefrontFulfillmentService } from "./storefront-fulfillment.service";

function sqlText(q: { strings?: readonly string[]; sql?: string }): string {
  if (q.strings) return q.strings.join(" ");
  return String(q.sql ?? "");
}

const shipAddress = {
  recipientName: "Jane",
  line1: "1 Main",
  city: "Austin",
  state: "TX",
  postalCode: "78701",
  country: "US",
};

function storefrontOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "so1",
    reference: "SF-000001",
    vendor_id: "v1",
    buyer_email: "buyer@example.com",
    buyer_name: "Jane",
    buyer_phone: null,
    ship_address: shipAddress,
    items: [
      {
        productId: "p1",
        code: "TSH-BLK",
        variant: "STD",
        name: "Tee",
        qty: 3,
        unitDeclaredValueCents: 1000,
        allocations: [
          { skuId: "sku-a", qty: 2 },
          { skuId: "sku-b", qty: 1 },
        ],
      },
    ],
    shipping_speed: "STANDARD",
    shipping_cents: 800,
    total_cents: 3800,
    fulfillment_order_id: null,
    ...overrides,
  };
}

function makeService(order: Record<string, unknown> | null) {
  const orderCreate = jest.fn().mockResolvedValue({ id: "ord-f" });
  const lineCreate = jest.fn().mockResolvedValue({});
  const movementCreate = jest.fn().mockResolvedValue({});
  const prisma = {
    $queryRaw: jest.fn(async (q: never) => {
      if (sqlText(q).includes("FROM storefront_orders")) return order ? [order] : [];
      return [];
    }),
    $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        order: { create: orderCreate },
        orderLine: { create: lineCreate },
        inventoryMovement: { create: movementCreate },
        $executeRaw: jest.fn(async () => 1),
      }),
    ),
  };
  const service = new StorefrontFulfillmentService(prisma as never);
  return { service, orderCreate, lineCreate, movementCreate };
}

describe("StorefrontFulfillmentService.createForPaidOrder", () => {
  it("creates a PENDING_PACKING order + a line per SKU allocation (no vendor charge)", async () => {
    const { service, orderCreate, lineCreate, movementCreate } = makeService(storefrontOrder());
    const id = await service.createForPaidOrder("so1");
    expect(id).toBe("ord-f");

    const data = orderCreate.mock.calls[0][0].data;
    expect(data.source).toBe("STOREFRONT");
    expect(data.status).toBe("PENDING_PACKING");
    expect(data.fulfillmentFeeCents).toBe(0);
    expect(data.totalChargedCents).toBe(0);
    expect(data.itemsDeclaredValueCents).toBe(3000); // 1000 * (2 + 1)
    expect(data.estimatedShippingMinCents).toBe(800);
    expect(data.sourcePayload.paidTotalCents).toBe(3800);
    expect(data.sourcePayload.shippingSpeed).toBe("STANDARD");

    // Two allocations → two lines + two RESERVE movements.
    expect(lineCreate).toHaveBeenCalledTimes(2);
    expect(movementCreate).toHaveBeenCalledTimes(2);
  });

  it("is idempotent when the order is already bridged", async () => {
    const { service, orderCreate } = makeService(
      storefrontOrder({ fulfillment_order_id: "existing" }),
    );
    const id = await service.createForPaidOrder("so1");
    expect(id).toBe("existing");
    expect(orderCreate).not.toHaveBeenCalled();
  });

  it("returns null for an unknown storefront order", async () => {
    const { service } = makeService(null);
    expect(await service.createForPaidOrder("nope")).toBeNull();
  });
});
