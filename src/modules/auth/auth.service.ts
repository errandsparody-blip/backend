/**
 * AuthService — the central orchestrator. Coordinates password verification,
 * lockout, MFA, refresh-token issuance, and audit logging.
 *
 * Implementation Plan §4.1, §4.7, §14.1.
 *
 * Security-sensitive. Every change here requires two reviewers per the policy
 * in Implementation Plan §17.1.
 */

import { timingSafeEqual } from "node:crypto";

import * as argon2 from "argon2";
import {
  BadRequestException,
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
  existingAccountReminderTemplate,
  mfaEnrolledTemplate,
  passwordResetTemplate,
} from "../email/email-templates";
import { EmailService } from "../email/email.service";
import { AgreementService } from "../vendors/agreement.service";

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
    private readonly agreement: AgreementService,
  ) {}

  // ---------------------------------------------------------------------------
  // Signup
  // ---------------------------------------------------------------------------

  async signup(input: SignupInput, meta: RequestMeta): Promise<{ userId: string }> {
    const existing = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (existing) {
      // "Always succeed" pattern — the API never confirms whether an email
      // is already taken, because that would let attackers enumerate the
      // user base by brute-forcing signups. We instead:
      //   1. Send a "you already have an account" reminder to the legit
      //      owner of the inbox, with a sign-in link + reset-password link.
      //   2. Run argon2 on a dummy hash to match the timing of the
      //      successful path so signups can't be distinguished by latency.
      //   3. Return a synthetic userId that has no relation to any real
      //      user record — the frontend treats this branch identically to
      //      a brand-new signup ("we sent you a code/link, check inbox").
      // Audit it for ops visibility but don't link it to the existing user.
      await argon2
        .hash(input.password, ARGON2_OPTIONS)
        .catch(() => undefined);

      const tpl = existingAccountReminderTemplate({ email: input.email });
      await this.email.send({
        to: input.email,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
        type: "auth.signup_existing_email_attempt",
        // Tied to the existing user so support can look it up if asked.
        userId: existing.id,
      });

      await this.audit.log({
        // Logged against the real user but with the IP/UA of the attempt
        // so we can correlate brute-force attempts later.
        actorId: existing.id,
        actorRole: existing.role,
        action: "auth.signup_existing_email_attempt",
        resourceType: "user",
        resourceId: existing.id,
        sourceIp: meta.ip,
        userAgent: meta.userAgent,
      });

      // Return a synthetic uuid — frontend doesn't store this, just keeps
      // the response shape consistent with a real signup. We deliberately
      // do NOT return existing.id; that would leak existence to anyone
      // logging API responses.
      return { userId: "00000000-0000-0000-0000-000000000000" };
    }

    // HIBP k-anonymity check — Implementation Plan §4.1.
    await this.hibp.assertNotPwned(input.password);
    const passwordHash = await argon2.hash(input.password, ARGON2_OPTIONS);

    // Resolve the currently-published agreement version OUTSIDE the
    // transaction so a slow config-row read doesn't extend the tx.
    //
    // The signup form does NOT collect an explicit "I accept" checkbox any
    // more — continued use of the platform after signup constitutes
    // acceptance per the agreement's preamble. We still stamp the version
    // + timestamp on the new Vendor row so the AgreementVersionGuard sees
    // the vendor as up-to-date and the post-login flow never bounces them
    // to /legal/vendor-agreement?reaccept=1. Failing to resolve the
    // version lets us bail BEFORE we've committed a user — better than a
    // half-onboarded vendor with no agreement stamp.
    const agreementVersion = await this.agreement.getCurrentVersion();
    const agreementAcceptedAt = new Date();

    // 8-digit numeric code, hashed for storage. Plaintext goes in the email
    // body; the user types it back into the verify form. Expires in 15 minutes
    // — short enough to limit a leaked code's usefulness, long enough that an
    // email queued or briefly delayed still arrives in time. Length bumped
    // from 6 → 8 (security audit M-4) to raise distributed-brute-force cost
    // by ~100×.
    const { plaintext: emailCode, hash: emailTokenHash } = this.tokens.generateNumericCode(8);

    // Create the vendor + wallet + user atomically. If any fails, none persist.
    const { userId } = await this.prisma.$transaction(async (tx) => {
      const vendor = await tx.vendor.create({
        data: {
          businessName: input.businessName,
          country: input.country,
          // Implicit acceptance — see the comment on `agreementVersion` above.
          // Stamping at create time keeps the AgreementVersionGuard from
          // firing for new vendors, so the post-login flow never lands them
          // on /legal/vendor-agreement?reaccept=1.
          agreementAcceptedAt,
          agreementVersion,
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
          emailVerifyExpiresAt: new Date(Date.now() + 1000 * 60 * 15), // 15 min
        },
        select: { id: true },
      });

      return { userId: u.id };
    });

    const user = { id: userId };

    // Send the verify email — best effort. The code is the only way for the
    // user to activate the account so we don't want to fail the signup, but
    // we DO surface delivery failure on the audit trail (EmailService logs it).
    const tpl = emailVerifyTemplate({
      email: input.email,
      code: emailCode,
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
      // Capture the signed-version + timestamp so the durable audit trail
      // matches what's persisted on the Vendor row. If Legal later disputes
      // a vendor's account of which version they accepted, both records
      // line up to the same instant.
      afterState: {
        agreementVersion,
        agreementAcceptedAt: agreementAcceptedAt.toISOString(),
      },
    });

    return { userId: user.id };
  }

  /**
   * Verify a user's email by numeric code (8 digits as of the M-4 hardening;
   * the Zod schema also accepts 6 transitionally for any legacy codes still in
   * flight at deploy time). Looks up the user by email, compares the stored
   * sha256 hash to the hash of the submitted code, and on match flips status
   * → ACTIVE.
   *
   * Security:
   *   - Constant-time comparison via timingSafeEqual on the SHA-256 hashes.
   *   - Return identical `verify_invalid` for "no such user", "wrong code",
   *     "expired", or "already verified" so attackers can't enumerate via
   *     this endpoint. The throttler caps brute-force at 10/min/IP.
   *   - Code is single-use: cleared on success, regardless of subsequent
   *     attempts to replay it.
   */
  async verifyEmail(email: string, code: string): Promise<void> {
    const codeHash = this.crypto.sha256(code);
    const user = await this.prisma.user.findUnique({ where: { email } });

    // Always do the constant-time comparison even when the user doesn't exist
    // or has no pending verification, against a dummy hash, so timing doesn't
    // leak existence.
    const storedHash = user?.emailVerifyTokenHash ?? "x".repeat(64);
    const submittedBuf = Buffer.from(codeHash, "hex");
    const storedBuf = Buffer.from(storedHash, "hex");
    const sameLen = submittedBuf.length === storedBuf.length;
    const matches = sameLen && timingSafeEqual(submittedBuf, storedBuf);

    const expired = !user?.emailVerifyExpiresAt || user.emailVerifyExpiresAt <= new Date();
    const valid =
      !!user &&
      user.status === UserStatus.PENDING_EMAIL_VERIFICATION &&
      !expired &&
      matches;

    if (!valid || !user) {
      throw new BadRequestException({
        message: "That code is invalid or has expired.",
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

  /**
   * Issue a fresh verification code to a user whose email is still pending.
   * Always returns void — never confirms account existence to the caller.
   *
   * If the email matches a still-pending account, we generate a new code,
   * overwrite the stored hash + expiry, and send a fresh email. If the email
   * matches an already-verified account, an inactive account, or no account
   * at all, we silently no-op. The throttler caps abuse at 3 / hour / IP.
   */
  async resendVerifyEmail(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.status !== UserStatus.PENDING_EMAIL_VERIFICATION) {
      return; // silent no-op — never enumerate
    }

    // 8-digit code (security audit M-4 — same rationale as signup).
    const { plaintext: code, hash: codeHash } = this.tokens.generateNumericCode(8);
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerifyTokenHash: codeHash,
        emailVerifyExpiresAt: new Date(Date.now() + 1000 * 60 * 15),
      },
    });

    const tpl = emailVerifyTemplate({ email, code });
    await this.email.send({
      to: email,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      type: "auth.email_verify",
      userId: user.id,
    });

    await this.audit.log({
      actorId: user.id,
      actorRole: user.role,
      action: "auth.email_verify_resent",
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

    // First-time login (MFA not yet enrolled): issue a low-privilege access
    // token (acr="1" — password-only auth). This lets the user reach the
    // /auth/2fa/enroll endpoint to set up their authenticator. After
    // enrollment, future logins go through /auth/2fa/verify and issue
    // acr="2" tokens. Wallet, finance, and other sensitive endpoints should
    // gate on acr="2"; that's tracked separately in the security review.
    if (!user.mfaEnrolled) {
      await this.audit.log({
        actorId: user.id,
        actorRole: user.role,
        action: "auth.password_verified_pre_mfa",
        resourceType: "user",
        resourceId: user.id,
        sourceIp: meta.ip,
        userAgent: meta.userAgent,
      });
      return this.completeAuthentication(
        { id: user.id, vendorId: user.vendorId, role: user.role },
        "1",
        meta,
      );
    }

    // Returning user with MFA enrolled — issue an MFA challenge token. The
    // client must call /auth/2fa/verify next to obtain an acr="2" session.
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
    const { token, expiresAt, user, sessionId } = await this.tokens.rotateRefreshToken(
      refreshToken,
      meta,
    );
    // Bind the new access token to the rotated session id so the JWT
    // strategy can verify the session is still active on every request
    // (security audit H-1 — closes the post-logout / post-revocation
    // residual window).
    const access = this.tokens.signAccessToken(user, "1", sessionId); // baseline acr; step-up requires re-auth
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
    // Issue the refresh token first so we know the session id, then
    // bind that into the access token's `sessionId` claim (security
    // audit H-1 — enables per-request session-revocation enforcement).
    const refresh = await this.tokens.issueRefreshToken({ id: user.id }, meta);
    const access = this.tokens.signAccessToken(user, acr, refresh.sessionId);

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

  /**
   * Cookie helper used by the controller to write/clear the refresh cookie.
   *
   * SameSite policy:
   *   - When COOKIE_SECURE=true (any prod-like environment), the API is
   *     hosted cross-origin from the web app (e.g., Vercel ↔ Railway, where
   *     the parent domains differ). Browsers will only send the cookie on
   *     credentialed cross-site requests when SameSite=None and Secure=true.
   *   - In local dev (COOKIE_SECURE=false) we use SameSite=Lax — both client
   *     and server are on localhost, so cross-site doesn't apply, and Lax
   *     gives a tiny bit more CSRF protection than None.
   *
   * Either way the cookie is httpOnly, scoped to the /v1/auth path, and bound
   * to COOKIE_DOMAIN — JS on the page can't read it, and it's never sent on
   * unrelated requests.
   */
  cookieOptions() {
    const cfg = loadConfig();
    return {
      httpOnly: true,
      secure: cfg.COOKIE_SECURE,
      sameSite: (cfg.COOKIE_SECURE ? "none" : "lax") as "none" | "lax",
      domain: cfg.COOKIE_DOMAIN,
      path: "/v1/auth",
      maxAge: cfg.JWT_REFRESH_TTL_SECONDS * 1000,
    };
  }
}
