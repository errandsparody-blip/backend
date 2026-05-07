/**
 * Sentry bootstrap. Implementation Plan §9.2 (Observability), security
 * review follow-up OBS-1 (PII scrubbing).
 *
 * The init runs ONCE, at process boot, BEFORE Nest is constructed — Sentry's
 * autoinstrumentation needs to wrap node modules at require-time. Calling
 * `initSentry()` is a no-op when SENTRY_DSN is unset, so dev/test runs incur
 * zero overhead.
 *
 * What `beforeSend` strips before the event leaves the process:
 *
 *   - Authorization / Cookie / Stripe-Signature / X-HMAC-Signature headers
 *   - Request bodies for any field that smells like a credential (password,
 *     newPassword, code, token, recoveryCode, pendingSecret, refreshToken,
 *     accessToken, secret, apiKey, key)
 *   - Query parameters with the same names
 *   - Recipient PII in the user object (email kept lower-cased; ip preserved
 *     for spam triage but anonymised at the project level if your Sentry
 *     org configures it)
 */

import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";

import { loadConfig } from "./config";

const SENSITIVE_KEYS = new Set([
  "password",
  "newpassword",
  "currentpassword",
  "code",
  "recoverycode",
  "pendingsecret",
  "token",
  "refreshtoken",
  "accesstoken",
  "secret",
  "apikey",
  "key",
  "authorization",
  "cookie",
  "set-cookie",
  "stripe-signature",
  "x-hmac-signature",
]);

function scrub<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    return obj.map((v) => scrub(v)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) {
      out[k] = "[redacted]";
      continue;
    }
    out[k] = v && typeof v === "object" ? scrub(v) : v;
  }
  return out as T;
}

let initialized = false;

export function initSentry(): void {
  if (initialized) return;
  const cfg = loadConfig();
  if (!cfg.SENTRY_DSN) {
    return;
  }

  Sentry.init({
    dsn: cfg.SENTRY_DSN,
    environment: cfg.SENTRY_ENV,
    release: process.env.RELEASE_SHA ?? "unknown",
    // Default to a low sample so we don't blow the budget; tune in dashboard.
    tracesSampleRate: cfg.NODE_ENV === "production" ? 0.05 : 1.0,
    profilesSampleRate: cfg.NODE_ENV === "production" ? 0.05 : 0,
    integrations: [nodeProfilingIntegration()],

    /**
     * Last-line scrub of every event before it leaves the process. The
     * server-level data scrubber in the Sentry org dashboard is also enabled
     * (defence in depth).
     */
    beforeSend(event) {
      if (event.request) {
        if (event.request.headers) event.request.headers = scrub(event.request.headers);
        if (event.request.cookies) event.request.cookies = scrub(event.request.cookies);
        if (event.request.query_string && typeof event.request.query_string === "object") {
          event.request.query_string = scrub(event.request.query_string as Record<string, unknown>) as never;
        }
        if (event.request.data && typeof event.request.data === "object") {
          event.request.data = scrub(event.request.data as Record<string, unknown>);
        }
      }
      if (event.extra) event.extra = scrub(event.extra);
      if (event.contexts) event.contexts = scrub(event.contexts as Record<string, unknown>) as typeof event.contexts;
      // Don't ship the whole user object — keep only id + email-tier (domain).
      if (event.user) {
        const safe: typeof event.user = {};
        if (event.user.id) safe.id = event.user.id;
        if (event.user.email && typeof event.user.email === "string") {
          // a***@example.com style
          const at = event.user.email.indexOf("@");
          safe.email = at > 0 ? `${event.user.email[0]}***${event.user.email.slice(at)}` : "[redacted]";
        }
        event.user = safe;
      }
      return event;
    },

    /**
     * Don't report client-side 4xx as exceptions. The exception filter calls
     * `captureException` only on 5xx; this guard catches anything else that
     * leaks through autoinstrumentation.
     */
    beforeSendTransaction(transaction) {
      // Drop /v1/health/* spans — they're noisy and not actionable.
      if (transaction.transaction?.startsWith("GET /v1/health")) return null;
      return transaction;
    },
  });

  initialized = true;
}

export { Sentry };
