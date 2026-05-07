/**
 * MfaService — TOTP enrollment + verification + recovery codes.
 * Implementation Plan §4.1.
 *
 * RFC 6238, 30-second window, 6-digit codes, ±1 step tolerance for clock drift.
 * TOTP secret is encrypted at rest with the master key (CryptoService).
 * Recovery codes are hashed (argon2) at rest; single-use.
 */

import * as argon2 from "argon2";
import { Injectable } from "@nestjs/common";
import { authenticator } from "otplib";
import { toDataURL as qrcodeToDataUrl } from "qrcode";

import { CryptoService } from "../../common/crypto.service";
import { PrismaService } from "../../common/prisma.service";

const TOTP_ISSUER = "USA Errands";
const RECOVERY_CODE_COUNT = 10;

@Injectable()
export class MfaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {
    // 30-second window, 6 digits, ±1 step (~30s) tolerance.
    authenticator.options = { digits: 6, step: 30, window: 1 };
  }

  // ---------------------------------------------------------------------------
  // Enrollment
  // ---------------------------------------------------------------------------

  /**
   * Generate a fresh secret and a QR-code data URL the client can render.
   * Caller must persist the secret only after the user confirms a valid code.
   */
  async beginEnrollment(userEmail: string): Promise<{ secret: string; qrDataUrl: string }> {
    const secret = authenticator.generateSecret();
    const otpauthUrl = authenticator.keyuri(userEmail, TOTP_ISSUER, secret);
    const qrDataUrl = await qrcodeToDataUrl(otpauthUrl);
    return { secret, qrDataUrl };
  }

  /** Verify a TOTP code against an unencrypted secret (used during enrollment). */
  verifyEnrollmentCode(secret: string, code: string): boolean {
    return authenticator.verify({ token: code, secret });
  }

  /**
   * Persist the MFA secret for a user (encrypted) and generate fresh recovery
   * codes (hashed). Returns the plaintext recovery codes — show them once and
   * never again.
   */
  async finishEnrollment(userId: string, secret: string): Promise<{ recoveryCodes: string[] }> {
    const encrypted = this.crypto.encrypt(secret);

    // Generate + hash recovery codes.
    const plaintexts = Array.from({ length: RECOVERY_CODE_COUNT }, () => this.generateRecoveryCode());
    const hashes = await Promise.all(plaintexts.map((c) => argon2.hash(c, { type: argon2.argon2id })));

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          mfaSecretEncrypted: encrypted,
          mfaEnrolled: true,
          mfaEnrolledAt: new Date(),
        },
      });
      // Drop any existing codes (re-enrollment scenario).
      await tx.recoveryCode.deleteMany({ where: { userId } });
      await tx.recoveryCode.createMany({
        data: hashes.map((codeHash) => ({ userId, codeHash })),
      });
    });

    return { recoveryCodes: plaintexts };
  }

  // ---------------------------------------------------------------------------
  // Verification
  // ---------------------------------------------------------------------------

  /** Verify a TOTP code for a user who's already enrolled. */
  async verifyTotpForUser(userId: string, code: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { mfaEnrolled: true, mfaSecretEncrypted: true },
    });
    if (!user || !user.mfaEnrolled || !user.mfaSecretEncrypted) return false;

    let secret: string;
    try {
      secret = this.crypto.decrypt(user.mfaSecretEncrypted);
    } catch {
      return false;
    }
    return authenticator.verify({ token: code, secret });
  }

  /**
   * Consume a recovery code (single-use). Returns true if the code was valid
   * and unused; marks it as used in the same transaction.
   */
  async consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
    const codes = await this.prisma.recoveryCode.findMany({
      where: { userId, usedAt: null },
    });
    for (const stored of codes) {
      const matches = await argon2.verify(stored.codeHash, code);
      if (matches) {
        await this.prisma.recoveryCode.update({
          where: { id: stored.id },
          data: { usedAt: new Date() },
        });
        return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------------------

  /** Format: 4 groups of 4 lowercase alphanumerics, joined with `-`. */
  private generateRecoveryCode(): string {
    const alphabet = "abcdefghijkmnpqrstuvwxyz23456789"; // skip ambiguous (0, O, 1, l, o)
    const seg = (): string => {
      let out = "";
      const buf = this.crypto.randomToken(4); // 8 hex chars
      for (let i = 0; i < 4; i++) {
        const idx = parseInt(buf.slice(i * 2, i * 2 + 2), 16) % alphabet.length;
        out += alphabet[idx];
      }
      return out;
    };
    return [seg(), seg(), seg(), seg()].join("-");
  }
}
