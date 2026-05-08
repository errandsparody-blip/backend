/**
 * ProductService — tenant isolation (IDOR) tests.
 *
 * Implementation Plan §4.3:
 *   "Integration tests assert that a vendor cannot read another vendor's row
 *    through any endpoint. This is the IDOR test suite — it runs in CI and
 *    blocks merge if a single test fails."
 *
 * The shape of these tests is the contract for every vendor-scoped service we
 * write. Copy this file as a template when adding new modules.
 */

import { NotFoundException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";

import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../audit/audit.service";

import { ProductService } from "./product.service";

// ---------------------------------------------------------------------------
// In-memory PrismaService double — only the surface this service touches.
// ---------------------------------------------------------------------------

interface ProductRow {
  id: string;
  vendorId: string;
  code: string;
  name: string;
  variant: string;
  hsCode: string | null;
  countryOfOrigin: string;
  declaredValueCents: number;
  weightOz: number;
  lengthIn: number;
  widthIn: number;
  heightIn: number;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

class FakePrisma {
  rows: ProductRow[] = [];
  nextId = 1;

  product = {
    create: async ({ data }: { data: Omit<ProductRow, "id" | "createdAt" | "updatedAt" | "status" | "variant" | "hsCode"> & { variant?: string; hsCode?: string | null; status?: string } }) => {
      const dup = this.rows.find((r) => r.vendorId === data.vendorId && r.code === data.code);
      if (dup) {
        const e = new Error("unique") as Error & { code?: string };
        e.code = "P2002";
        throw e;
      }
      const row: ProductRow = {
        id: `p${this.nextId++}`,
        variant: data.variant ?? "STD",
        hsCode: data.hsCode ?? null,
        status: data.status ?? "ACTIVE",
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      this.rows.push(row);
      return row;
    },
    findFirst: async ({ where }: { where: { id?: string; vendorId?: string; status?: string } }) => {
      return this.rows.find(
        (r) =>
          (where.id === undefined || r.id === where.id) &&
          (where.vendorId === undefined || r.vendorId === where.vendorId) &&
          (where.status === undefined || r.status === where.status),
      ) ?? null;
    },
    findMany: async ({
      where,
      take,
      orderBy: _orderBy,
      cursor,
      skip,
    }: {
      where: { vendorId: string; status?: string };
      take: number;
      orderBy?: unknown;
      cursor?: { id: string };
      skip?: number;
    }) => {
      let list = this.rows.filter(
        (r) => r.vendorId === where.vendorId && (where.status === undefined || r.status === where.status),
      );
      list = [...list].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      if (cursor) {
        const idx = list.findIndex((r) => r.id === cursor.id);
        list = idx >= 0 ? list.slice(idx + (skip ?? 0)) : list;
      }
      return list.slice(0, take);
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<ProductRow> }) => {
      const r = this.rows.find((x) => x.id === where.id);
      if (!r) throw new Error("not found");
      Object.assign(r, data, { updatedAt: new Date() });
      return r;
    },
  };
}

// ---------------------------------------------------------------------------

describe("ProductService — tenant isolation (IDOR)", () => {
  let svc: ProductService;
  let prisma: FakePrisma;
  let audit: { log: jest.Mock };

  const VENDOR_A = "vendor-a";
  const VENDOR_B = "vendor-b";
  const ACTOR_A = "actor-a";
  const ACTOR_B = "actor-b";

  const validProduct = {
    code: "TSH-BLK-M",
    name: "T-shirt — Black, M",
    variant: "STD",
    countryOfOrigin: "NG",
    declaredValueCents: 1500,
    weightOz: 4,
    lengthIn: 12,
    widthIn: 9,
    heightIn: 1,
    storageTier: "SMALL",
  } as const;

  beforeEach(async () => {
    prisma = new FakePrisma();
    audit = { log: jest.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ProductService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    svc = moduleRef.get(ProductService);
  });

  // -------------------------------------------------------------------------
  // Read isolation
  // -------------------------------------------------------------------------

  it("get(): vendor B cannot read vendor A's product (NotFound, never Forbidden)", async () => {
    const a = await svc.create(VENDOR_A, ACTOR_A, validProduct);
    await expect(svc.get(VENDOR_B, a.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("list(): vendor B sees only their own products", async () => {
    await svc.create(VENDOR_A, ACTOR_A, validProduct);
    await svc.create(VENDOR_A, ACTOR_A, { ...validProduct, code: "TSH-RED-M", name: "Red M" });
    await svc.create(VENDOR_B, ACTOR_B, { ...validProduct, code: "PNT-BLU-32", name: "Blue 32" });

    const a = await svc.list(VENDOR_A, { limit: 50 });
    const b = await svc.list(VENDOR_B, { limit: 50 });

    expect(a.items).toHaveLength(2);
    expect(b.items).toHaveLength(1);
    expect(b.items.map((p) => p.code)).toEqual(["PNT-BLU-32"]);
  });

  // -------------------------------------------------------------------------
  // Write isolation
  // -------------------------------------------------------------------------

  it("update(): vendor B cannot update vendor A's product", async () => {
    const a = await svc.create(VENDOR_A, ACTOR_A, validProduct);
    await expect(svc.update(VENDOR_B, ACTOR_B, a.id, { name: "stolen" })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // Confirm the row was not modified.
    const fresh = await svc.get(VENDOR_A, a.id);
    expect(fresh.name).toBe(validProduct.name);
  });

  it("archive(): vendor B cannot archive vendor A's product", async () => {
    const a = await svc.create(VENDOR_A, ACTOR_A, validProduct);
    await expect(svc.archive(VENDOR_B, ACTOR_B, a.id)).rejects.toBeInstanceOf(NotFoundException);
    const fresh = await svc.get(VENDOR_A, a.id);
    expect(fresh.status).toBe("ACTIVE");
  });

  // -------------------------------------------------------------------------
  // Audit isolation
  // -------------------------------------------------------------------------

  it("write operations emit an audit log entry; failed cross-tenant attempts do not", async () => {
    const a = await svc.create(VENDOR_A, ACTOR_A, validProduct);
    expect(audit.log).toHaveBeenCalledTimes(1); // only the legitimate create

    await expect(svc.update(VENDOR_B, ACTOR_B, a.id, { name: "x" })).rejects.toBeInstanceOf(NotFoundException);
    expect(audit.log).toHaveBeenCalledTimes(1); // unchanged — no log on a refused operation
  });

  // -------------------------------------------------------------------------
  // Uniqueness scoped to vendor
  // -------------------------------------------------------------------------

  it("two vendors can register the same product code independently", async () => {
    await expect(svc.create(VENDOR_A, ACTOR_A, validProduct)).resolves.toBeDefined();
    await expect(svc.create(VENDOR_B, ACTOR_B, validProduct)).resolves.toBeDefined();
  });

  it("the same vendor cannot register the same product code twice", async () => {
    await svc.create(VENDOR_A, ACTOR_A, validProduct);
    await expect(svc.create(VENDOR_A, ACTOR_A, validProduct)).rejects.toThrow(/already exists/);
  });
});
