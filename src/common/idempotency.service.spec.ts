/**
 * IdempotencyService — replay-safety unit tests.
 */

import { ConflictException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";

import { CryptoService } from "./crypto.service";
import { IdempotencyService } from "./idempotency.service";
import { PrismaService } from "./prisma.service";

interface KeyRow {
  key: string;
  endpoint: string;
  requestHash: string;
  responseStatus: number;
  responseBody: object;
  vendorId: string | null;
  createdAt: Date;
  expiresAt: Date;
}

class FakePrisma {
  rows: KeyRow[] = [];
  idempotencyKey = {
    findUnique: async ({ where }: { where: { key: string } }) =>
      this.rows.find((r) => r.key === where.key) ?? null,
    create: async ({ data }: { data: KeyRow }) => {
      this.rows.push(data);
      return data;
    },
  };
}

describe("IdempotencyService", () => {
  let svc: IdempotencyService;
  let prisma: FakePrisma;

  beforeAll(() => {
    process.env.NODE_ENV = "test";
    process.env.LOG_LEVEL = "fatal";
    process.env.API_PORT = "4000";
    process.env.API_PUBLIC_URL = "http://localhost:4000";
    process.env.WEB_PUBLIC_URL = "http://localhost:3000";
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    process.env.REDIS_URL = "redis://localhost:6379";
    process.env.JWT_ACCESS_SECRET = Buffer.alloc(64, 1).toString("base64");
    process.env.JWT_REFRESH_SECRET = Buffer.alloc(64, 2).toString("base64");
    process.env.ENCRYPTION_MASTER_KEY = Buffer.alloc(32, 3).toString("base64");
    process.env.COOKIE_DOMAIN = "localhost";
    process.env.COOKIE_SECURE = "false";
  });

  beforeEach(async () => {
    prisma = new FakePrisma();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        IdempotencyService,
        CryptoService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    svc = moduleRef.get(IdempotencyService);
  });

  it("returns null on first lookup, then the cached response on replay", async () => {
    const args = { key: "k1", endpoint: "POST /wallet/fund", vendorId: "v1", body: { amountCents: 1000 } };
    expect(await svc.lookup(args)).toBeNull();
    await svc.commit({ ...args, responseStatus: 200, responseBody: { ok: true, balance: 1000 } });
    const replay = await svc.lookup(args);
    expect(replay).toEqual({ status: 200, body: { ok: true, balance: 1000 } });
  });

  it("hashes are key-order-insensitive (canonical JSON)", async () => {
    const a = { key: "k2", endpoint: "POST /x", vendorId: "v1", body: { a: 1, b: 2 } };
    const b = { key: "k2", endpoint: "POST /x", vendorId: "v1", body: { b: 2, a: 1 } };
    await svc.commit({ ...a, responseStatus: 200, responseBody: { ok: true } });
    // Same key, same body in different key-order — should hit the cache.
    const replay = await svc.lookup(b);
    expect(replay).toEqual({ status: 200, body: { ok: true } });
  });

  it("same key + different body throws Conflict (replay attack guard)", async () => {
    const original = { key: "k3", endpoint: "POST /wallet/fund", vendorId: "v1", body: { amountCents: 1000 } };
    await svc.commit({ ...original, responseStatus: 200, responseBody: { ok: true } });
    const tampered = { ...original, body: { amountCents: 9999 } };
    await expect(svc.lookup(tampered)).rejects.toBeInstanceOf(ConflictException);
  });

  it("keys are scoped to (vendor, endpoint) — same key across vendors is independent", async () => {
    const v1 = { key: "shared", endpoint: "POST /x", vendorId: "v1", body: { x: 1 } };
    const v2 = { key: "shared", endpoint: "POST /x", vendorId: "v2", body: { x: 2 } };
    await svc.commit({ ...v1, responseStatus: 200, responseBody: { vendor: "v1" } });
    await svc.commit({ ...v2, responseStatus: 200, responseBody: { vendor: "v2" } });
    expect(await svc.lookup(v1)).toEqual({ status: 200, body: { vendor: "v1" } });
    expect(await svc.lookup(v2)).toEqual({ status: 200, body: { vendor: "v2" } });
  });
});
