/**
 * InventoryLocationService — validation and error-translation tests.
 *
 * Same pattern as the packaging-library spec: DB is faked, we assert
 * only that the guards can't be bypassed and that the Prisma error
 * translations (P2002 → ConflictException, P2025 → NotFoundException)
 * are correct.
 */

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";

import type { PrismaService } from "../prisma.service";

import { InventoryLocationService } from "./inventory-location.service";

class FakePrisma {
  inventoryLocation = {
    findMany: jest.fn<Promise<unknown[]>, [unknown]>(async () => []),
    findUnique: jest.fn<Promise<unknown>, [unknown]>(async () => null),
    create: jest.fn<Promise<unknown>, [unknown]>(async (args: unknown) => {
      const { data } = args as { data: Record<string, unknown> };
      return {
        id: "00000000-0000-0000-0000-000000000010",
        code: data.code,
        label: data.label,
        aisle: data.aisle ?? null,
        bay: data.bay ?? null,
        shelf: data.shelf ?? null,
        bin: data.bin ?? null,
        isActive: true,
        sortOrder: data.sortOrder ?? 100,
        notes: data.notes ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }),
    update: jest.fn<Promise<unknown>, [unknown]>(async (args: unknown) => {
      const { where, data } = args as {
        where: { id: string };
        data: Record<string, unknown>;
      };
      return {
        id: where.id,
        code: "A-01",
        label: (data.label as string) ?? "Existing",
        aisle: null,
        bay: null,
        shelf: null,
        bin: null,
        isActive: (data.isActive as boolean) ?? true,
        sortOrder: (data.sortOrder as number) ?? 100,
        notes: (data.notes as string | null) ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }),
  };
  sku = {
    findUnique: jest.fn<Promise<unknown>, [unknown]>(async () => null),
    update: jest.fn<Promise<unknown>, [unknown]>(async () => ({})),
  };
}

describe("InventoryLocationService", () => {
  let svc: InventoryLocationService;
  let prisma: FakePrisma;

  beforeEach(() => {
    prisma = new FakePrisma();
    svc = new InventoryLocationService(prisma as unknown as PrismaService);
  });

  // -------------------------------------------------------------------------
  // create — validation guards
  // -------------------------------------------------------------------------

  it("create: rejects a code that doesn't match [A-Z0-9-]{2,32}", async () => {
    await expect(
      svc.create({ code: "bad space", label: "OK" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.inventoryLocation.create).not.toHaveBeenCalled();
  });

  it("create: upper-cases the code before insert", async () => {
    await svc.create({ code: "a-01", label: "Aisle A / 01" });
    const args = prisma.inventoryLocation.create.mock.calls[0]![0] as {
      data: { code: string };
    };
    expect(args.data.code).toBe("A-01");
  });

  it("create: rejects an empty label", async () => {
    await expect(
      svc.create({ code: "A-02", label: "" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("create: rejects sortOrder outside 0..10000", async () => {
    await expect(
      svc.create({ code: "A-03", label: "OK", sortOrder: 10_001 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("create: rethrows P2002 as location_code_taken", async () => {
    prisma.inventoryLocation.create.mockRejectedValueOnce(
      Object.assign(new Error("Unique violation"), { code: "P2002" }),
    );
    await expect(
      svc.create({ code: "A-04", label: "Dup" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  // -------------------------------------------------------------------------
  // update
  // -------------------------------------------------------------------------

  it("update: rejects when no fields are provided", async () => {
    await expect(svc.update("id-1", {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("update: surfaces P2025 as NotFoundException", async () => {
    prisma.inventoryLocation.update.mockRejectedValueOnce(
      Object.assign(new Error("Not found"), { code: "P2025" }),
    );
    await expect(
      svc.update("id-1", { label: "New" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // -------------------------------------------------------------------------
  // assignToSku
  // -------------------------------------------------------------------------

  it("assignToSku: null locationId clears assignment without a location read", async () => {
    const result = await svc.assignToSku("SKU-1", null);
    expect(result).toEqual({ skuId: "SKU-1", locationId: null });
    expect(prisma.inventoryLocation.findUnique).not.toHaveBeenCalled();
    expect(prisma.sku.update).toHaveBeenCalledTimes(1);
  });

  it("assignToSku: rejects an unknown location", async () => {
    await expect(
      svc.assignToSku("SKU-1", "77777777-7777-7777-7777-777777777777"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("assignToSku: rejects an inactive location", async () => {
    prisma.inventoryLocation.findUnique.mockResolvedValueOnce({
      id: "loc-1",
      code: "A-01",
      label: "Aisle A",
      aisle: "A",
      bay: null,
      shelf: null,
      bin: null,
      isActive: false,
      sortOrder: 100,
      notes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await expect(svc.assignToSku("SKU-1", "loc-1")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("assignToSku: surfaces P2025 (unknown SKU) as NotFoundException", async () => {
    prisma.inventoryLocation.findUnique.mockResolvedValueOnce({
      id: "loc-1",
      code: "A-01",
      label: "Aisle A",
      aisle: "A",
      bay: null,
      shelf: null,
      bin: null,
      isActive: true,
      sortOrder: 100,
      notes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.sku.update.mockRejectedValueOnce(
      Object.assign(new Error("Not found"), { code: "P2025" }),
    );
    await expect(
      svc.assignToSku("UNKNOWN-SKU", "loc-1"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
