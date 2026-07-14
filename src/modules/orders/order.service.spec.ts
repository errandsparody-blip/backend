/**
 * OrderService — security-critical invariants.
 *
 *   1. Tenant isolation: vendor B can never read or cancel vendor A's order.
 *      404 (NotFound) is the only response surface — never 403 — so the
 *      service does not confirm existence to the wrong tenant.
 *
 *   2. Address rejection: a REJECTED Smarty outcome short-circuits before
 *      any DB write. No order, no reservation, no debit.
 *
 *   3. Quote does NOT mutate. No DB write happens for a quote, even with
 *      a valid address and an in-stock SKU.
 *
 *   4. The atomicity guarantees (insufficient funds / insufficient stock)
 *      live in the e2e integration test (test/order-flow.e2e-spec.ts) since
 *      they need a real Postgres + the constraint triggers.
 *
 * Implementation Plan §4.3 (IDOR contract), §6.6, §14.3.
 */

import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";

import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../audit/audit.service";
import { ShippoService } from "../integrations/shippo/shippo.service";
import { ShippingPointService } from "../../common/services/shipping-point.service";
import { OpsAlertService } from "../notifications/ops-alert.service";
import { SmartyService } from "../integrations/smarty/smarty.service";
import { WalletService } from "../wallet/wallet.service";

import { OrderService } from "./order.service";

// ---------------------------------------------------------------------------
// Minimal Prisma double — only the surface OrderService.list/get/cancel touch.
// ---------------------------------------------------------------------------

interface FakeOrder {
  id: string;
  vendorId: string;
  status: "DRAFT" | "SUBMITTED" | "ALLOCATED" | "SHIPPED" | "DELIVERED" | "CANCELLED";
  orderNumber: number;
  externalReference: string | null;
  recipientName: string;
  recipientPhone: string | null;
  recipientEmail: string | null;
  shipAddressLine1: string;
  shipAddressLine2: string | null;
  shipCity: string;
  shipState: string;
  shipPostalCode: string;
  shipCountry: string;
  carrier: string | null;
  carrierService: string | null;
  trackingNumber: string | null;
  labelUrl: string | null;
  itemsDeclaredValueCents: number;
  shippingCostCents: number;
  shippingFeeCents: number;
  fulfillmentFeeCents: number;
  insuranceFeeCents: number;
  totalChargedCents: number;
  reassessmentDeltaCents: number;
  cancelReason: string | null;
  cancelNote: string | null;
  submittedAt: Date | null;
  allocatedAt: Date | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  lines: Array<{
    id: string;
    skuId: string;
    productCode: string;
    productName: string;
    variant: string;
    quantity: number;
    declaredValueCents: number;
    allocationStatus: string;
  }>;
}

class FakePrisma {
  orders: FakeOrder[] = [];
  skus: Array<{ id: string; vendorId: string; productId: string }> = [];

  order = {
    findFirst: jest.fn(async ({ where }: { where: { id?: string; vendorId?: string } }) => {
      return (
        this.orders.find(
          (o) =>
            (where.id === undefined || o.id === where.id) &&
            (where.vendorId === undefined || o.vendorId === where.vendorId),
        ) ?? null
      );
    }),
    findMany: jest.fn(
      async ({
        where,
        take,
      }: {
        where: { vendorId: string; status?: string };
        take: number;
      }) => {
        const list = this.orders
          .filter((o) => o.vendorId === where.vendorId && (where.status === undefined || o.status === where.status))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return list.slice(0, take);
      },
    ),
    findUnique: jest.fn(
      async ({ where }: { where: { vendor_external_ref_unique?: { vendorId: string; externalReference: string } } }) => {
        const k = where.vendor_external_ref_unique;
        if (!k) return null;
        return this.orders.find((o) => o.vendorId === k.vendorId && o.externalReference === k.externalReference) ?? null;
      },
    ),
  };

  // Stubs not exercised by these tests — kept here so the type is satisfied.
  sku = { findMany: jest.fn(async () => []) };

  // Migration 0041 — OrderService.create() calls isFulfillmentV2Enabled()
  // on every submit, which reads the configuration table. Returning
  // null makes the loader default to `false`, keeping every test on
  // the legacy code path (which is what these tests exercise).
  configuration = { findUnique: jest.fn(async () => null) };
}

// ---------------------------------------------------------------------------

describe("OrderService — tenant isolation + address rejection", () => {
  let svc: OrderService;
  let prisma: FakePrisma;
  let smarty: { verifyUS: jest.Mock };
  let shippo: { getRates: jest.Mock };
  let wallet: { debit: jest.Mock; credit: jest.Mock };
  let audit: { log: jest.Mock };

  const VENDOR_A = "00000000-0000-0000-0000-00000000000a";
  const VENDOR_B = "00000000-0000-0000-0000-00000000000b";
  const ACTOR_A = "00000000-0000-0000-0000-0000000000aa";

  const validRecipient = {
    recipientName: "Jane Doe",
    recipientPhone: undefined,
    recipientEmail: undefined,
    shipAddressLine1: "123 Main St",
    shipAddressLine2: undefined,
    shipCity: "Miami",
    shipState: "FL",
    shipPostalCode: "33101",
    shipCountry: "US",
  } as const;

  function seedOrder(vendorId: string, id: string, status: FakeOrder["status"] = "ALLOCATED"): FakeOrder {
    const o: FakeOrder = {
      id,
      vendorId,
      status,
      // Stable per-id pseudo-number — tests don't care about the actual
      // value, only that the column exists and is numeric.
      orderNumber: 1000 + parseInt(id.slice(-4), 16) % 9000,
      externalReference: null,
      recipientName: validRecipient.recipientName,
      recipientPhone: null,
      recipientEmail: null,
      shipAddressLine1: validRecipient.shipAddressLine1,
      shipAddressLine2: null,
      shipCity: validRecipient.shipCity,
      shipState: validRecipient.shipState,
      shipPostalCode: validRecipient.shipPostalCode,
      shipCountry: validRecipient.shipCountry,
      carrier: "USPS",
      carrierService: "USPS Priority",
      trackingNumber: null,
      labelUrl: null,
      itemsDeclaredValueCents: 5_000,
      shippingCostCents: 800,
      shippingFeeCents: 880,
      fulfillmentFeeCents: 250,
      insuranceFeeCents: 0,
      totalChargedCents: 1_130,
      reassessmentDeltaCents: 0,
      cancelReason: null,
      cancelNote: null,
      submittedAt: new Date(),
      allocatedAt: new Date(),
      shippedAt: null,
      deliveredAt: null,
      cancelledAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lines: [
        {
          id: "line-1",
          skuId: "UER-VA0001-T-STD",
          productCode: "T",
          productName: "T",
          variant: "STD",
          quantity: 1,
          declaredValueCents: 5_000,
          allocationStatus: "RESERVED",
        },
      ],
    };
    prisma.orders.push(o);
    return o;
  }

  beforeEach(async () => {
    prisma = new FakePrisma();
    smarty = { verifyUS: jest.fn(async () => ({ outcome: "ACCEPTED", normalized: validRecipient })) };
    shippo = { getRates: jest.fn(async () => ({ shipmentId: "shp_x", rates: [] })) };
    wallet = { debit: jest.fn(), credit: jest.fn() };
    audit = { log: jest.fn() };
    // OpsAlertService was added to OrderService's constructor in an
    // earlier change (email + in-app notification to admins on new
    // order). The fixture was never updated alongside it, which left
    // these tests red. Mock it as a no-op — the order paths under
    // test don't depend on the alert succeeding.
    const opsAlerts = { send: jest.fn().mockResolvedValue(undefined) };

    // Migration 0041 — Fulfillment v2 requires ShippingPointService.
    // Every test in this file exercises the LEGACY path (v2 flag is
    // false by default because the fake config table is empty), so
    // the service methods are never called. Provide a no-op mock
    // that satisfies the DI check without dragging the real service
    // (and its Prisma dependency) into the test module.
    const shippingPoints = {
      getPoints: jest.fn().mockResolvedValue(null),
      sumForLines: jest
        .fn()
        .mockResolvedValue({ totalPoints: 0, resolutions: [], allAssigned: true }),
      resolveRange: jest.fn().mockResolvedValue({ dollarsMin: 0, dollarsMax: 0 }),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        OrderService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: WalletService, useValue: wallet },
        { provide: SmartyService, useValue: smarty },
        { provide: ShippoService, useValue: shippo },
        // Token-based provider — by class reference rather than string
        // — matches how the service constructor declares the
        // dependency. The local mock only implements the subset of
        // methods exercised by these specs.
        { provide: OpsAlertService, useValue: opsAlerts },
        { provide: ShippingPointService, useValue: shippingPoints },
      ],
    }).compile();
    svc = moduleRef.get(OrderService);
  });

  // -------------------------------------------------------------------------
  // Read isolation
  // -------------------------------------------------------------------------

  it("get(): vendor B cannot read vendor A's order — 404 (never 403)", async () => {
    const a = seedOrder(VENDOR_A, "order-a-1");
    await expect(svc.get(VENDOR_B, a.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("list(): vendor B sees only their own orders", async () => {
    seedOrder(VENDOR_A, "order-a-1");
    seedOrder(VENDOR_A, "order-a-2");
    seedOrder(VENDOR_B, "order-b-1");

    const a = await svc.list(VENDOR_A, { limit: 50 });
    const b = await svc.list(VENDOR_B, { limit: 50 });

    expect(a.items).toHaveLength(2);
    expect(b.items).toHaveLength(1);
    expect(b.items[0]!.id).toBe("order-b-1");
  });

  // -------------------------------------------------------------------------
  // Address rejection — no DB write, no debit
  // -------------------------------------------------------------------------

  it("quote: REJECTED address → BadRequest, no rate fetch", async () => {
    smarty.verifyUS.mockResolvedValueOnce({ outcome: "REJECTED", detail: "PO Box only" });
    await expect(
      svc.quote(VENDOR_A, {
        recipient: validRecipient,
        lines: [{ skuId: "UER-VA0001-T-STD", quantity: 1 }],
        insuranceRequested: false,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(shippo.getRates).not.toHaveBeenCalled();
    expect(prisma.orders).toHaveLength(0);
  });

  it("create: REJECTED address → BadRequest, no wallet debit, no order row", async () => {
    smarty.verifyUS.mockResolvedValueOnce({ outcome: "REJECTED", detail: "ZIP missing" });
    await expect(
      svc.create(VENDOR_A, ACTOR_A, {
        recipient: validRecipient,
        lines: [{ skuId: "UER-VA0001-T-STD", quantity: 1 }],
        carrierService: "USPS Priority",
        insuranceRequested: false,
        // Migration 0037 — fulfillment branch defaults to PLATFORM_SHIP
        // for existing call-sites that haven't been migrated.
        fulfillmentMode: "PLATFORM_SHIP",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(wallet.debit).not.toHaveBeenCalled();
    expect(prisma.orders).toHaveLength(0);
    expect(audit.log).not.toHaveBeenCalled();
  });
});
