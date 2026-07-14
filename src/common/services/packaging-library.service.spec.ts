/**
 * PackagingLibraryService — validation-guard unit tests.
 *
 * Covers the pure validation surface (regex, ranges, integer checks).
 * The DB-touching paths are covered by integration tests; here we
 * only need to be sure that a malformed input can never reach
 * Prisma. Prisma is faked so the create/update/getById methods can
 * be exercised end-to-end.
 */

import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";

import type { PrismaService } from "../prisma.service";

import { PackagingLibraryService } from "./packaging-library.service";

class FakePrisma {
  packagingOption = {
    findMany: jest.fn(async () => []),
    findUnique: jest.fn(async () => null),
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "00000000-0000-0000-0000-000000000001",
      code: data.code,
      label: data.label,
      lengthIn: data.lengthIn,
      widthIn: data.widthIn,
      heightIn: data.heightIn,
      tareWeightOz: data.tareWeightOz ?? 0,
      isActive: true,
      sortOrder: data.sortOrder ?? 100,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
      id: where.id,
      code: "test",
      label: (data.label as string) ?? "existing",
      lengthIn: (data.lengthIn as number) ?? 5,
      widthIn: (data.widthIn as number) ?? 5,
      heightIn: (data.heightIn as number) ?? 5,
      tareWeightOz: (data.tareWeightOz as number) ?? 0,
      isActive: (data.isActive as boolean) ?? true,
      sortOrder: (data.sortOrder as number) ?? 100,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
  };
}

describe("PackagingLibraryService — validation", () => {
  let svc: PackagingLibraryService;
  let prisma: FakePrisma;

  beforeEach(() => {
    prisma = new FakePrisma();
    svc = new PackagingLibraryService(prisma as unknown as PrismaService);
  });

  // -------------------------------------------------------------------------
  // create — happy path + validation failures
  // -------------------------------------------------------------------------

  it("create: rejects a code that doesn't match [a-z0-9_-]{2,32}", async () => {
    await expect(
      svc.create({
        code: "!!bad!!",
        label: "Whatever",
        lengthIn: 5,
        widthIn: 5,
        heightIn: 5,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.packagingOption.create).not.toHaveBeenCalled();
  });

  it("create: lower-cases the code before insert (uniqueness safety)", async () => {
    await svc.create({
      code: "USPS_FLAT_MED",
      label: "USPS Medium",
      lengthIn: 11,
      widthIn: 8.5,
      heightIn: 5.5,
    });
    const args = prisma.packagingOption.create.mock.calls[0]![0] as {
      data: { code: string };
    };
    expect(args.data.code).toBe("usps_flat_med");
  });

  it("create: rejects a zero-length dimension", async () => {
    await expect(
      svc.create({
        code: "boxfail",
        label: "Zero length",
        lengthIn: 0,
        widthIn: 5,
        heightIn: 5,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("create: rejects a dimension over 48 in", async () => {
    await expect(
      svc.create({
        code: "boxfail",
        label: "Too big",
        lengthIn: 50,
        widthIn: 5,
        heightIn: 5,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("create: rejects a fractional tareWeightOz", async () => {
    await expect(
      svc.create({
        code: "boxfail",
        label: "Half oz",
        lengthIn: 5,
        widthIn: 5,
        heightIn: 5,
        tareWeightOz: 1.5,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("create: rejects a tareWeightOz over 400", async () => {
    await expect(
      svc.create({
        code: "boxfail",
        label: "Heavy tare",
        lengthIn: 5,
        widthIn: 5,
        heightIn: 5,
        tareWeightOz: 401,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("create: rejects an empty label", async () => {
    await expect(
      svc.create({
        code: "boxfail",
        label: "",
        lengthIn: 5,
        widthIn: 5,
        heightIn: 5,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("create: rethrows Prisma P2002 as a code_taken conflict", async () => {
    prisma.packagingOption.create.mockRejectedValueOnce(
      Object.assign(new Error("Unique violation"), { code: "P2002" }),
    );
    await expect(
      svc.create({
        code: "dupe",
        label: "Duplicate",
        lengthIn: 5,
        widthIn: 5,
        heightIn: 5,
      }),
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

  it("update: rejects a non-integer sortOrder", async () => {
    await expect(
      svc.update("id-1", { sortOrder: 1.5 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("update: surfaces Prisma P2025 as NotFoundException", async () => {
    prisma.packagingOption.update.mockRejectedValueOnce(
      Object.assign(new Error("Record not found"), { code: "P2025" }),
    );
    await expect(
      svc.update("id-1", { label: "New label" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
