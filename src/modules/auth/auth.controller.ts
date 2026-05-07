/**
 * AuthController — public-facing auth endpoints. Implementation Plan §11.2 (Auth).
 *
 * All write endpoints are rate-limited (TighterAuthThrottler in app.module).
 * Refresh tokens are NEVER returned in JSON — only set as httpOnly cookies.
 * Access tokens are returned in JSON for the client to keep in memory.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Request, Response } from "express";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Public } from "../../common/decorators/public.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  enrollMfaConfirmSchema,
  forgotPasswordSchema,
  loginSchema,
  recoveryMfaSchema,
  resetPasswordSchema,
  signupSchema,
  verifyEmailSchema,
  verifyMfaSchema,
  type EnrollMfaConfirmInput,
  type ForgotPasswordInput,
  type LoginInput,
  type RecoveryMfaInput,
  type ResetPasswordInput,
  type SignupInput,
  type VerifyEmailInput,
  type VerifyMfaInput,
} from "../../common/schemas/auth.schema";
import { loadConfig } from "../../common/config";
import { AuthService } from "./auth.service";

interface ReqMeta {
  userAgent?: string;
  ip?: string;
}

function metaOf(req: Request): ReqMeta {
  return {
    userAgent: req.headers["user-agent"] ?? undefined,
    ip: req.ip ?? undefined,
  };
}

@Controller({ path: "auth", version: "1" })
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // ---------------------------------------------------------------------------
  // Signup + email verification
  // ---------------------------------------------------------------------------

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("signup")
  @HttpCode(HttpStatus.CREATED)
  async signup(
    @Body(new ZodValidationPipe(signupSchema)) body: SignupInput,
    @Req() req: Request,
  ): Promise<{ ok: true; userId: string }> {
    const { userId } = await this.auth.signup(body, metaOf(req));
    return { ok: true, userId };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get("verify-email")
  async verifyEmail(@Query(new ZodValidationPipe(verifyEmailSchema)) q: VerifyEmailInput) {
    await this.auth.verifyEmail(q.token);
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Login → MFA challenge → verify MFA
  // ---------------------------------------------------------------------------

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("login")
  @HttpCode(HttpStatus.OK)
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: LoginInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(body, metaOf(req));
    if (result.kind === "authenticated") {
      this.setRefreshCookie(res, result.refreshToken);
      return {
        accessToken: result.accessToken,
        expiresAt: result.accessExpiresAt.toISOString(),
        user: result.user,
      };
    }
    return {
      status: "mfa_required" as const,
      challengeToken: result.challengeToken,
      mfaEnrolled: result.mfaEnrolled,
    };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("2fa/verify")
  @HttpCode(HttpStatus.OK)
  async verifyMfa(
    @Body(new ZodValidationPipe(verifyMfaSchema)) body: VerifyMfaInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.auth.verifyMfa(body.challengeToken, body.code, metaOf(req));
    this.setRefreshCookie(res, r.refreshToken);
    return {
      accessToken: r.accessToken,
      expiresAt: r.accessExpiresAt.toISOString(),
      user: r.user,
    };
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("2fa/recovery")
  @HttpCode(HttpStatus.OK)
  async verifyMfaWithRecovery(
    @Body(new ZodValidationPipe(recoveryMfaSchema)) body: RecoveryMfaInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.auth.verifyMfaWithRecovery(body.challengeToken, body.recoveryCode, metaOf(req));
    this.setRefreshCookie(res, r.refreshToken);
    return {
      accessToken: r.accessToken,
      expiresAt: r.accessExpiresAt.toISOString(),
      user: r.user,
    };
  }

  // ---------------------------------------------------------------------------
  // MFA enrollment (for users who passed login but mfaEnrolled=false)
  // ---------------------------------------------------------------------------

  @UseGuards(JwtAuthGuard)
  @Post("2fa/enroll")
  @HttpCode(HttpStatus.OK)
  async beginMfaEnroll(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.beginMfaEnrollment(user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Post("2fa/enroll/confirm")
  @HttpCode(HttpStatus.OK)
  async confirmMfaEnroll(
    @CurrentUser() user: AuthenticatedUser,
    @Body() rawBody: { pendingSecret: string; code: string },
    @Body(new ZodValidationPipe(enrollMfaConfirmSchema)) _validated: EnrollMfaConfirmInput,
  ) {
    if (!rawBody.pendingSecret || typeof rawBody.pendingSecret !== "string") {
      throw new Error("pendingSecret missing");
    }
    return this.auth.confirmMfaEnrollment(user.sub, rawBody.pendingSecret, rawBody.code);
  }

  // ---------------------------------------------------------------------------
  // Refresh / logout
  // ---------------------------------------------------------------------------

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const cfg = loadConfig();
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies ?? {};
    const refreshToken = cookies[cfg.COOKIE_REFRESH_NAME];
    if (!refreshToken) {
      return res.status(HttpStatus.UNAUTHORIZED).json({
        message: "Refresh cookie missing.",
        code: "refresh_missing",
      });
    }
    const r = await this.auth.refresh(refreshToken, metaOf(req));
    this.setRefreshCookie(res, r.refreshToken);
    return {
      accessToken: r.accessToken,
      expiresAt: r.accessExpiresAt.toISOString(),
      user: r.user,
    };
  }

  // ---------------------------------------------------------------------------
  // Forgot / reset password
  // ---------------------------------------------------------------------------

  @Public()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post("forgot-password")
  @HttpCode(HttpStatus.OK)
  async forgotPassword(
    @Body(new ZodValidationPipe(forgotPasswordSchema)) body: ForgotPasswordInput,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    await this.auth.forgotPassword(body.email, metaOf(req));
    // Always 200 OK to prevent user-enumeration.
    return { ok: true };
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("reset-password")
  @HttpCode(HttpStatus.OK)
  async resetPassword(
    @Body(new ZodValidationPipe(resetPasswordSchema)) body: ResetPasswordInput,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    await this.auth.resetPassword(body.token, body.newPassword, body.mfaCode, metaOf(req));
    return { ok: true };
  }

  @Public()
  @Post("logout")
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const cfg = loadConfig();
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies ?? {};
    const refreshToken = cookies[cfg.COOKIE_REFRESH_NAME];
    await this.auth.logout(refreshToken);
    this.clearRefreshCookie(res);
  }

  // ---------------------------------------------------------------------------

  private setRefreshCookie(res: Response, token: string): void {
    const cfg = loadConfig();
    res.cookie(cfg.COOKIE_REFRESH_NAME, token, this.auth.cookieOptions());
  }

  private clearRefreshCookie(res: Response): void {
    const cfg = loadConfig();
    res.clearCookie(cfg.COOKIE_REFRESH_NAME, {
      path: "/v1/auth",
      domain: cfg.COOKIE_DOMAIN,
    });
  }
}
