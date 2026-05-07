/**
 * MfaService tests:
 *   - Enrollment confirmation accepts the freshly-generated TOTP.
 *   - Recovery codes are single-use (verified by argon2.verify on consume).
 *   - Recovery code format is the documented 4×4 alphanumeric pattern.
 */

import * as argon2 from "argon2";
import { Test, type TestingModule } from "@nestjs/testing";
import { authenticator } from "otplib";

import { CryptoService } from "../../common/crypto.service";
import { PrismaService } from "../../common/prisma.service";

import { MfaService } from "./mfa.service";

interface RecoveryRow {
  id: string;
  userId: string;
  codeHash: string;
  usedAt: Date | null;
}

interface UserRow {
  id: string;
  email: string;
  mfaEnrolled: boolean;
  mfaSecretEncrypted: string | null;
}

class FakePrisma {
  users: UserRow[] = [];
  codes: RecoveryRow[] = [];

  user = {
    findUnique: async ({ where, select: _select }: { where: { id: string }; select?: unknown }) => {
      return this.users.find((u) => u.id === where.id) ?? null;
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<UserRow> }) => {
      const u = this.users.find((x) => x.id === where.id);
      if (!u) throw new Error("user not found");
      Object.assign(u, data);
      return u;
    },
  };

  recoveryCode = {
    deleteMany: async ({ where }: { where: { userId: string } }) => {
      const before = this.codes.length;
      this.codes = this.codes.filter((c) => c.userId !== where.userId);
      return { count: before - this.codes.length };
    },
    createMany: async ({ data }: { data: Array<{ userId: string; codeHash: string }> }) => {
      for (const d of data) {
        this.codes.push({ id: `c${this.codes.length + 1}`, userId: d.userId, codeHash: d.codeHash, usedAt: null });
      }
      return { count: data.length };
    },
    findMany: async ({ where }: { where: { userId: string; usedAt: null } }) => {
      return this.codes.filter((c) => c.userId === where.userId && c.usedAt === null);
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<RecoveryRow> }) => {
      const c = this.codes.find((x) => x.id === where.id);
      if (!c) throw new Error("code not found");
      Object.assign(c, data);
      return c;
    },
  };

  $transaction = async <T>(cb: (tx: FakePrisma) => Promise<T>): Promise<T> => cb(this);
}

describe("MfaService", () => {
  let svc: MfaService;
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
        MfaService,
        CryptoService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    svc = moduleRef.get(MfaService);
  });

  it("enrollment: confirms a TOTP code generated from the issued secret", async () => {
    const { secret } = await svc.beginEnrollment("vendor@example.com");
    const code = authenticator.generate(secret);
    expect(svc.verifyEnrollmentCode(secret, code)).toBe(true);
  });

  it("finishEnrollment persists encrypted secret and 10 hashed recovery codes", async () => {
    prisma.users.push({ id: "u1", email: "vendor@example.com", mfaEnrolled: false, mfaSecretEncrypted: null });
    const { secret } = await svc.beginEnrollment("vendor@example.com");
    const { recoveryCodes } = await svc.finishEnrollment("u1", secret);
    expect(recoveryCodes).toHaveLength(10);
    expect(recoveryCodes.every((c) => /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(c))).toBe(true);
    expect(prisma.users[0]!.mfaEnrolled).toBe(true);
    expect(prisma.users[0]!.mfaSecretEncrypted).toBeTruthy();
    expect(prisma.codes).toHaveLength(10);
    // Hashes verify with argon2.verify against the original plaintexts.
    for (let i = 0; i < recoveryCodes.length; i++) {
      const stored = prisma.codes[i];
      const plain = recoveryCodes[i];
      expect(stored).toBeDefined();
      expect(plain).toBeDefined();
      const ok = await argon2.verify(stored!.codeHash, plain!);
      expect(ok).toBe(true);
    }
  });

  it("recovery code is single-use", async () => {
    prisma.users.push({ id: "u1", email: "vendor@example.com", mfaEnrolled: false, mfaSecretEncrypted: null });
    const { secret } = await svc.beginEnrollment("vendor@example.com");
    const { recoveryCodes } = await svc.finishEnrollment("u1", secret);
    const sample = recoveryCodes[0];
    expect(sample).toBeDefined();
    expect(await svc.consumeRecoveryCode("u1", sample!)).toBe(true);
    expect(await svc.consumeRecoveryCode("u1", sample!)).toBe(false);
  });

  it("verifyTotpForUser returns false for unenrolled users", async () => {
    prisma.users.push({ id: "u1", email: "x@y.com", mfaEnrolled: false, mfaSecretEncrypted: null });
    expect(await svc.verifyTotpForUser("u1", "123456")).toBe(false);
  });
});
