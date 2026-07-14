/**
 * PagePermissionGuard — runs after RolesGuard. Enforces the
 * @RequiresPage(...) decorator introduced by migration 0039.
 *
 * Guard chain order matters:
 *   1. JwtAuthGuard populates req.user.
 *   2. RolesGuard filters by @Roles(...) (compile-time role list).
 *   3. PagePermissionGuard filters by @RequiresPage(...) using the
 *      dynamic admin-role-permissions config.
 *
 * If a route has no @RequiresPage decorator, this guard is a no-op.
 * That keeps every existing controller untouched by the introduction
 * of the new decorator — we opt IN endpoint by endpoint as we open
 * them to the ADMIN role in phase 2.
 */

import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import { REQUIRES_PAGE_KEY } from "../decorators/requires-page.decorator";
import type { PageKey } from "../schemas/page-permissions";
import { PagePermissionService } from "../services/page-permission.service";
import type { AuthenticatedUser } from "./jwt-auth.guard";

@Injectable()
export class PagePermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PagePermissionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Read from both the handler and the class so a controller-level
    // @RequiresPage(...) covers every method without repeating the
    // decorator. Handler-level metadata wins if both are set.
    const required = this.reflector.getAllAndOverride<PageKey | undefined>(REQUIRES_PAGE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const req = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const user = req.user;
    // JwtAuthGuard runs first and rejects unauthenticated requests, so
    // reaching this line without a user is a bug in the guard order —
    // fail closed rather than fall through.
    if (!user) throw new ForbiddenException("Authentication required.");

    const allowed = await this.permissions.canAccess(user, required);
    if (!allowed) {
      // Same message shape as RolesGuard so error-handling code
      // upstream can treat both cases identically.
      throw new ForbiddenException("Insufficient permission for this resource.");
    }
    return true;
  }
}
