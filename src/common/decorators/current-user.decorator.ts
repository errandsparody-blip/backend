import { createParamDecorator, ExecutionContext } from "@nestjs/common";

import type { AuthenticatedUser } from "../guards/jwt-auth.guard";

/**
 * Inject the authenticated user into a controller method parameter.
 *   handler(@CurrentUser() user: AuthenticatedUser) { ... }
 *
 * The user is populated by JwtAuthGuard from the validated access token.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const req = ctx.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    if (!req.user) {
      throw new Error(
        "CurrentUser decorator used on a route without JwtAuthGuard. " +
          "Either add @UseGuards(JwtAuthGuard) or mark the route @Public().",
      );
    }
    return req.user;
  },
);
