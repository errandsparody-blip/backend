/**
 * RolesGuard — runs after JwtAuthGuard. Enforces the @Roles(...) decorator.
 * Implementation Plan §4.2.
 */

import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Role } from "@prisma/client";

import { ROLES_KEY } from "../decorators/roles.decorator";
import type { AuthenticatedUser } from "./jwt-auth.guard";

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const user = req.user;
    if (!user) throw new ForbiddenException("Authentication required.");

    if (!required.includes(user.role)) {
      throw new ForbiddenException("Insufficient role for this resource.");
    }
    return true;
  }
}
