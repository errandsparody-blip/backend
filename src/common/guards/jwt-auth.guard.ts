/**
 * JwtAuthGuard — validates the Authorization: Bearer <access_token> header on
 * every non-@Public() route. Populates request.user with the decoded payload.
 *
 * Routes that need MFA-fresh access (step-up) should additionally check the
 * `acr` claim — see modules/auth/token.service.ts for the issued shape.
 *
 * Implementation Plan §4.1, §4.2.
 */

import { ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthGuard } from "@nestjs/passport";
import type { Role } from "@prisma/client";

import { IS_PUBLIC_KEY } from "../decorators/public.decorator";

export interface AuthenticatedUser {
  /** User id (UUID). */
  sub: string;
  /** Vendor id, null for admins. */
  vendorId: string | null;
  /** Active role. */
  role: Role;
  /** "Authentication context reference": "1" = pwd only, "2" = pwd + mfa fresh. */
  acr: "1" | "2";
  /** ISO time when the access token was issued. */
  iat: number;
  /** ISO time when the access token expires. */
  exp: number;
}

@Injectable()
export class JwtAuthGuard extends AuthGuard("jwt") {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  override canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }

  override handleRequest<TUser extends AuthenticatedUser>(
    err: unknown,
    user: TUser | false,
    _info: unknown,
  ): TUser {
    if (err || !user) {
      throw new UnauthorizedException("Authentication required.");
    }
    return user;
  }
}
