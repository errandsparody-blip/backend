/**
 * Passport JWT strategy. Validates the access token (HS256, signed with
 * JWT_ACCESS_SECRET) AND verifies the bound session row is still active.
 *
 * The session check (security audit H-1) closes the residual window
 * where a stolen access token could outlive a logout, password reset,
 * or admin-initiated session revocation. Without it, a token would
 * remain valid until its 15-minute expiry regardless of revocation.
 *
 * Performance: the session lookup is one indexed PK read per request.
 * A small in-memory LRU caches "session id → revoked?" for 60 seconds
 * so steady traffic doesn't hammer Postgres. The cache TTL is short
 * enough that revocation propagation latency stays bounded
 * (revocations land within ~60s on every node).
 */

import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";

import { loadConfig } from "../../../common/config";
import type { AuthenticatedUser } from "../../../common/guards/jwt-auth.guard";
import { PrismaService } from "../../../common/prisma.service";

/**
 * Per-process cache of session revocation state. Keys: sessionId.
 * Values: { revoked: boolean; checkedAt: epoch-ms }.
 *
 * The cache is intentionally small and short-lived. Eviction policy:
 * - Entries older than CACHE_TTL_MS are treated as stale on read.
 * - When the Map exceeds MAX_ENTRIES, the oldest entries are pruned.
 */
const CACHE_TTL_MS = 60_000;
const MAX_ENTRIES = 10_000;

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, "jwt") {
  private readonly sessionCache = new Map<string, { revoked: boolean; checkedAt: number }>();

  constructor(private readonly prisma: PrismaService) {
    const cfg = loadConfig();
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: Buffer.from(cfg.JWT_ACCESS_SECRET, "base64"),
      algorithms: ["HS256"],
    });
  }

  async validate(payload: AuthenticatedUser): Promise<AuthenticatedUser> {
    // Passport calls this when the signature is valid and not expired.
    // We still need to confirm the session hasn't been revoked.
    //
    // Tokens issued before the H-1 hardening land here without a
    // sessionId claim. We treat those as legacy and skip the DB check
    // (the alternative is invalidating every token at deploy time,
    // which would log everyone out simultaneously). After the access-
    // token TTL (15 min) elapses globally, every active token will be
    // a post-fix token with a sessionId claim, and this branch is no
    // longer reachable in practice.
    if (!payload.sessionId) {
      return payload;
    }

    // Cache check — avoids one DB round-trip per request for the same
    // session within CACHE_TTL_MS.
    const now = Date.now();
    const cached = this.sessionCache.get(payload.sessionId);
    if (cached && now - cached.checkedAt < CACHE_TTL_MS) {
      if (cached.revoked) {
        throw new UnauthorizedException({
          message: "Session has been revoked.",
          code: "session_revoked",
        });
      }
      return payload;
    }

    // Indexed PK read. Pulls only the revocation marker to keep the
    // query payload tiny.
    const session = await this.prisma.session.findUnique({
      where: { id: payload.sessionId },
      select: { revokedAt: true, expiresAt: true },
    });

    const revoked =
      !session ||
      session.revokedAt !== null ||
      session.expiresAt.getTime() <= now;

    // Cache the result. Light-touch eviction: prune to half capacity
    // when we exceed the ceiling so we amortise eviction cost.
    if (this.sessionCache.size >= MAX_ENTRIES) {
      const drop = Math.ceil(MAX_ENTRIES / 2);
      let i = 0;
      for (const key of this.sessionCache.keys()) {
        if (i++ >= drop) break;
        this.sessionCache.delete(key);
      }
    }
    this.sessionCache.set(payload.sessionId, { revoked, checkedAt: now });

    if (revoked) {
      throw new UnauthorizedException({
        message: "Session has been revoked.",
        code: "session_revoked",
      });
    }

    return payload;
  }
}
