/**
 * EmailService — unit tests for the pre-provider guards.
 *
 * Scope pinned here:
 *   - invalid recipient short-circuits and never touches provider
 *   - EMAIL_SUPPRESSED_ADDRESSES entries are dropped locally, no fetch,
 *     no "delivered" audit row, but a distinct "skipped_suppressed"
 *     audit row IS written
 *   - matching is case-insensitive
 *   - non-suppressed addresses fall through to the console transport
 *
 * The Resend HTTP path is out of scope — it's exercised via the runbook
 * smoke test against a real key. Unit tests intentionally avoid mocking
 * global fetch because the pre-provider guards must run FIRST regardless
 * of what the provider layer does.
 *
 * IMPORTANT: env is set before any project import — `loadConfig()`
 * caches at module level, so this file must win the race.
 */

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.API_PUBLIC_URL ??= "http://localhost:4000";
process.env.WEB_PUBLIC_URL ??= "http://localhost:3000";
process.env.JWT_ACCESS_SECRET ??= Buffer.alloc(64, 1).toString("base64");
process.env.JWT_REFRESH_SECRET ??= Buffer.alloc(64, 2).toString("base64");
process.env.ENCRYPTION_MASTER_KEY ??= Buffer.alloc(32, 3).toString("base64");
process.env.COOKIE_DOMAIN ??= "localhost";
// Force console transport so a missing RESEND_API_KEY doesn't matter
// and no accidental network call can slip through.
process.env.EMAIL_PROVIDER = "console";
// Two suppressed addresses — one lowercase, one mixed-case seed to
// prove the config normalizes to lowercase and matching is
// case-insensitive from both sides.
process.env.EMAIL_SUPPRESSED_ADDRESSES =
  "blocked@example.com, Case.Mixed@Example.COM";

import type { AuditService } from "../audit/audit.service";
import { EmailService } from "./email.service";

/** Minimal AuditService stub that records the actions it was asked to log. */
function makeAudit(): { audit: AuditService; calls: string[] } {
  const calls: string[] = [];
  const audit = {
    log: jest.fn(async (args: { action: string }) => {
      calls.push(args.action);
    }),
  } as unknown as AuditService;
  return { audit, calls };
}

/**
 * Guard: fail loud if any test in this file accidentally triggers a
 * real network call. Setting fetch to a throwing stub is safer than
 * relying on the console-transport branch to hold — a regression in
 * the guard order would otherwise silently pass with a real POST.
 */
function armFetchTripwire(): jest.SpyInstance {
  return jest.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("fetch was called in a unit test — guard failed");
  });
}

describe("EmailService — pre-provider guards", () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = armFetchTripwire();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    jest.restoreAllMocks();
  });

  describe("invalid recipient", () => {
    it("returns error and never touches provider or audit", async () => {
      const { audit, calls } = makeAudit();
      const svc = new EmailService(audit);
      const result = await svc.send({
        to: "not-an-email",
        subject: "s",
        html: "<p>x</p>",
        text: "x",
        type: "test",
      });
      expect(result).toEqual({ ok: false, error: "invalid_recipient" });
      expect(fetchSpy).not.toHaveBeenCalled();
      // Invalid recipient is a warn-only path; no audit row.
      expect(calls).toEqual([]);
    });
  });

  describe("local suppression list", () => {
    it("skips suppressed lowercase address and writes skipped_suppressed audit row", async () => {
      const { audit, calls } = makeAudit();
      const svc = new EmailService(audit);
      const result = await svc.send({
        to: "blocked@example.com",
        subject: "s",
        html: "<p>x</p>",
        text: "x",
        type: "ops.psn.new",
        idempotencyKey: "psn-42",
      });
      expect(result).toEqual({ ok: false, error: "recipient_suppressed" });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(calls).toEqual(["email.skipped_suppressed"]);
    });

    it("matches case-insensitively (config-side mixed case)", async () => {
      const { audit, calls } = makeAudit();
      const svc = new EmailService(audit);
      const result = await svc.send({
        // Config had "Case.Mixed@Example.COM"; send it lowercased.
        to: "case.mixed@example.com",
        subject: "s",
        html: "<p>x</p>",
        text: "x",
        type: "test",
      });
      expect(result.ok).toBe(false);
      expect(result.error).toBe("recipient_suppressed");
      expect(calls).toEqual(["email.skipped_suppressed"]);
    });

    it("matches case-insensitively (send-side mixed case)", async () => {
      const { audit, calls } = makeAudit();
      const svc = new EmailService(audit);
      const result = await svc.send({
        // Config had "blocked@example.com" (lower); send it mixed.
        to: "Blocked@EXAMPLE.com",
        subject: "s",
        html: "<p>x</p>",
        text: "x",
        type: "test",
      });
      expect(result.ok).toBe(false);
      expect(result.error).toBe("recipient_suppressed");
      expect(calls).toEqual(["email.skipped_suppressed"]);
    });

    it("passes through to console transport for non-suppressed address", async () => {
      const { audit, calls } = makeAudit();
      const svc = new EmailService(audit);
      const result = await svc.send({
        to: "allowed@example.com",
        subject: "s",
        html: "<p>x</p>",
        text: "x",
        type: "test",
      });
      expect(result.ok).toBe(true);
      // Console transport returns a synthetic providerId prefixed "console-".
      expect(result.providerId).toMatch(/^console-\d+$/);
      // Console transport does NOT write an audit row (only the resend
      // path does — see EmailService.send). Nothing to assert beyond
      // the empty call list.
      expect(calls).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
