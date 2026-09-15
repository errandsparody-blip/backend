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

// Fee schedule: base 450 + 100/additional unit, cap 1099. 3 units → 450 + 2*100 = 650.
const FEE_SCHEDULE = {
  fulfillment: { baseCents: 450, perAdditionalUnitCents: 100, maxCents: 1099 },
  shippingMarkupBps: 1000,
  onboarding: {},
  monthlyStorage: {},
  returnsHandlingCents: 0,
};

function makeService(order: Record<string, unknown> | null) {
  const orderCreate = jest.fn().mockResolvedValue({ id: "ord-f" });
  const lineCreate = jest.fn().mockResolvedValue({});
  const movementCreate = jest.fn().mockResolvedValue({});
  const prisma = {
    $queryRaw: jest.fn(async (q: never) => {
      if (sqlText(q).includes("FROM storefront_orders")) return order ? [order] : [];
      return [];
    }),
    configuration: { findUnique: jest.fn(async () => ({ key: "fee_schedule", value: FEE_SCHEDULE })) },
    vendor: { findUnique: jest.fn(async () => ({ businessName: "Vendor One" })) },
    $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        order: { create: orderCreate },
        orderLine: { create: lineCreate },
        inventoryMovement: { create: movementCreate },
        $executeRaw: jest.fn(async () => 1),
      }),
    ),
  };
  const walletDebit = jest.fn().mockResolvedValue({ entry: {}, balanceAfterCents: 0 });
  const wallet = { debit: walletDebit };
  const opsSend = jest.fn().mockResolvedValue(undefined);
  const opsAlerts = { send: opsSend };
  const notifyEmit = jest.fn().mockResolvedValue(undefined);
  const notifications = { emit: notifyEmit };
  const service = new StorefrontFulfillmentService(
    prisma as never,
    wallet as never,
    opsAlerts as never,
    notifications as never,
  );
  return { service, orderCreate, lineCreate, movementCreate, walletDebit, opsSend, notifyEmit };
}

describe("StorefrontFulfillmentService.createForPaidOrder", () => {
  it("creates a PENDING_PACKING order, charges the vendor wallet the fulfillment fee, and lines per SKU", async () => {
    const { service, orderCreate, lineCreate, movementCreate, walletDebit } = makeService(storefrontOrder());
    const id = await service.createForPaidOrder("so1");
    expect(id).toBe("ord-f");

    const data = orderCreate.mock.calls[0][0].data;
    expect(data.source).toBe("STOREFRONT");
    expect(data.status).toBe("PENDING_PACKING");
    // 3 units → base 450 + 2*100 = 650. Buyer never paid it; vendor is charged.
    expect(data.fulfillmentFeeCents).toBe(650);
    expect(data.totalChargedCents).toBe(650);
    expect(data.shippingFeeCents).toBe(0); // buyer funded delivery
    expect(data.itemsDeclaredValueCents).toBe(3000); // 1000 * (2 + 1)
    expect(data.estimatedShippingMinCents).toBe(800);
    expect(data.sourcePayload.paidTotalCents).toBe(3800);
    expect(data.sourcePayload.shippingSpeed).toBe("STANDARD");

    // Vendor wallet debited the fulfillment fee (same rail as a normal order).
    expect(walletDebit).toHaveBeenCalledTimes(1);
    const debitArgs = walletDebit.mock.calls[0][0];
    expect(debitArgs.vendorId).toBe("v1");
    expect(debitArgs.amountCents).toBe(650);
    expect(debitArgs.type).toBe("FULFILLMENT");

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
