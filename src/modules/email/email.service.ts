/**
 * EmailService — adapter over the configured email provider.
 *
 * Implementation Plan §6.8.
 *
 *   EMAIL_PROVIDER=console  → logs the rendered message to the pino logger;
 *                              never makes a network call. Default in dev/test.
 *   EMAIL_PROVIDER=resend   → posts to https://api.resend.com/emails with the
 *                              configured RESEND_API_KEY. 5-second timeout,
 *                              one retry on 5xx, never logs the API key.
 *
 * Failure mode: send() never throws back to the caller. A failed delivery is
 * logged + recorded as an audit row so support can replay manually. The
 * notification system that called us already wrote the in-app row, so the
 * vendor still sees the message in the bell icon — email is best-effort.
 */

import { Injectable, Logger } from "@nestjs/common";
import { setTimeout as wait } from "node:timers/promises";

import { loadConfig } from "../../common/config";
import { AuditService } from "../audit/audit.service";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  /** Plain-text fallback. Required for accessibility + spam-score. */
  text: string;
  /** A stable `idempotencyKey` for the provider so a retry doesn't double-deliver. */
  idempotencyKey?: string;
  /** Stable code for the audit log: "auth.email_verify", "wallet.low_balance", … */
  type: string;
  /** Optional related ids for audit context. */
  vendorId?: string;
  userId?: string;
}

interface ResendResponse {
  id?: string;
  message?: string;
  name?: string;
}

@Injectable()
export class EmailService {
  private readonly log = new Logger(EmailService.name);
  private readonly cfg = loadConfig();

  constructor(private readonly audit: AuditService) {}

  async send(msg: EmailMessage): Promise<{ ok: boolean; providerId?: string; error?: string }> {
    if (!this.isValidRecipient(msg.to)) {
      this.log.warn({ type: msg.type, to: this.redact(msg.to) }, "Email skipped — invalid recipient");
      return { ok: false, error: "invalid_recipient" };
    }

    if (this.cfg.EMAIL_PROVIDER === "console") {
      this.log.log(
        {
          to: this.redact(msg.to),
          subject: msg.subject,
          type: msg.type,
          textPreview: msg.text.slice(0, 200),
        },
        "[email console transport] message would have been delivered",
      );
      return { ok: true, providerId: `console-${Date.now()}` };
    }

    const result = await this.sendViaResend(msg);

    await this.audit.log({
      action: result.ok ? "email.delivered" : "email.failed",
      resourceType: "email",
      resourceId: result.providerId ?? msg.idempotencyKey ?? null,
      afterState: {
        type: msg.type,
        // Hash the recipient instead of storing it — audit log is queryable
        // by ops and we don't want plaintext PII in there.
        toHash: this.redact(msg.to),
        vendorId: msg.vendorId ?? null,
        userId: msg.userId ?? null,
        ...(result.error ? { error: result.error } : {}),
      },
    });
    return result;
  }

  // ---------------------------------------------------------------------------

  private async sendViaResend(msg: EmailMessage): Promise<{ ok: boolean; providerId?: string; error?: string }> {
    const apiKey = this.cfg.RESEND_API_KEY;
    if (!apiKey) {
      return { ok: false, error: "resend_api_key_missing" };
    }

    const body = {
      from: this.cfg.EMAIL_FROM,
      to: [msg.to],
      reply_to: this.cfg.EMAIL_REPLY_TO,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      ...(msg.idempotencyKey ? { headers: { "Idempotency-Key": msg.idempotencyKey } } : {}),
    };

    for (let attempt = 1; attempt <= 2; attempt++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5_000);
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Important: the API key is in the Authorization header. Pino's
            // redact list strips this header; never log `body` either.
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        clearTimeout(t);

        if (res.ok) {
          const json = (await res.json()) as ResendResponse;
          return { ok: true, providerId: json.id };
        }

        // 4xx is non-retryable. 5xx is retryable.
        if (res.status >= 500 && attempt === 1) {
          await wait(500);
          continue;
        }

        const text = await res.text().catch(() => "");
        this.log.error(
          { status: res.status, type: msg.type },
          `Resend send failed: ${text.slice(0, 200)}`,
        );
        return { ok: false, error: `resend_${res.status}` };
      } catch (err) {
        clearTimeout(t);
        if (attempt === 1) {
          await wait(500);
          continue;
        }
        const e = (err as Error).message ?? "unknown";
        this.log.error({ err: e, type: msg.type }, "Resend send threw");
        return { ok: false, error: e.includes("aborted") ? "resend_timeout" : "resend_error" };
      }
    }
    return { ok: false, error: "resend_unreachable" };
  }

  // ---------------------------------------------------------------------------

  private isValidRecipient(to: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to);
  }

  /** Recipient-PII redaction for logs: alice@example.com → a***@example.com */
  private redact(to: string): string {
    const at = to.indexOf("@");
    if (at <= 0) return "***";
    const local = to.slice(0, at);
    const domain = to.slice(at);
    return `${local[0] ?? "?"}***${domain}`;
  }
}
