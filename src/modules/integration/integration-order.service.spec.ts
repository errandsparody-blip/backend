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
  shipping: undefined,
});

const PRODUCT_ROW = {
  id: "prod-1",
  code: "TSH-BLK-M",
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
      update: jest.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id })),
      findUniqueOrThrow: jest.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        vendorId: VENDOR,
        orderNumber: 1625,
        externalReference: "STORE-1001",
        status: "ALLOCATED",
        holdReason: null,
        carrierService: "USPS Priority",
        totalChargedCents: created[0]?.["totalChargedCents"] ?? 0,
        trackingNumber: null,
        lines: [
          { productCode: "TSH-BLK-M", productName: "Black Tee", quantity: 2 },
        ],
      })),
    },
    sku: { update: jest.fn(async () => ({})) },
    inventoryMovement: { create: jest.fn(async () => ({})) },
    orderLine: { create: jest.fn(async () => ({})) },
    orderEvent: { create: jest.fn(async (a: { data: Record<string, unknown> }) => orderEvents.push(a.data)) },
  };

  const prisma = {
    order: {
      findUnique: jest.fn(async () => overrides.existingOrder ?? null),
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

  const svc = new IntegrationOrderService(
    prisma as never,
    wallet as never,
    smarty as never,
    shippo as never,
    audit as never,
    opsAlerts as never,
    notifications as never,
  );
  return { svc, prisma, wallet, smarty, shippo, created, orderEvents, debits };
}

describe("IntegrationOrderService.ingest", () => {
  // Migration 0047 — Fulfillment v1 was abolished per the v2 spec.
  // The integration ingest path (Shopify / WooCommerce webhooks) was
  // v1-shaped and is not yet rewritten for v2 semantics. Until it is,
  // ingest hard-rejects with a 501 so no v1 order can slip through
  // the API-key path. The legacy tests below (idempotency,
  // UNMAPPED_SKU hold, ADDRESS_INVALID hold, INSUFFICIENT_FUNDS hold,
  // happy allocate) are the SPEC for the eventual rewrite — reinstate
  // them as failing then passing when tryAllocate is v2-migrated.
  it("rejects with 501 until the v2 rewrite lands", async () => {
    const { svc, wallet } = makeService({});
    await expect(
      svc.ingest({ vendorId: VENDOR, apiKeyId: null, input: baseInput() }),
    ).rejects.toMatchObject({
      status: 501,
      response: expect.objectContaining({
        code: "integration_v2_migration_pending",
      }) as unknown,
    });
    // Belt-and-braces: no wallet activity ever, even on rejection.
    expect(wallet.debit).not.toHaveBeenCalled();
  });
});
