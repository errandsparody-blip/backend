/**
 * IntegrationOrderService — storefront ingestion decision logic.
 *
 * Covers the branches that decide an order's fate before/around the money
 * transaction: idempotent re-send, the three "hold" outcomes (unmapped SKU,
 * rejected address, insufficient funds — none of which may debit the wallet),
 * and the funded happy path (which MUST reserve stock + debit exactly once and
 * land the order ALLOCATED). The atomic stock/funds race lives in the e2e
 * suite where a real Postgres + FOR UPDATE locking is available.
 */

import type { FeeSchedule } from "../../common/fees";

// Stub the fee-schedule loader so we don't need the configuration table.
const SCHEDULE: FeeSchedule = {
  onboarding: {
    SMALL: { stockingCents: 100, firstMonthStorageCents: 100, totalCents: 200 },
    MEDIUM: { stockingCents: 200, firstMonthStorageCents: 200, totalCents: 400 },
    LARGE: { stockingCents: 400, firstMonthStorageCents: 400, totalCents: 800 },
    X_LARGE: { stockingCents: 500, firstMonthStorageCents: 600, totalCents: 1100 },
    PALLET: { negotiated: true },
  },
  monthlyStorage: { SMALL: 100, MEDIUM: 200, LARGE: 400, X_LARGE: 600, PALLET: 4500 },
  fulfillment: { baseCents: 299, perAdditionalUnitCents: 99, maxCents: 1099 },
  returnsHandlingCents: 500,
  shippingMarkupBps: 1000,
};
jest.mock("../../common/fees", () => ({
  loadFeeSchedule: jest.fn(async () => SCHEDULE),
}));

import { IntegrationOrderService } from "./integration-order.service";
import type { IntegrationOrderInput } from "../../common/schemas/integration.schema";

const VENDOR = "11111111-1111-1111-1111-111111111111";

const baseInput = (): IntegrationOrderInput => ({
  externalReference: "STORE-1001",
  recipient: {
    name: "Jane Buyer",
    phone: undefined,
    email: undefined,
    line1: "123 Market St",
    line2: undefined,
    city: "Austin",
    state: "TX",
    postalCode: "78701",
    country: "US",
  },
  lines: [{ sku: "TSH-BLK-M", quantity: 2 }],
  fulfillmentMode: "PLATFORM_SHIP",
  shipping: undefined,
});

const PRODUCT_ROW = {
  id: "prod-1",
  code: "TSH-BLK-M",
  storeSku: "STORE-TEE-1",
  name: "Black Tee",
  declaredValueCents: 1000,
  weightOz: 8,
  lengthIn: 10,
  widthIn: 8,
  heightIn: 1,
  skus: [{ id: "UER-SKU-1", variant: "STD", quantityAvailable: 50, status: "ACTIVE" }],
};

function makeService(overrides: {
  products?: unknown[];
  balanceCents?: number;
  addressOutcome?: "ACCEPTED" | "REJECTED" | "NEEDS_VERIFICATION";
  existingOrder?: unknown;
  rates?: Array<{ rateId: string; shipmentId: string; carrier: string; service: string; estimatedDeliveryDays: number; costCents: number }>;
}) {
  const created: Record<string, unknown>[] = [];
  const orderEvents: Record<string, unknown>[] = [];
  const debits: unknown[] = [];

  const txMock = {
    $queryRaw: jest.fn(async () => [
      { id: "UER-SKU-1", vendor_id: VENDOR, quantity_available: 50, status: "ACTIVE" },
    ]),
    order: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: "order-allocated", ...data };
        created.push(row);
        return { id: row.id };
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data?: Record<string, unknown> }) => {
        if (data) created.push({ id: where.id, ...data });
        return { id: where.id };
      }),
      findUniqueOrThrow: jest.fn(async ({ where }: { where: { id: string } }) => {
        const last = (created[created.length - 1] ?? {}) as Record<string, unknown>;
        return {
          id: where.id,
          vendorId: VENDOR,
          orderNumber: 1625,
          externalReference: "STORE-1001",
          status: last["status"] ?? "PENDING_PACKING",
          holdReason: null,
          carrierService: last["carrierService"] ?? null,
          totalChargedCents: last["totalChargedCents"] ?? 0,
          shippingCostCents: last["shippingCostCents"] ?? 0,
          fulfillmentMode: last["fulfillmentMode"] ?? "PLATFORM_SHIP",
          vendorLabelUrl: last["vendorLabelUrl"] ?? null,
          trackingNumber: last["trackingNumber"] ?? null,
          lines: [{ productCode: "TSH-BLK-M", productName: "Black Tee", quantity: 2 }],
        };
      }),
    },
    sku: { update: jest.fn(async () => ({})) },
    inventoryMovement: { create: jest.fn(async () => ({})) },
    orderLine: { create: jest.fn(async () => ({})) },
    orderEvent: { create: jest.fn(async (a: { data: Record<string, unknown> }) => orderEvents.push(a.data)) },
  };

  const prisma = {
    order: {
      findUnique: jest.fn(async () => overrides.existingOrder ?? null),
      findFirst: jest.fn(async () => overrides.existingOrder ?? null),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: "order-held", orderNumber: 1626, lines: [], ...data };
        created.push(row);
        return row;
      }),
      update: jest.fn(async () => ({})),
    },
    orderEvent: { create: jest.fn(async (a: { data: Record<string, unknown> }) => orderEvents.push(a.data)) },
    product: {
      findMany: jest.fn(async () => overrides.products ?? [PRODUCT_ROW]),
    },
    vendor: {
      findUniqueOrThrow: jest.fn(async () => ({
        integrationDefaultCarrierService: null,
        integrationDefaultInsurance: false,
      })),
      findUnique: jest.fn(async () => ({ businessName: "Acme" })),
    },
    $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(txMock)),
  };

  const wallet = {
    get: jest.fn(async () => ({ balanceCents: overrides.balanceCents ?? 1_000_000 })),
    debit: jest.fn(async (args: unknown) => {
      debits.push(args);
      return { entry: {}, balanceAfterCents: 0 };
    }),
  };
  const smarty = {
    verifyUS: jest.fn(async () => ({ outcome: overrides.addressOutcome ?? "ACCEPTED", detail: undefined })),
  };
  const shippo = {
    getRates: jest.fn(async () => ({
      shipmentId: "shp_1",
      rates:
        overrides.rates ??
        [{ rateId: "rate_1", shipmentId: "shp_1", carrier: "USPS", service: "Priority", estimatedDeliveryDays: 2, costCents: 800 }],
    })),
  };
  const audit = { log: jest.fn(async () => {}) };
  const opsAlerts = { send: jest.fn(async () => {}) };
  const notifications = { emit: jest.fn(async () => {}) };
  const r2 = {
    generateKey: jest.fn((prefix: string, name: string) => `${prefix}/${name}`),
    putObject: jest.fn(async () => ({ publicUrl: "https://r2.example/label.pdf", key: "k" })),
  };

  const svc = new IntegrationOrderService(
    prisma as never,
    wallet as never,
    smarty as never,
    shippo as never,
    audit as never,
    opsAlerts as never,
    notifications as never,
    r2 as never,
  );
  return { svc, prisma, wallet, smarty, shippo, r2, created, orderEvents, debits };
}

describe("IntegrationOrderService.ingest (v2)", () => {
  it("is idempotent — a duplicate externalReference returns the existing order, no charge", async () => {
    const { svc, wallet } = makeService({
      existingOrder: {
        id: "existing",
        orderNumber: 1,
        externalReference: "STORE-1001",
        status: "PENDING_PACKING",
        holdReason: null,
        carrierService: null,
        totalChargedCents: 398,
        trackingNumber: null,
        lines: [],
      },
    });
    const r = await svc.ingest({ vendorId: VENDOR, apiKeyId: null, input: baseInput() });
    expect(r.id).toBe("existing");
    expect(wallet.debit).not.toHaveBeenCalled();
  });

  it("platform-ship: charges FULFILLMENT only and lands PENDING_PACKING", async () => {
    const { svc, wallet, created } = makeService({});
    const r = await svc.ingest({ vendorId: VENDOR, apiKeyId: null, input: baseInput() });
    expect(r.held).toBe(false);
    expect(wallet.debit).toHaveBeenCalledTimes(1);
    const row = created.find((c) => c["status"] === "PENDING_PACKING")!;
    expect(row["shippingCostCents"]).toBe(0);
    expect(row["fulfillmentMode"]).toBe("PLATFORM_SHIP");
    expect(row["totalChargedCents"]).toBe(row["fulfillmentFeeCents"]);
  });

  it("vendor-carrier: stores the pass-through label, charges fulfillment only, no shipping", async () => {
    const { svc, created } = makeService({});
    const input = {
      ...baseInput(),
      fulfillmentMode: "VENDOR_CARRIER" as const,
      vendorCarrier: { carrier: "UPS", tracking: "1Z999AA10123456784", labelUrl: "https://store/label.pdf" },
    };
    const r = await svc.ingest({ vendorId: VENDOR, apiKeyId: null, input });
    expect(r.held).toBe(false);
    const row = created.find((c) => c["fulfillmentMode"] === "VENDOR_CARRIER")!;
    expect(row["vendorLabelUrl"]).toBe("https://store/label.pdf");
    expect(row["shippingCostCents"]).toBe(0);
  });

  it("uploads a base64 vendor label to R2 and stores the URL", async () => {
    const { svc, r2, created } = makeService({});
    const input = {
      ...baseInput(),
      fulfillmentMode: "VENDOR_CARRIER" as const,
      vendorCarrier: {
        carrier: "USPS",
        tracking: "9400100000000000000000",
        labelBase64: Buffer.from("%PDF-1.4 fake").toString("base64"),
        labelContentType: "application/pdf" as const,
      },
    };
    const r = await svc.ingest({ vendorId: VENDOR, apiKeyId: null, input });
    expect(r.held).toBe(false);
    expect(r2.putObject).toHaveBeenCalledTimes(1);
    const row = created.find((c) => c["fulfillmentMode"] === "VENDOR_CARRIER")!;
    expect(row["vendorLabelUrl"]).toBe("https://r2.example/label.pdf");
  });

  it("resolves a line sent with the vendor's own store SKU (mapping table)", async () => {
    const { svc, wallet } = makeService({});
    const input = { ...baseInput(), lines: [{ sku: "STORE-TEE-1", quantity: 2 }] };
    const r = await svc.ingest({ vendorId: VENDOR, apiKeyId: null, input });
    // Mapped via product.storeSku → not held, fulfillment charged once.
    expect(r.held).toBe(false);
    expect(wallet.debit).toHaveBeenCalledTimes(1);
  });

  it("holds UNMAPPED_SKU without touching the wallet", async () => {
    const { svc, wallet } = makeService({ products: [] });
    const r = await svc.ingest({ vendorId: VENDOR, apiKeyId: null, input: baseInput() });
    expect(r.held).toBe(true);
    expect(r.holdReason).toBe("UNMAPPED_SKU");
    expect(wallet.debit).not.toHaveBeenCalled();
  });

  it("holds INSUFFICIENT_FUNDS (against the fulfillment fee) without charging", async () => {
    const { svc, wallet } = makeService({ balanceCents: 0 });
    const r = await svc.ingest({ vendorId: VENDOR, apiKeyId: null, input: baseInput() });
    expect(r.held).toBe(true);
    expect(r.holdReason).toBe("INSUFFICIENT_FUNDS");
    expect(wallet.debit).not.toHaveBeenCalled();
  });
});
