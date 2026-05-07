/**
 * TokenService — security-critical tests.
 *
 * What this verifies:
 *   1. Refresh tokens rotate on every use; the old hash moves to rotatedHashes.
 *   2. Reusing a previously-rotated refresh token revokes EVERY active session
 *      for that user (theft detection).
 *   3. Expired tokens cannot be rotated.
 *   4. Refresh tokens are stored as sha256 hashes — plaintext is never persisted.
 *   5. MFA challenge tokens are accepted only with purpose=mfa_challenge.
 */

import { JwtModule, JwtService } from "@nestjs/jwt";
import { Test, type TestingModule } from "@nestjs/testing";
import { Role, UserStatus } from "@prisma/client";

import { CryptoService } from "../../common/crypto.service";
import { PrismaService } from "../../common/prisma.service";

import { TokenService } from "./token.service";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface SessionRow {
  id: string;
  userId: string;
  refreshTokenHash: string;
  rotatedHashes: string[];
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
  userAgent: string | null;
  ip: string | null;
  lastUsedAt: Date;
  createdAt: Date;
}

interface UserRow {
  id: string;
  email: string;
  passwordHash: string;
  role: Role;
  vendorId: string | null;
  mfaEnrolled: boolean;
  emailVerified: boolean;
  status: UserStatus;
}

class FakePrisma {
  sessions: SessionRow[] = [];
  users: UserRow[] = [];

  session = {
    create: async ({ data }: { data: Omit<SessionRow, "id" | "rotatedHashes" | "revokedAt" | "revokedReason" | "lastUsedAt" | "createdAt"> }) => {
      const row: SessionRow = {
        id: `sess_${this.sessions.length + 1}`,
        rotatedHashes: [],
        revokedAt: null,
        revokedReason: null,
        lastUsedAt: new Date(),
        createdAt: new Date(),
        ...data,
      };
      this.sessions.push(row);
      return row;
    },
    findFirst: async ({
      where,
      include,
    }: {
      where: { refreshTokenHash?: string; revokedAt?: null; rotatedHashes?: { has: string } };
      include?: { user?: boolean };
    }) => {
      const found = this.sessions.find((s) => {
        if (where.refreshTokenHash !== undefined && s.refreshTokenHash !== where.refreshTokenHash) return false;
        if (where.revokedAt === null && s.revokedAt !== null) return false;
        if (where.rotatedHashes?.has && !s.rotatedHashes.includes(where.rotatedHashes.has)) return false;
        return true;
      });
      if (!found) return null;
      if (include?.user) {
        const u = this.users.find((u) => u.id === found.userId);
        return { ...found, user: u };
      }
      return found;
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<SessionRow> & { rotatedHashes?: { push: string } } }) => {
      const s = this.sessions.find((x) => x.id === where.id);
      if (!s) throw new Error("session not found");
      if (data.rotatedHashes && "push" in data.rotatedHashes) {
        s.rotatedHashes.push(data.rotatedHashes.push);
        delete (data as { rotatedHashes?: unknown }).rotatedHashes;
      }
      Object.assign(s, data);
      return s;
    },
    updateMany: async ({ where, data }: { where: { userId?: string; revokedAt?: null; id?: string }; data: Partial<SessionRow> }) => {
      let count = 0;
      for (const s of this.sessions) {
        if (where.userId && s.userId !== where.userId) continue;
        if (where.id && s.id !== where.id) continue;
        if (where.revokedAt === null && s.revokedAt !== null) continue;
        Object.assign(s, data);
        count++;
      }
      return { count };
    },
  };
}

// ---------------------------------------------------------------------------

describe("TokenService", () => {
  let svc: TokenService;
  let prisma: FakePrisma;
  let crypto: CryptoService;

  const seedUser = (overrides: Partial<UserRow> = {}): UserRow => {
    const u: UserRow = {
      id: `user_${prisma.users.length + 1}`,
      email: "vendor@example.com",
      passwordHash: "x",
      role: Role.VENDOR,
      vendorId: null,
      mfaEnrolled: true,
      emailVerified: true,
      status: UserStatus.ACTIVE,
      ...overrides,
    };
    prisma.users.push(u);
    return u;
  };

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
      imports: [JwtModule.register({})],
      providers: [
        TokenService,
        CryptoService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    svc = moduleRef.get(TokenService);
    crypto = moduleRef.get(CryptoService);
    // Sanity: JwtService instantiated.
    expect(moduleRef.get(JwtService)).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // (1) Issuance — plaintext is NEVER persisted.
  // -------------------------------------------------------------------------
  it("stores only the sha256 hash of the refresh token, never the plaintext", async () => {
    const user = seedUser();
    const { token } = await svc.issueRefreshToken(user, {});
    expect(token.length).toBeGreaterThan(40);
    expect(prisma.sessions[0]!.refreshTokenHash).toBe(crypto.sha256(token));
    // Plaintext must not appear in any persisted session field.
    const serialized = JSON.stringify(prisma.sessions[0]);
    expect(serialized).not.toContain(token);
  });

  // -------------------------------------------------------------------------
  // (2) Rotation — current hash advances, old hash captured.
  // -------------------------------------------------------------------------
  it("rotates: new token replaces the current hash, old hash moves to rotatedHashes", async () => {
    const user = seedUser();
    const issued = await svc.issueRefreshToken(user, {});
    const { token: newToken } = await svc.rotateRefreshToken(issued.token, {});
    const session = prisma.sessions[0]!;
    expect(session.refreshTokenHash).toBe(crypto.sha256(newToken));
    expect(session.rotatedHashes).toContain(crypto.sha256(issued.token));
    expect(session.rotatedHashes).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // (3) Theft detection — reusing a rotated token revokes every session.
  // -------------------------------------------------------------------------
  it("detects refresh-token reuse and revokes every active session for the user", async () => {
    const user = seedUser();
    const a = await svc.issueRefreshToken(user, {});
    const b = await svc.issueRefreshToken(user, {});
    expect(prisma.sessions).toHaveLength(2);

    // Rotate the first session — the original token is now in rotatedHashes.
    await svc.rotateRefreshToken(a.token, {});

    // Attacker replays the original token.
    await expect(svc.rotateRefreshToken(a.token, {})).rejects.toThrow();

    // Both sessions for this user must be revoked.
    const live = prisma.sessions.filter((s) => s.userId === user.id && s.revokedAt === null);
    expect(live).toHaveLength(0);
    const revokedReasons = prisma.sessions.map((s) => s.revokedReason);
    expect(revokedReasons).toContain("rotated_token_reuse");
  });

  // -------------------------------------------------------------------------
  // (4) Expired tokens cannot rotate.
  // -------------------------------------------------------------------------
  it("rejects rotation of an expired refresh token", async () => {
    const user = seedUser();
    const { token } = await svc.issueRefreshToken(user, {});
    // Simulate expiry.
    prisma.sessions[0]!.expiresAt = new Date(Date.now() - 1000);
    await expect(svc.rotateRefreshToken(token, {})).rejects.toThrow(/expired/i);
  });

  // -------------------------------------------------------------------------
  // (5) Wrong purpose challenge tokens are rejected.
  // -------------------------------------------------------------------------
  it("MFA challenge token: rejects tokens whose purpose is not mfa_challenge", async () => {
    const user = seedUser();
    // Sign an access-style token instead of a challenge — verifyMfaChallenge must reject it.
    const access = svc.signAccessToken(user, "1");
    expect(() => svc.verifyMfaChallenge(access.token)).toThrow();
  });

  it("MFA challenge token: round-trips with the user id", () => {
    const challenge = svc.signMfaChallenge("user_xyz");
    const decoded = svc.verifyMfaChallenge(challenge);
    expect(decoded.sub).toBe("user_xyz");
  });

  // -------------------------------------------------------------------------
  // (6) Revoke API.
  // -------------------------------------------------------------------------
  it("revokes a single session by id", async () => {
    const user = seedUser();
    const { sessionId } = await svc.issueRefreshToken(user, {});
    await svc.revokeSession(sessionId, "user_logout");
    expect(prisma.sessions[0]!.revokedAt).toBeInstanceOf(Date);
    expect(prisma.sessions[0]!.revokedReason).toBe("user_logout");
  });
});
