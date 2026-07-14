/**
 * BarcodeService — validation and error-translation tests.
 *
 * Focuses on the guards that MUST NOT be bypassed:
 *   * malformed barcodes are rejected BEFORE Prisma is touched
 *   * missing product returns NotFoundException (never confirms
 *     existence to an unauthorised caller)
 *   * P2002 (unique violation) is rethrown as ConflictException
 *     `barcode_taken`
 *   * remove() with an unknown id returns 404
 */

import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";

import type { PrismaService } from "../../common/prisma.service";

import { BarcodeService } from "./barcode.service";

class FakePrisma {
  product = {
    // Widen return type so tests can override with a row.
    findFirst: jest.fn<Promise<unknown>, [unknown]>(async () => null),
  };
  productBarcode = {
    findMany: jest.fn<Promise<unknown[]>, [unknown]>(async () => []),
    findUnique: jest.fn<Promise<unknown>, [unknown]>(async () => null),
    delete: jest.fn<Promise<unknown>, [unknown]>(async () => ({})),
  };
  // Simple $transaction that just runs the callback with `this`.
  // Widen the parameter type so tests can override via mockImplementationOnce.
  $transaction = jest.fn(
    async (cb: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
      return cb(this);
    },
  );
}

describe("BarcodeService", () => {
  let svc: BarcodeService;
  let prisma: FakePrisma;

  const PRODUCT_ID = "11111111-1111-1111-1111-111111111111";
  const ACTOR_ID = "22222222-2222-2222-2222-222222222222";

  beforeEach(() => {
    prisma = new FakePrisma();
    svc = new BarcodeService(prisma as unknown as PrismaService);
  });

  // -------------------------------------------------------------------------
  // register — validation guards
  // -------------------------------------------------------------------------

  it("register: rejects an empty barcode without hitting Prisma", async () => {
    await expect(
      svc.register(PRODUCT_ID, ACTOR_ID, { barcode: "" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.product.findFirst).not.toHaveBeenCalled();
  });

  it("register: rejects a barcode containing whitespace", async () => {
    await expect(
      svc.register(PRODUCT_ID, ACTOR_ID, { barcode: "012 345" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("register: rejects a barcode over 48 chars", async () => {
    await expect(
      svc.register(PRODUCT_ID, ACTOR_ID, { barcode: "0".repeat(49) }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("register: rejects an unknown symbology", async () => {
    prisma.product.findFirst.mockResolvedValueOnce({ id: PRODUCT_ID });
    await expect(
      svc.register(PRODUCT_ID, ACTOR_ID, {
        barcode: "012345",
        // Cast the invalid literal so TS lets us test the runtime guard.
        symbology: "NOT_A_SYMBOLOGY" as unknown as "OTHER",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("register: rejects when the product does not exist", async () => {
    await expect(
      svc.register(PRODUCT_ID, ACTOR_ID, { barcode: "012345" }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("register: rethrows P2002 as barcode_taken ConflictException", async () => {
    prisma.product.findFirst.mockResolvedValueOnce({ id: PRODUCT_ID });
    // The transaction body calls productBarcode.create — make it throw
    // a synthetic P2002 to simulate the unique-constraint violation.
    const fakeCreate = jest.fn().mockRejectedValueOnce(
      Object.assign(new Error("Unique violation"), { code: "P2002" }),
    );
    const fakeUpdateMany = jest.fn(async () => ({ count: 0 }));
    prisma.$transaction.mockImplementationOnce(async (cb) => {
      const cbFn = cb as (tx: {
        productBarcode: { create: typeof fakeCreate; updateMany: typeof fakeUpdateMany };
      }) => Promise<unknown>;
      return cbFn({
        productBarcode: {
          create: fakeCreate,
          updateMany: fakeUpdateMany,
        },
      });
    });
    await expect(
      svc.register(PRODUCT_ID, ACTOR_ID, { barcode: "dupecode" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  // -------------------------------------------------------------------------
  // lookup
  // -------------------------------------------------------------------------

  it("lookup: returns null for a malformed barcode WITHOUT touching Prisma", async () => {
    // Empty string after trim → normalise() returns null → fast path.
    await expect(svc.lookup("   ")).resolves.toBeNull();
    // Even valid-lookup path hits findUnique; the invalid guard should
    // short-circuit before that.
    expect(prisma.productBarcode.findUnique).not.toHaveBeenCalled();
  });

  it("lookup: returns null for a barcode not in the database", async () => {
    prisma.productBarcode.findUnique.mockResolvedValueOnce(null);
    await expect(svc.lookup("012345")).resolves.toBeNull();
  });

  it("lookup: unwraps the joined product fields", async () => {
    prisma.productBarcode.findUnique.mockResolvedValueOnce({
      id: "bc-1",
      productId: PRODUCT_ID,
      barcode: "012345",
      symbology: "UPC_A",
      isPrimary: true,
      createdAt: new Date(),
      product: {
        vendorId: "vendor-1",
        name: "Widget",
        code: "WDG",
        variant: "STD",
      },
    });
    const match = await svc.lookup("012345");
    expect(match).toEqual({
      barcodeId: "bc-1",
      productId: PRODUCT_ID,
      vendorId: "vendor-1",
      productName: "Widget",
      productCode: "WDG",
      variant: "STD",
      symbology: "UPC_A",
    });
  });

  // -------------------------------------------------------------------------
  // remove
  // -------------------------------------------------------------------------

  it("remove: surfaces P2025 as NotFoundException", async () => {
    prisma.productBarcode.delete.mockRejectedValueOnce(
      Object.assign(new Error("Not found"), { code: "P2025" }),
    );
    await expect(svc.remove("id-1")).rejects.toBeInstanceOf(NotFoundException);
  });
});
