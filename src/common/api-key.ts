/**
 * Storefront-integration API key format (Migration 0038).
 *
 * A key the vendor's website sends to authenticate to the integration endpoint.
 * Presented to the vendor exactly once at creation; only the public `keyId` and
 * a SHA-256 hash of the `secret` are persisted (see VendorApiKey).
 *
 * Wire format:
 *   uer_live_<keyId>.<secret>
 *     keyId  — 16 hex chars (public lookup token; safe to display)
 *     secret — 64 hex chars (the half we hash; never stored in plaintext)
 *
 * Both halves are lowercase hex so the single `.` delimiter is unambiguous
 * (hex never contains a dot). The pieces here are intentionally pure — no I/O,
 * no crypto state — so they're trivial to unit-test; generation + hashing live
 * in VendorApiKeyService where CryptoService is available.
 */

export const API_KEY_LIVE_PREFIX = "uer_live_";
export const API_KEY_DELIMITER = ".";

export interface ParsedApiKey {
  /** Public lookup token — matches VendorApiKey.keyId. */
  keyId: string;
  /** Secret half — caller hashes this and compares to VendorApiKey.secretHash. */
  secret: string;
}

/** Assemble the full key string shown to the vendor once at creation. */
export function formatApiKey(keyId: string, secret: string): string {
  return `${API_KEY_LIVE_PREFIX}${keyId}${API_KEY_DELIMITER}${secret}`;
}

/** The public, displayable portion of a key (everything but the secret). */
export function apiKeyDisplayPrefix(keyId: string): string {
  return `${API_KEY_LIVE_PREFIX}${keyId}`;
}

/**
 * Parse a raw key string back into its parts. Returns null for anything that
 * isn't a well-formed live key — the caller treats null as an auth failure
 * without leaking which check failed.
 */
export function parseApiKey(raw: string | undefined | null): ParsedApiKey | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith(API_KEY_LIVE_PREFIX)) return null;

  const body = trimmed.slice(API_KEY_LIVE_PREFIX.length);
  const dot = body.indexOf(API_KEY_DELIMITER);
  if (dot <= 0) return null; // missing delimiter or empty keyId

  const keyId = body.slice(0, dot);
  const secret = body.slice(dot + 1);
  if (!keyId || !secret) return null;
  if (!/^[0-9a-f]+$/.test(keyId) || !/^[0-9a-f]+$/.test(secret)) return null;

  return { keyId, secret };
}
