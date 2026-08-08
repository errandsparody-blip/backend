/**
 * ReturnService — return-eligibility gate tests (Returns v2).
 *
 * These cover the mode-aware eligibility branch in `create`, which
 * throws BEFORE any transaction runs — so mocking `order.findFirst` is
 * enough. There is no longer any time-window enforcement (the age limit
 * is the vendor's own policy), so only the shipped-state gate is tested
 * here. The receive/inspect/instruct/finalize transaction paths are out
 * of scope for this pre-flight spec.
 */

import { ConflictException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";

import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../audit/audit.service";
import { NotificationService } from "../notifications/notification.service";
import { WalletService } from "../wallet/wallet.service";

import { ReturnService } from "./return.service";

const VENDOR_ID = "11111111-1111-1111-1111-111111111111";
const ACTOR_ID = "22222222-2222-2222-2222-222222222222";
const ORDER_ID = "33333333-3333-3333-3333-333333333333";
const LINE_ID = "44444444-4444-4444-4444-444444444444";

function baseInput() {
  return {
    orderId: ORDER_ID,
    reason: "DEFECTIVE" as const,
    lines: [{ orderLineId: LINE_ID, requestedQty: 1 }],
    inboundTracking: "1Z999AA10123456784",
    inboundCarrier: "UPS",
    expectedDeliveryDate: new Date(),
    attachmentUrls: [] as string[],
  };
}

describe("ReturnService — eligibility gate (v2)", () => {
  let svc: ReturnService;
  let prisma: { order: { findFirst: jest.Mock } };

  beforeEach(async () => {
    prisma = { order: { findFirst: jest.fn() } };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ReturnService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: WalletService, useValue: { debit: jest.fn() } },
        { provide: NotificationService, useValue: { emit: jest.fn() } },
      ],
    }).compile();
    svc = moduleRef.get(ReturnService);
  });

  it("rejects a PLATFORM_SHIP order that is only HANDED_OFF (needs delivery)", async () => {
    prisma.order.findFirst.mockResolvedValueOnce({
      id: ORDER_ID,
      status: "HANDED_OFF",
      fulfillmentMode: "PLATFORM_SHIP",
      deliveredAt: null,
      handedOffAt: new Date(),
      lines: [{ id: LINE_ID, quantity: 5, skuId: "sku" }],
    });
    await expect(svc.create(VENDOR_ID, ACTOR_ID, baseInput())).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("rejects a VENDOR_CARRIER order that is still PACKING_COMPLETED (too early)", async () => {
    prisma.order.findFirst.mockResolvedValueOnce({
      id: ORDER_ID,
      status: "PACKING_COMPLETED",
      fulfillmentMode: "VENDOR_CARRIER",
      deliveredAt: null,
      handedOffAt: null,
      lines: [{ id: LINE_ID, quantity: 5, skuId: "sku" }],
    });
    await expect(svc.create(VENDOR_ID, ACTOR_ID, baseInput())).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("does NOT reject based on order age (no return window enforced)", async () => {
    // A very old delivered order must still pass the eligibility gate —
    // the time limit is the vendor's policy, not ours. We stop at the
    // first transaction boundary (order.update is undefined on our mock),
    // which proves the age check did not throw a ConflictException.
    prisma.order.findFirst.mockResolvedValueOnce({
      id: ORDER_ID,
      status: "DELIVERED",
      fulfillmentMode: "PLATFORM_SHIP",
      deliveredAt: new Date("2020-01-01T00:00:00Z"),
      handedOffAt: null,
      lines: [{ id: LINE_ID, quantity: 5, skuId: "sku" }],
    });
    await expect(
      svc.create(VENDOR_ID, ACTOR_ID, baseInput()),
    ).rejects.not.toBeInstanceOf(ConflictException);
  });
});
