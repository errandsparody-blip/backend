/**
 * AuthService — the central orchestrator. Coordinates password verification,
 * lockout, MFA, refresh-token issuance, and audit logging.
 *
 * Implementation Plan §4.1, §4.7, §14.1.
 *
 * Security-sensitive. Every change here requires two reviewers per the policy
 * in Implementation Plan §17.1.
 */

import * as argon2 from "argon2";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { Role, UserStatus } from "@prisma/client";

import { loadConfig } from "../../common/config";
import { CryptoService } from "../../common/crypto.service";
import { HibpService } from "../../common/hibp.service";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../audit/audit.service";
import {
  emailVerifyTemplate,
  mfaEnrolledTemplate,
  passwordResetTemplate,
} from "../email/email-templates";
import { EmailService } from "../email/email.service";

import type { LoginInput, SignupInput } from "../../common/schemas/auth.schema";
import { MfaService } from "./mfa.service";
import { TokenService } from "./token.service";

const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  // Tuned for ~250ms verify on production hardware. Re-benchmark on deploy.
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_BACKOFF_SECONDS = [10, 30, 60, 120, 300];

export type AuthResult =
  | {
      kind: "mfa_required";
      challengeToken: string;
      mfaEnrolled: boolean;
    }
  | {
      kind: "authenticated";
      user: PublicUserShape;
      accessToken: string;
      accessExpiresAt: Date;
      refreshToken: string;
      refreshExpiresAt: Date;
    };

export interface PublicUserShape {
  id: string;
  email: string;
  role: Role;
  vendorId: string | null;
  mfaEnrolled: boolean;
  emailVerified: boolean;
}

interface RequestMeta {
  userAgent?: string;
  ip?: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  private readonly cfg = loadConfig();

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly mfa: MfaService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly hibp: HibpService,
    private readonly email: EmailService,
  ) {}

  // ---------------------------------------------------------------------------
  // Signup
  // ---------------------------------------------------------------------------

  async signup(input: SignupInput, meta: RequestMeta): Promise<{ userId: string }> {
    const existing = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (existing) {
      // Return a generic message at the controller layer; throwing here ensures
      // we don't accidentally expose existence via timing or HTTP code variation.
      throw new ConflictException({
        message: "Could not create account.",
        code: "signup_conflict",
      });
    }

    // HIBP k-anonymity check — Implementation Plan §4.1.
    await this.hibp.assertNotPwned(input.password);
    const passwordHash = await argon2.hash(input.password, ARGON2_OPTIONS);

    const { plaintext: emailToken, hash: emailTokenHash } = this.tokens.generateSingleUseToken();

    // Create the vendor + wallet + user atomically. If any fails, none persist.
    const { userId } = await this.prisma.$transaction(async (tx) => {
      const vendor = await tx.vendor.create({
        data: {
          businessName: input.businessName,
          country: input.country,
        },
        select: { id: true },
      });

      // Wallet exists from day one. P2.4 — Implementation Plan §6.4.1.
      await tx.wallet.create({ data: { vendorId: vendor.id } });

      const u = await tx.user.create({
        data: {
          email: input.email,
          passwordHash,
          role: Role.VENDOR,
          vendorId: vendor.id,
          status: UserStatus.PENDING_EMAIL_VERIFICATION,
          emailVerifyTokenHash: emailTokenHash,
          emailVerifyExpiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24), // 24 h
        },
        select: { id: true },
      });

      return { userId: u.id };
    });

    const user = { id: userId };

    // Send the verify email — best effort. The token is the only way for the
    // user to activate the account so we don't want to fail the signup, but
    // we DO surface delivery failure on the audit trail (EmailService logs it).
    const tpl = emailVerifyTemplate({
      email: input.email,
      verifyUrl: `${this.cfg.WEB_PUBLIC_URL}/verify-email?token=${encodeURIComponent(emailToken)}`,
    });
    await this.email.send({
      to: input.email,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      type: "auth.email_verify",
      userId: user.id,
    });

    await this.audit.log({
      actorId: user.id,
      actorRole: Role.VENDOR,
      action: "auth.signup",
      resourceType: "user",
      resourceId: user.id,
      sourceIp: meta.ip,
      userAgent: meta.userAgent,
    });

    return { userId: user.id };
  }

  async verifyEmail(token: string): Promise<void> {
    const tokenHash = this.crypto.sha256(token);
    const user = await this.prisma.user.findFirst({
      where: { emailVerifyTokenHash: tokenHash, emailVerifyExpiresAt: { gt: new Date() } },
    });
    if (!user) {
      throw new BadRequestException({
        message: "Verification link is invalid or has expired.",
        code: "verify_invalid",
      });
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerified: true,
        emailVerifyTokenHash: null,
        emailVerifyExpiresAt: null,
        status: UserStatus.ACTIVE,
      },
    });
    await this.audit.log({
      actorId: user.id,
      actorRole: user.role,
      action: "auth.email_verified",
      resourceType: "user",
      resourceId: user.id,
    });
  }

  // ---------------------------------------------------------------------------
  // Login (password verification + lockout + MFA gate)
  // ---------------------------------------------------------------------------

  async login(input: LoginInput, meta: RequestMeta): Promise<AuthResult> {
    const user = await this.prisma.user.findUnique({ where: { email: input.email } });

    // Always run argon2 to prevent user-enumeration via timing.
    const dummyHash =
      "$argon2id$v=19$m=19456,t=2,p=1$dummysalt$dummyhashdummyhashdummyhashdummyhashdummyhashdummy";
    const passwordOk = await argon2.verify(user?.passwordHash ?? dummyHash, input.password).catch(() => false);

    if (!user || !passwordOk) {
      if (user) await this.recordFailedLogin(user.id, meta);
      throw new UnauthorizedException({
        message: "Invalid email or password.",
        code: "auth_invalid_credentials",
      });
    }

    // Lockout check.
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new ForbiddenException({
        message: "Account temporarily locked due to too many failed attempts.",
        code: "auth_locked",
      });
    }

    if (user.status === UserStatus.SUSPENDED || user.status === UserStatus.CLOSED) {
      throw new ForbiddenException({
        message: "Account is not active.",
        code: "auth_account_inactive",
      });
    }

    // Reset the failure counter on success-but-pre-MFA.
    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null },
    });

    if (user.status === UserStatus.PENDING_EMAIL_VERIFICATION) {
      throw new ForbiddenException({
        message: "Please verify your email before signing in.",
        code: "auth_email_unverified",
      });
    }

    // Issue an MFA challenge token. The client must call /auth/2fa/verify next.
    const challengeToken = this.tokens.signMfaChallenge(user.id);

    await this.audit.log({
      actorId: user.id,
      actorRole: user.role,
      action: "auth.password_verified",
      resourceType: "user",
      resourceId: user.id,
      sourceIp: meta.ip,
      userAgent: meta.userAgent,
    });

    return {
      kind: "mfa_required",
      challengeToken,
      mfaEnrolled: user.mfaEnrolled,
    };
  }

  // ---------------------------------------------------------------------------
  // MFA verification — completes the login
  // ---------------------------------------------------------------------------

  async verifyMfa(
    challengeToken: string,
    code: string,
    meta: RequestMeta,
  ): Promise<Extract<AuthResult, { kind: "authenticated" }>> {
    const { sub: userId } = this.tokens.verifyMfaChallenge(challengeToken);
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException("Challenge subject not found.");

    if (!user.mfaEnrolled) {
      // The client must run the enroll flow first; this endpoint is for
      // already-enrolled users.
      throw new BadRequestException({
        message: "MFA is not yet enrolled.",
        code: "mfa_not_enrolled",
      });
    }

    const ok = await this.mfa.verifyTotpForUser(userId, code);
    if (!ok) {
      await this.recordFailedLogin(userId, meta);
      throw new UnauthorizedException({
        message: "Invalid authentication code.",
        code: "mfa_invalid",
      });
    }

    return this.completeAuthentication(user, "2", meta);
  }

  async verifyMfaWithRecovery(
    challengeToken: string,
    recoveryCode: string,
    meta: RequestMeta,
  ): Promise<Extract<AuthResult, { kind: "authenticated" }>> {
    const { sub: userId } = this.tokens.verifyMfaChallenge(challengeToken);
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException("Challenge subject not found.");

    const consumed = await this.mfa.consumeRecoveryCode(userId, recoveryCode);
    if (!consumed) {
      await this.recordFailedLogin(userId, meta);
      throw new UnauthorizedException({
        message: "Invalid recovery code.",
        code: "mfa_recovery_invalid",
      });
    }

    return this.completeAuthentication(user, "2", meta);
  }

  // ---------------------------------------------------------------------------
  // MFA enrollment
  // ---------------------------------------------------------------------------

  async beginMfaEnrollment(userId: string): Promise<{ qrDataUrl: string; pendingSecret: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();
    const { secret, qrDataUrl } = await this.mfa.beginEnrollment(user.email);
    // The plaintext secret is returned to the client (just to round-trip — they
    // pass it back on confirm). We do not persist until confirmation.
    return { qrDataUrl, pendingSecret: secret };
  }

  async confirmMfaEnrollment(
    userId: string,
    pendingSecret: string,
    code: string,
  ): Promise<{ recoveryCodes: string[] }> {
    if (!this.mfa.verifyEnrollmentCode(pendingSecret, code)) {
      throw new BadRequestException({
        message: "Code did not match. Try again with a fresh code.",
        code: "mfa_enroll_code_invalid",
      });
    }
    const result = await this.mfa.finishEnrollment(userId, pendingSecret);
    await this.audit.log({
      actorId: userId,
      action: "auth.mfa_enrolled",
      resourceType: "user",
      resourceId: userId,
    });

    // Notify the user — security event. Failures are non-blocking.
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (user?.email) {
      const tpl = mfaEnrolledTemplate({ email: user.email });
      await this.email.send({
        to: user.email,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
        type: "auth.mfa_enrolled",
        userId,
      });
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Refresh / logout
  // ---------------------------------------------------------------------------

  async refresh(refreshToken: string, meta: RequestMeta) {
    const { token, expiresAt, user } = await this.tokens.rotateRefreshToken(refreshToken, meta);
    const access = this.tokens.signAccessToken(user, "1"); // baseline acr; step-up requires re-auth
    return {
      user: this.toPublicUser(user),
      accessToken: access.token,
      accessExpiresAt: access.expiresAt,
      refreshToken: token,
      refreshExpiresAt: expiresAt,
    };
  }

  async logout(sessionRefreshToken: string | undefined): Promise<void> {
    if (!sessionRefreshToken) return;
    const tokenHash = this.crypto.sha256(sessionRefreshToken);
    const session = await this.prisma.session.findFirst({
      where: { refreshTokenHash: tokenHash, revokedAt: null },
    });
    if (session) {
      await this.tokens.revokeSession(session.id, "user_logout");
      await this.audit.log({
        actorId: session.userId,
        action: "auth.logout",
        resourceType: "session",
        resourceId: session.id,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Forgot / reset password
  // ---------------------------------------------------------------------------

  /**
   * Always returns success to the client (no user-enumeration). If the email
   * exists, generate a single-use token (1h TTL), persist its hash, and enqueue
   * the reset email.
   */
  async forgotPassword(email: string, meta: RequestMeta): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.status !== UserStatus.ACTIVE) {
      // Do nothing (silent), but still consume time to flatten timing.
      await argon2.verify(
        "$argon2id$v=19$m=19456,t=2,p=1$dummysalt$dummyhashdummyhashdummyhashdummyhashdummyhashdummy",
        "x",
      ).catch(() => false);
      return;
    }

    const { plaintext: token, hash: tokenHash } = this.tokens.generateSingleUseToken();
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordResetTokenHash: tokenHash,
        passwordResetExpiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1h
      },
    });

    const tpl = passwordResetTemplate({
      email: user.email,
      resetUrl: `${this.cfg.WEB_PUBLIC_URL}/reset-password?token=${encodeURIComponent(token)}`,
    });
    await this.email.send({
      to: user.email,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      type: "auth.password_reset",
      userId: user.id,
    });

    await this.audit.log({
      actorId: user.id,
      actorRole: user.role,
      action: "auth.password_reset_requested",
      resourceType: "user",
      resourceId: user.id,
      sourceIp: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  /**
   * Reset the password. The user must:
   *   - present a valid, unexpired single-use token, AND
   *   - if MFA is enrolled, present a valid TOTP code.
   *
   * On success: rotate password, revoke EVERY active session (force re-login),
   * clear the lockout counter, audit-log.
   */
  async resetPassword(
    token: string,
    newPassword: string,
    mfaCode: string | undefined,
    meta: RequestMeta,
  ): Promise<void> {
    const tokenHash = this.crypto.sha256(token);
    const user = await this.prisma.user.findFirst({
      where: {
        passwordResetTokenHash: tokenHash,
        passwordResetExpiresAt: { gt: new Date() },
      },
    });
    if (!user) {
      throw new BadRequestException({
        message: "Reset link is invalid or has expired.",
        code: "reset_invalid",
      });
    }

    if (user.mfaEnrolled) {
      if (!mfaCode) {
        throw new BadRequestException({
          message: "Please include your authenticator code to complete the reset.",
          code: "mfa_required",
        });
      }
      const ok = await this.mfa.verifyTotpForUser(user.id, mfaCode);
      if (!ok) {
        throw new UnauthorizedException({
          message: "Authenticator code did not match.",
          code: "mfa_invalid",
        });
      }
    }

    await this.hibp.assertNotPwned(newPassword);
    const passwordHash = await argon2.hash(newPassword, ARGON2_OPTIONS);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          passwordResetTokenHash: null,
          passwordResetExpiresAt: null,
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });
      await tx.session.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: "password_reset" },
      });
    });

    await this.audit.log({
      actorId: user.id,
      actorRole: user.role,
      action: "auth.password_reset_completed",
      resourceType: "user",
      resourceId: user.id,
      sourceIp: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async recordFailedLogin(userId: string, _meta: RequestMeta): Promise<void> {
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true },
    });
    if (updated.failedLoginCount >= LOCKOUT_THRESHOLD) {
      const idx = Math.min(updated.failedLoginCount - LOCKOUT_THRESHOLD, LOCKOUT_BACKOFF_SECONDS.length - 1);
      const seconds = LOCKOUT_BACKOFF_SECONDS[idx] ?? 300;
      await this.prisma.user.update({
        where: { id: userId },
        data: { lockedUntil: new Date(Date.now() + seconds * 1000) },
      });
      await this.audit.log({
        actorId: userId,
        action: "auth.locked",
        resourceType: "user",
        resourceId: userId,
        afterState: { lockedSeconds: seconds },
      });
    }
  }

  private async completeAuthentication(
    user: { id: string; vendorId: string | null; role: Role },
    acr: "1" | "2",
    meta: RequestMeta,
  ): Promise<Extract<AuthResult, { kind: "authenticated" }>> {
    const access = this.tokens.signAccessToken(user, acr);
    const refresh = await this.tokens.issueRefreshToken({ id: user.id }, meta);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null },
    });

    await this.audit.log({
      actorId: user.id,
      action: acr === "2" ? "auth.mfa_verified" : "auth.session_started",
      resourceType: "session",
      resourceId: refresh.sessionId,
      sourceIp: meta.ip,
      userAgent: meta.userAgent,
    });

    const full = await this.prisma.user.findUnique({ where: { id: user.id } });
    if (!full) throw new UnauthorizedException();

    return {
      kind: "authenticated",
      user: this.toPublicUser(full),
      accessToken: access.token,
      accessExpiresAt: access.expiresAt,
      refreshToken: refresh.token,
      refreshExpiresAt: refresh.expiresAt,
    };
  }

  private toPublicUser(u: {
    id: string;
    email: string;
    role: Role;
    vendorId: string | null;
    mfaEnrolled: boolean;
    emailVerified: boolean;
  }): PublicUserShape {
    return {
      id: u.id,
      email: u.email,
      role: u.role,
      vendorId: u.vendorId,
      mfaEnrolled: u.mfaEnrolled,
      emailVerified: u.emailVerified,
    };
  }

  /** Cookie helper used by the controller to write/clear the refresh cookie. */
  cookieOptions() {
    const cfg = loadConfig();
    return {
      httpOnly: true,
      secure: cfg.COOKIE_SECURE,
      sameSite: "strict" as const,
      domain: cfg.COOKIE_DOMAIN,
      path: "/v1/auth",
      maxAge: cfg.JWT_REFRESH_TTL_SECONDS * 1000,
    };
  }
}
