/**
 * ShopperTokenService — magic-link auth for the public buyer thread.
 *
 * Buyers don't have User rows (the personal-shopper service is wide open
 * to any visitor with an email). We instead issue a long-lived,
 * single-purpose access token tied to a specific request:
 *
 *   1. Buyer submits intake form.
 *   2. Backend creates the request + issues a token.
 *   3. Email goes out with `https://app/.../shopper/r/<token>` — the only
 *      way to access the thread.
 *   4. Token is hashed-at-rest (sha256), expires after 60 days, can be
 *      revoked individually, and tracks last-used-at for auditing.
 *
 * The token plaintext is returned ONCE to the caller (so the email
 * sender can put it in the URL). The DB only ever stores the hash.
 */

import { Injectable, UnauthorizedException } from "@nestjs/common";
import { randomBytes } from "node:crypto";

import { CryptoService } from "../../common/crypto.service";
import { PrismaService } from "../../common/prisma.service";

const TOKEN_TTL_DAYS = 60;
const TOKEN_BYTES = 32; // 256 bits, base64url-encoded → 43-char URL segment.

export interface IssuedToken {
  /** Plaintext to embed in the email link. Returned once; never stored. */
  plaintext: string;
  expiresAt: Date;
}

export interface ResolvedToken {
  requestId: string;
  tokenId: string;
}

@Injectable()
export class ShopperTokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  /**
   * Mint a fresh token, persist its hash, return the plaintext + expiry.
   * Caller is responsible for putting the plaintext into the magic-link
   * URL exactly once (typically in an email).
   */
  async issue(requestId: string): Promise<IssuedToken> {
    const plaintext = randomBytes(TOKEN_BYTES).toString("base64url");
    const tokenHash = this.crypto.sha256(plaintext);
    const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
    // Cast through unknown — the generated Prisma client doesn't know about
    // shopperAccessToken until `prisma generate` runs on Railway. Migration
    // 0011 created the table; this will type cleanly post-deploy.
    await (this.prisma as unknown as {
      shopperAccessToken: { create: (args: unknown) => Promise<unknown> };
    }).shopperAccessToken.create({
      data: { requestId, tokenHash, expiresAt },
    });
    return { plaintext, expiresAt };
  }

  /**
   * Validate a token presented by the buyer. Returns the requestId on
   * success, throws UnauthorizedException with a stable code on failure
   * (the api-client + error catalog handle the buyer-facing copy).
   *
   * Updates lastUsedAt as a side effect — useful for "where was this
   * link last opened" forensics.
   */
  async resolve(plaintext: string): Promise<ResolvedToken> {
    if (!plaintext || plaintext.length < 20 || plaintext.length > 100) {
      throw new UnauthorizedException({
        message: "Invalid access link.",
        code: "shopper_token_invalid",
      });
    }
    const tokenHash = this.crypto.sha256(plaintext);
    const row = await (this.prisma as unknown as {
      shopperAccessToken: {
        findUnique: (args: unknown) => Promise<{
          id: string;
          requestId: string;
          expiresAt: Date;
          revokedAt: Date | null;
        } | null>;
        update: (args: unknown) => Promise<unknown>;
      };
    }).shopperAccessToken.findUnique({ where: { tokenHash } });
    if (!row) {
      throw new UnauthorizedException({
        message: "Invalid access link.",
        code: "shopper_token_invalid",
      });
    }
    if (row.revokedAt) {
      throw new UnauthorizedException({
        message: "This access link has been revoked.",
        code: "shopper_token_revoked",
      });
    }
    if (row.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException({
        message: "This access link has expired. Request a new one.",
        code: "shopper_token_expired",
      });
    }
    // Touch lastUsedAt — fire-and-forget; errors here are non-fatal.
    void (this.prisma as unknown as {
      shopperAccessToken: { update: (args: unknown) => Promise<unknown> };
    }).shopperAccessToken
      .update({
        where: { id: row.id },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => undefined);
    return { requestId: row.requestId, tokenId: row.id };
  }

  /**
   * Revoke a single token. Used when the buyer reports the link was
   * shared in error, or when the request is closed and the link
   * shouldn't continue to work.
   */
  async revoke(tokenId: string): Promise<void> {
    await (this.prisma as unknown as {
      shopperAccessToken: { update: (args: unknown) => Promise<unknown> };
    }).shopperAccessToken.update({
      where: { id: tokenId },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Bulk-revoke every active token for a request. Called when the
   * request transitions to a terminal state (CANCELLED, REFUNDED,
   * DELIVERED, or in-person PICKUP) so any stale magic-link the
   * buyer's email account might still hold becomes inert (security
   * audit L-1).
   *
   * Best-effort: a failure here mustn't block the state transition.
   * The default 60-day token expiry caps residual exposure anyway,
   * but immediate revocation removes the window entirely.
   */
  async revokeAllForRequest(requestId: string): Promise<number> {
    const res = await (this.prisma as unknown as {
      shopperAccessToken: {
        updateMany: (args: unknown) => Promise<{ count: number }>;
      };
    }).shopperAccessToken.updateMany({
      where: { requestId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return res.count;
  }
}
