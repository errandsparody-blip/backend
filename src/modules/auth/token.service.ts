/**
 * TokenService — responsible for:
 *   - Signing short-lived access tokens (HS256, 15 min default).
 *   - Issuing + rotating long-lived opaque refresh tokens (30 days default).
 *   - Detecting refresh-token theft by tracking previously rotated hashes.
 *
 * Implementation Plan §4.1.
 *
 * Refresh tokens are NEVER stored as plaintext. We store sha256(token) and
 * compare on rotation. The plaintext is only ever sent to the browser as an
 * httpOnly + Secure + SameSite=Strict cookie.
 */

import { randomBytes, randomInt } from "node:crypto";

import { Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { Role, Session, User } from "@prisma/client";

import { loadConfig } from "../../common/config";
import { CryptoService } from "../../common/crypto.service";
import { PrismaService } from "../../common/prisma.service";

export interface AccessTokenPayload {
  sub: string;
  vendorId: string | null;
  role: Role;
  /** "1" = password only, "2" = password + fresh MFA. Step-up auth checks this. */
  acr: "1" | "2";
  /**
   * Bound-session id. Embedded on every access-token issue so the JWT
   * strategy can verify the session is still active on each request
   * (closes the post-logout/revocation residual window). Optional in
   * the type for backwards compatibility with any legacy tokens
   * issued before this field existed.
   */
  sessionId?: string;
}

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  // ---------------------------------------------------------------------------
  // Access tokens
  // ---------------------------------------------------------------------------

  signAccessToken(
    user: Pick<User, "id" | "vendorId" | "role">,
    acr: "1" | "2",
    /**
     * The session row this access token is bound to. Required for new
     * issuances after May 2026; optional in the signature for legacy
     * test paths that don't have a session row. Embedded as a JWT
     * claim so the strategy can revoke individual access tokens by
     * revoking the parent session row.
     */
    sessionId?: string,
  ): {
    token: string;
    expiresAt: Date;
  } {
    const cfg = loadConfig();
    const payload: AccessTokenPayload = {
      sub: user.id,
      vendorId: user.vendorId ?? null,
      role: user.role,
      acr,
      ...(sessionId ? { sessionId } : {}),
    };
    const token = this.jwt.sign(payload, {
      secret: Buffer.from(cfg.JWT_ACCESS_SECRET, "base64"),
      algorithm: "HS256",
      expiresIn: cfg.JWT_ACCESS_TTL_SECONDS,
    });
    const expiresAt = new Date(Date.now() + cfg.JWT_ACCESS_TTL_SECONDS * 1000);
    return { token, expiresAt };
  }

  // ---------------------------------------------------------------------------
  // Refresh tokens
  // ---------------------------------------------------------------------------

  /**
   * Issue a brand-new refresh token + create a session row. Returns the
   * plaintext token (caller must set as httpOnly cookie).
   */
  async issueRefreshToken(
    user: Pick<User, "id">,
    meta: { userAgent?: string; ip?: string },
  ): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
    const cfg = loadConfig();
    const token = this.generateOpaqueToken();
    const tokenHash = this.crypto.sha256(token);
    const expiresAt = new Date(Date.now() + cfg.JWT_REFRESH_TTL_SECONDS * 1000);

    const session = await this.prisma.session.create({
      data: {
        userId: user.id,
        refreshTokenHash: tokenHash,
        userAgent: meta.userAgent ?? null,
        ip: meta.ip ?? null,
        expiresAt,
      },
    });
    return { token, sessionId: session.id, expiresAt };
  }

  /**
   * Rotate a refresh token. Returns the new plaintext + the user (so the caller
   * can issue a fresh access token). Detects token theft: if the presented token
   * matches a *previously rotated* hash on this session, we revoke every active
   * session for the user.
   */
  async rotateRefreshToken(
    presentedToken: string,
    meta: { userAgent?: string; ip?: string },
  ): Promise<{ token: string; sessionId: string; expiresAt: Date; user: User }> {
    const cfg = loadConfig();
    const presentedHash = this.crypto.sha256(presentedToken);

    // Look up by current hash first.
    const session = await this.prisma.session.findFirst({
      where: { refreshTokenHash: presentedHash, revokedAt: null },
      include: { user: true },
    });

    if (!session) {
      // Possible theft: was this hash a previously-rotated token on any session?
      const reused = await this.prisma.session.findFirst({
        where: { rotatedHashes: { has: presentedHash } },
      });
      if (reused) {
        // Revoke EVERY active session for that user.
        await this.prisma.session.updateMany({
          where: { userId: reused.userId, revokedAt: null },
          data: { revokedAt: new Date(), revokedReason: "rotated_token_reuse" },
        });
      }
      throw new UnauthorizedException("Refresh token is invalid or expired.");
    }

    if (session.expiresAt < new Date()) {
      throw new UnauthorizedException("Refresh token expired.");
    }

    // Rotate: generate new token, push old hash into rotatedHashes, update.
    const newToken = this.generateOpaqueToken();
    const newHash = this.crypto.sha256(newToken);
    const newExpiresAt = new Date(Date.now() + cfg.JWT_REFRESH_TTL_SECONDS * 1000);

    await this.prisma.session.update({
      where: { id: session.id },
      data: {
        refreshTokenHash: newHash,
        rotatedHashes: { push: presentedHash },
        userAgent: meta.userAgent ?? session.userAgent,
        ip: meta.ip ?? session.ip,
        expiresAt: newExpiresAt,
        lastUsedAt: new Date(),
      },
    });

    return { token: newToken, sessionId: session.id, expiresAt: newExpiresAt, user: session.user };
  }

  /** Revoke a single session by id. Idempotent. */
  async revokeSession(sessionId: string, reason: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  /** Revoke every active session for a user. Used by "log out everywhere." */
  async revokeAllForUser(userId: string, reason: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  /**
   * Issue a short-lived signed challenge token used between password verification
   * and MFA verification. Carries only the user id and is single-use semantically
   * (the auth service rejects MFA flows for users whose state has already cleared).
   */
  signMfaChallenge(userId: string): string {
    const cfg = loadConfig();
    return this.jwt.sign(
      { sub: userId, purpose: "mfa_challenge" },
      {
        secret: Buffer.from(cfg.JWT_ACCESS_SECRET, "base64"),
        algorithm: "HS256",
        expiresIn: 300, // 5 minutes
      },
    );
  }

  verifyMfaChallenge(token: string): { sub: string } {
    const cfg = loadConfig();
    try {
      const decoded = this.jwt.verify<{ sub: string; purpose: string }>(token, {
        secret: Buffer.from(cfg.JWT_ACCESS_SECRET, "base64"),
        algorithms: ["HS256"],
      });
      if (decoded.purpose !== "mfa_challenge") {
        throw new UnauthorizedException("Invalid challenge token.");
      }
      return { sub: decoded.sub };
    } catch {
      throw new UnauthorizedException("Challenge token expired or invalid.");
    }
  }

  /**
   * Issue a short-lived single-purpose token (e.g., for password reset link).
   * Returns plaintext + sha256 hash for storage on the user row.
   */
  generateSingleUseToken(byteLength = 32): { plaintext: string; hash: string } {
    const plaintext = this.generateOpaqueToken(byteLength);
    return { plaintext, hash: this.crypto.sha256(plaintext) };
  }

  /**
   * Issue a short-lived numeric verification code. Used for email verification
   * (and any other "type the code from your inbox" flow). Returns plaintext +
   * sha256 hash for storage; we never persist the plaintext.
   *
   * Uses crypto.randomInt for a uniform distribution across the [0, 10^digits)
   * range. The plaintext is left-padded with zeros so a code starting with 0
   * is rendered with all `digits` characters — vital because users will type
   * it in.
   *
   * Default raised from 6 → 8 digits (security audit M-4). At 8 digits the
   * search space is 100M permutations; combined with the per-IP rate limit
   * on `/auth/verify-email` (10/min) and the 15-minute expiry, a distributed
   * brute-force attack would need roughly 10⁶ IP addresses to clear ~1%
   * probability — outside the realistic capability of opportunistic
   * attackers. 6-digit calls continue to work for legacy paths if any.
   */
  generateNumericCode(digits = 8): { plaintext: string; hash: string } {
    if (digits < 4 || digits > 10) {
      throw new Error("Numeric code length must be between 4 and 10 digits.");
    }
    const max = 10 ** digits; // exclusive
    const n = randomInt(0, max);
    const plaintext = n.toString().padStart(digits, "0");
    return { plaintext, hash: this.crypto.sha256(plaintext) };
  }

  // ---------------------------------------------------------------------------

  private generateOpaqueToken(byteLength = 48): string {
    return randomBytes(byteLength).toString("base64url");
  }

  /** Helper for tests / startup checks. */
  getSessionExpiry(_session: Session): Date {
    return _session.expiresAt;
  }
}
