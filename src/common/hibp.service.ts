/**
 * HibpService — checks a candidate password against the HaveIBeenPwned
 * Pwned Passwords v3 API using k-anonymity. The full password never leaves
 * the server; only the first 5 hex chars of its SHA-1 hash do.
 *
 * https://haveibeenpwned.com/API/v3#PwnedPasswords
 *
 * Implementation Plan §4.1.
 *
 * Failure mode: if HIBP is unreachable, the check FAILS OPEN (logs a warning,
 * permits the password). This is deliberate — taking auth offline because of
 * an external dependency is worse than letting a borderline password through.
 * Flip FAIL_CLOSED to true if we ever want stricter behaviour.
 */

import { createHash } from "node:crypto";

import { BadRequestException, Injectable, Logger } from "@nestjs/common";

const FAIL_CLOSED = false;

@Injectable()
export class HibpService {
  private readonly logger = new Logger(HibpService.name);

  /**
   * @returns count of breach occurrences (0 = safe). Throws only if FAIL_CLOSED
   * is true and the upstream call failed; otherwise returns 0 on network error.
   */
  async checkPwned(password: string): Promise<number> {
    const sha1 = createHash("sha1").update(password).digest("hex").toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);

    try {
      const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
        headers: { "Add-Padding": "true", "User-Agent": "usa-errands/1.0" },
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) {
        this.logger.warn({ status: res.status }, "HIBP responded non-OK; treating as not-pwned.");
        if (FAIL_CLOSED) throw new Error("HIBP unreachable");
        return 0;
      }
      const text = await res.text();
      for (const line of text.split("\n")) {
        const [hashSuffix, countStr] = line.trim().split(":");
        if (!hashSuffix || !countStr) continue;
        if (hashSuffix.toUpperCase() === suffix) {
          const count = Number.parseInt(countStr, 10);
          return Number.isFinite(count) ? count : 1;
        }
      }
      return 0;
    } catch (err) {
      this.logger.warn({ err }, "HIBP check failed; treating as not-pwned.");
      if (FAIL_CLOSED) throw err;
      return 0;
    }
  }

  /** Convenience: throws BadRequest if the password has appeared in a breach. */
  async assertNotPwned(password: string): Promise<void> {
    const count = await this.checkPwned(password);
    if (count > 0) {
      throw new BadRequestException({
        message: "This password has appeared in a known data breach. Pick another one.",
        code: "password_pwned",
      });
    }
  }
}
