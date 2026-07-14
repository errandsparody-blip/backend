/**
 * OrderPackService — unit surface tests.
 *
 * These tests exercise the input-validation guard in `recordPack` and
 * `selectRate` — the parts of the pipeline that fire BEFORE any DB
 * work. The transactional state-machine paths (SELECT FOR UPDATE,
 * wallet debit composition) are covered by the integration test suite;
 * mocking raw SQL execution here would only re-encode the SQL strings.
 *
 * What this file DOES cover:
 *   * `recordPack` rejects non-positive or non-finite dimensions.
 *   * `recordPack` rejects a non-integer weightOz.
 *   * `recordPack` rejects notes longer than 500 chars.
 *   * `selectRate` rejects a missing or empty rateProviderRef.
 *   * Tenant-isolation-adjacent guarantee: an unknown orderId returns
 *     404 (NotFoundException), never leaks existence to the caller.
 */

import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";

import { PrismaService } from "../../common/prisma.service";
import { PackagingLibraryService } from "../../common/services/packaging-library.service";
import { AuditService } from "../audit/audit.service";
import { ShippoService } from "../integrations/shippo/shippo.service";
import { WalletService } from "../wallet/wallet.service";

import { OrderPackService } from "./order-pack.service";

class FakePrisma {
  order = {
    findFirst: jest.fn(async () => null),
  };
}

describe("OrderPackService — pre-flight validation", () => {
  let svc: OrderPackService;
  let prisma: FakePrisma;

  const ORDER_ID = "11111111-1111-1111-1111-111111111111";
  const ACTOR_ID = "22222222-2222-2222-2222-222222222222";
  const RATE_REF = "rate_abc";

  beforeEach(async () => {
    prisma = new FakePrisma();
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const wallet = {
      debit: jest.fn(),
      get: jest.fn().mockResolvedValue({ balanceCents: 0 }),
    };
    const shippo = { getRates: jest.fn() };
    // Migration 0043 — new dep. These tests never exercise the
    // packaging branch (packagingOptionId is always absent in the
    // fixtures), so a no-op mock is sufficient.
    const packagingLibrary = {
      getById: jest.fn().mockResolvedValue(null),
      listActive: jest.fn().mockResolvedValue([]),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        OrderPackService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: WalletService, useValue: wallet },
        { provide: ShippoService, useValue: shippo },
        { provide: PackagingLibraryService, useValue: packagingLibrary },
      ],
    }).compile();
    svc = moduleRef.get(OrderPackService);
  });

  it("recordPack: rejects a zero-length dimension", async () => {
    await expect(
      svc.recordPack(ORDER_ID, ACTOR_ID, {
        lengthIn: 0,
        widthIn: 5,
        heightIn: 5,
        weightOz: 8,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("recordPack: rejects a non-finite dimension", async () => {
    await expect(
      svc.recordPack(ORDER_ID, ACTOR_ID, {
        lengthIn: Number.POSITIVE_INFINITY,
        widthIn: 5,
        heightIn: 5,
        weightOz: 8,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("recordPack: rejects fractional weightOz", async () => {
    await expect(
      svc.recordPack(ORDER_ID, ACTOR_ID, {
        lengthIn: 5,
        widthIn: 5,
        heightIn: 5,
        weightOz: 1.5,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("recordPack: rejects notes longer than 500 chars", async () => {
    await expect(
      svc.recordPack(ORDER_ID, ACTOR_ID, {
        lengthIn: 5,
        widthIn: 5,
        heightIn: 5,
        weightOz: 8,
        notes: "x".repeat(501),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("recordPack: unknown order returns 404 (never confirms existence)", async () => {
    // Valid dims so we get past the guard, then the pre-flight
    // findFirst returns null (our fake) and the service must 404.
    await expect(
      svc.recordPack(ORDER_ID, ACTOR_ID, {
        lengthIn: 5,
        widthIn: 5,
        heightIn: 5,
        weightOz: 8,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.order.findFirst).toHaveBeenCalledTimes(1);
  });

  it("selectRate: rejects an empty rate ref", async () => {
    await expect(svc.selectRate(ORDER_ID, ACTOR_ID, "")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    // The empty-string guard fires BEFORE the DB read.
    expect(prisma.order.findFirst).not.toHaveBeenCalled();
  });

  it("selectRate: unknown order returns 404", async () => {
    await expect(
      svc.selectRate(ORDER_ID, ACTOR_ID, RATE_REF),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
