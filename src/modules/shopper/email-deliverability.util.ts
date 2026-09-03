/**
 * Email deliverability check for buyer intake.
 *
 * Format validation lives in the Zod schema (STRICT_EMAIL_RE). That catches
 * typos in the *shape* of an address, but not a well-formed address at a
 * domain that cannot actually receive mail — e.g. `sean13@live.com.com.au`,
 * whose domain has no MX and no A record. Because the shopper flow EMAILS the
 * buyer their payment details, an undeliverable address means the details
 * silently go nowhere. So at intake we do a live DNS check.
 *
 * Policy:
 *   - Domain has MX records                     → deliverable (accept).
 *   - No MX but an A/AAAA record exists         → deliverable (RFC 5321 §5.1
 *                                                 implicit MX / fallback).
 *   - Domain definitively does not exist / has  → REJECT (this is the case
 *     no mail host (NXDOMAIN / ENOTFOUND /        we want to stop).
 *     ENODATA)
 *   - Any other/transient DNS error or timeout  → fail OPEN (accept + log).
 *     We never lock a legitimate buyer out over a resolver hiccup; the Stripe
 *     receipt / bounce handling is the backstop.
 */
import { BadRequestException, type Logger } from "@nestjs/common";
import { promises as dns } from "node:dns";

/** DNS calls are wrapped in this timeout so a slow resolver never hangs intake. */
const DNS_TIMEOUT_MS = 4000;

/** DNS error codes that mean the domain genuinely cannot receive mail. */
const UNDELIVERABLE_CODES = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN"]);

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error("dns_timeout")), ms);
  });
  // Clear the timer once the underlying promise settles so we never leave a
  // dangling handle (which keeps the event loop — and Jest — alive).
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function domainOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain.length > 0 ? domain : null;
}

/**
 * Throws BadRequestException("shopper_email_undeliverable") when the email's
 * domain definitively cannot receive mail. Resolves silently otherwise.
 */
export async function assertEmailDeliverable(
  email: string,
  logger?: Logger,
): Promise<void> {
  const domain = domainOf(email);
  if (!domain) {
    // Shape is the schema's job; if we somehow got here without a domain,
    // treat it as undeliverable rather than crashing.
    throw new BadRequestException({
      message: "Enter a valid email address we can send your details to.",
      code: "shopper_email_undeliverable",
    });
  }

  // 1) MX lookup — the authoritative "can this domain receive mail" signal.
  try {
    const mx = await withTimeout(dns.resolveMx(domain), DNS_TIMEOUT_MS);
    if (Array.isArray(mx) && mx.length > 0) return; // deliverable
    // Empty MX set → fall through to the A/AAAA fallback below.
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code && UNDELIVERABLE_CODES.has(code)) {
      // No MX AND the domain/record doesn't exist → still try A/AAAA before
      // rejecting, because some domains accept mail on an implicit MX.
    } else {
      // Transient/unknown error (timeout, SERVFAIL, etc.) — fail open.
      logger?.warn(
        { domain, err: `${err}` },
        "shopper.email_deliverability.mx_lookup_soft_failed",
      );
      return;
    }
  }

  // 2) Fallback: an A/AAAA record means the host can accept mail (implicit MX).
  try {
    const addrs = await withTimeout(dns.resolve(domain), DNS_TIMEOUT_MS);
    if (Array.isArray(addrs) && addrs.length > 0) return; // deliverable
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code && UNDELIVERABLE_CODES.has(code)) {
      throw new BadRequestException({
        message:
          "That email domain can't receive mail — double-check the address so we can send your payment details.",
        code: "shopper_email_undeliverable",
      });
    }
    // Transient/unknown — fail open.
    logger?.warn(
      { domain, err: `${err}` },
      "shopper.email_deliverability.a_lookup_soft_failed",
    );
    return;
  }

  // Reached only when both MX and A/AAAA returned empty sets (no throw) —
  // the domain resolves to nothing usable for mail.
  throw new BadRequestException({
    message:
      "That email domain can't receive mail — double-check the address so we can send your payment details.",
    code: "shopper_email_undeliverable",
  });
}
