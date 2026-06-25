/**
 * ApiKeyGuard — authenticates a vendor's storefront via an integration API key
 * instead of a human JWT session. Used only by the integration controller
 * (POST /v1/integration/orders et al.), which is also marked @Public() so the
 * global JwtAuthGuard / AgreementVersionGuard skip it and this guard owns auth.
 *
 * On success it populates `request.user` with the same AuthenticatedUser shape
 * the JWT path produces (vendorId + role = VENDOR), so every downstream
 * tenant-scoped service and the TenantGuard work unchanged. `sub` carries the
 * api-key id rather than a user id, and `apiKeyId` is attached for audit.
 *
 * The key is read from `Authorization: Bearer <key>` or the `X-API-Key` header.
 * Lookup is an O(1) indexed read on the public keyId; the secret half is then
 * SHA-256-hashed and compared in constant time. Every failure returns the same
 * opaque 401 so we never reveal which check failed (unknown key vs bad secret
 * vs revoked).
 */

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";

import { parseApiKey } from "../api-key";
import { CryptoService } from "../crypto.service";
import { PrismaService } from "../prisma.service";

import type { AuthenticatedUser } from "./jwt-auth.guard";

// Only bump last_used_at when the stored value is older than this, so we don't
// issue a write on every single request from a busy storefront.
const LAST_USED_REFRESH_MS = 60_000;

export interface ApiKeyAuthenticatedUser extends AuthenticatedUser {
  /** The VendorApiKey.id that authenticated this request. */
  apiKeyId: string;
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: ApiKeyAuthenticatedUser }>();

    const parsed = parseApiKey(this.extractKey(req));
    if (!parsed) throw this.deny();

    const key = await this.prisma.vendorApiKey.findUnique({
      where: { keyId: parsed.keyId },
      select: {
        id: true,
        vendorId: true,
        secretHash: true,
        revokedAt: true,
        lastUsedAt: true,
      },
    });
    if (!key || key.revokedAt) throw this.deny();

    const presentedHash = this.crypto.sha256(parsed.secret);
    if (!this.crypto.constantTimeEqual(presentedHash, key.secretHash)) {
      throw this.deny();
    }

    // Best-effort, throttled last-used stamp. Never block or fail the request
    // on this write — it's telemetry, not part of the auth decision.
    const now = Date.now();
    if (!key.lastUsedAt || now - key.lastUsedAt.getTime() > LAST_USED_REFRESH_MS) {
      void this.prisma.vendorApiKey
        .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
        .catch(() => undefined);
    }

    req.user = {
      sub: key.id,
      vendorId: key.vendorId,
      role: "VENDOR",
      acr: "1",
      apiKeyId: key.id,
      iat: Math.floor(now / 1000),
      exp: Math.floor(now / 1000) + 60,
    };
    return true;
  }

  private extractKey(req: Request): string | undefined {
    const header = req.headers["x-api-key"];
    if (typeof header === "string" && header.length > 0) return header;

    const auth = req.headers.authorization;
    if (typeof auth === "string" && auth.startsWith("Bearer ")) {
      return auth.slice("Bearer ".length);
    }
    return undefined;
  }

  private deny(): UnauthorizedException {
    return new UnauthorizedException({
      message: "Invalid or missing API key.",
      code: "api_key_invalid",
    });
  }
}
