/**
 * TenantGuard — runs after JwtAuthGuard + RolesGuard. Asserts the requesting
 * user has a vendorId on their token. Use on every controller (or method) that
 * is vendor-scoped. Without it a misconfigured @Roles() with admin roles could
 * still reach a method that assumes user.vendorId is non-null.
 *
 * Implementation Plan §4.3.
 *
 * Pattern: vendor-scoped services accept vendorId as the first argument. The
 * controller passes user.vendorId. After this guard, user.vendorId is non-null.
 */

import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";

import type { AuthenticatedUser } from "./jwt-auth.guard";

@Injectable()
export class TenantGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const user = req.user;
    if (!user) throw new ForbiddenException("Authentication required.");
    if (!user.vendorId) {
      // Admin user hitting a vendor-only route, or a misconfigured token.
      throw new ForbiddenException({
        message: "This endpoint requires a vendor context.",
        code: "tenant_required",
      });
    }
    return true;
  }
}
