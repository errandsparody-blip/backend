/**
 * AgreementVersionGuard — blocks state-changing requests by vendors whose
 * `agreementVersion` doesn't match the published `agreement_version` config.
 *
 * Why this guard exists.
 * ----------------------
 * The platform charges money (onboarding fees, fulfillment fees, storage
 * billing) and ships physical inventory. Every action the vendor takes is
 * supposed to be governed by an explicit agreement they accepted. When
 * legal pushes new terms, every existing vendor is, in legal terms,
 * unbound until they re-accept — letting them keep submitting PSNs and
 * placing orders against the old terms is a real risk.
 *
 * Behaviour.
 * ----------
 * - Runs AFTER the JWT and Roles guards so `request.user` is populated.
 * - Only enforces against the `VENDOR` and `VENDOR_SUB_USER` roles. Admins
 *   never need to accept a vendor agreement.
 * - Public routes (decorated `@Public()`) and read-only requests (GET /
 *   HEAD / OPTIONS) pass through. The vendor must be able to read their
 *   profile to discover *that* they need to re-accept.
 * - The acceptance endpoint itself, plus auth-control routes (logout,
 *   refresh), are explicitly whitelisted by path so the user is never
 *   trapped.
 * - When out-of-date, returns `412 Precondition Failed` with a structured
 *   problem-details body and code `agreement_version_outdated`. The
 *   frontend catches this code and routes the user to
 *   /legal/vendor-agreement?reaccept=1.
 *
 * Why 412 (not 403)? "I authorize you, but the precondition for taking
 * this action — an up-to-date agreement — is not satisfied" maps cleanly
 * to RFC 7232 §4.2's intent. It's also distinct from the auth-related
 * 401/403 codes we already use, so the frontend doesn't have to inspect
 * the body to disambiguate.
 */

import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";

import { IS_PUBLIC_KEY } from "../decorators/public.decorator";
import { PrismaService } from "../prisma.service";

import type { AuthenticatedUser } from "./jwt-auth.guard";

import { AgreementService } from "../../modules/vendors/agreement.service";

// Methods that read but don't modify state.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Path suffixes that are always allowed regardless of agreement freshness.
// Match against the path part of the URL (no query string).
//
// We use endsWith / includes against canonical path segments rather than a
// strict equality so the global `/v1` prefix doesn't have to be hard-coded.
const PATH_ALLOWLIST: Array<(path: string) => boolean> = [
  (p) => p.endsWith("/vendors/me/agreement"),       // POST: the actual acceptance
  (p) => p.endsWith("/vendors/me"),                 // GET / PATCH profile (incl. self-clear)
  (p) => p.endsWith("/auth/logout"),
  (p) => p.endsWith("/auth/refresh"),
  (p) => p.endsWith("/auth/login"),                 // unauth'd request slip-through; harmless
  (p) => p.endsWith("/auth/login/2fa"),
];

@Injectable()
export class AgreementVersionGuard implements CanActivate {
  private readonly logger = new Logger(AgreementVersionGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly agreement: AgreementService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const method = (req.method ?? "GET").toUpperCase();
    if (SAFE_METHODS.has(method)) return true;

    const user = req.user;
    if (!user) return true; // unauth'd — JwtAuthGuard already rejected, or @Public.

    if (user.role !== "VENDOR" && user.role !== "VENDOR_SUB_USER") return true;

    const path = (req.originalUrl ?? req.url ?? "").split("?")[0] ?? "";
    if (PATH_ALLOWLIST.some((match) => match(path))) return true;

    if (!user.vendorId) return true; // defensive — vendors should always have one.

    const vendor = await this.prisma.vendor.findUnique({
      where: { id: user.vendorId },
      select: { agreementAcceptedAt: true, agreementVersion: true },
    });
    if (!vendor) return true; // tenant-isolation will fail downstream with a 404.

    let currentVersion: string;
    try {
      currentVersion = await this.agreement.getCurrentVersion();
    } catch (err) {
      // If the config row is missing we let the request through — failing
      // closed here would cascade into a self-inflicted outage on every
      // vendor request. The error is already logged via the missing-row
      // exception elsewhere, and a global outage is the least-helpful
      // failure mode for "you need to re-accept terms."
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Could not load agreement_version; allowing request through.",
      );
      return true;
    }

    const upToDate =
      vendor.agreementAcceptedAt !== null && vendor.agreementVersion === currentVersion;
    if (upToDate) return true;

    throw new HttpException(
      {
        message:
          vendor.agreementAcceptedAt === null
            ? "You haven't accepted the vendor agreement yet."
            : "The vendor agreement has been updated. Re-accept the new terms to continue.",
        code: "agreement_version_outdated",
        currentAgreementVersion: currentVersion,
        acceptedVersion: vendor.agreementVersion,
      },
      HttpStatus.PRECONDITION_FAILED,
    );
  }
}
