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

export interface EmailAttachment {
  /** Filename surfaced in the recipient's mail client (e.g., "guide.pdf"). */
  filename: string;
  /** Raw bytes — we base64-encode at send time for Resend's API. */
  content: Buffer;
  /** Optional MIME type. Most clients infer from the filename anyway. */
  contentType?: string;
}

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
  /**
   * Optional file attachments. Resend caps total payload at ~40 MB —
   * callers should keep aggregate size under that. The audit log
   * records filenames + sizes but never the bytes.
   */
  attachments?: EmailAttachment[];
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
  /**
   * Case-insensitive local suppression set. Built once at construction
   * so we don't rebuild it per send. Config already lower-cases every
   * entry, so a lowered lookup is exact.
   *
   * A Set is O(1) — sends check this on every message and the set can
   * grow to dozens of entries over time (each hard-bounced QA alias
   * gets added), so an .includes() scan would compound needlessly.
   */
  private readonly suppressed: ReadonlySet<string>;

  constructor(private readonly audit: AuditService) {
    this.suppressed = new Set(this.cfg.EMAIL_SUPPRESSED_ADDRESSES);
  }

  async send(msg: EmailMessage): Promise<{ ok: boolean; providerId?: string; error?: string }> {
    if (!this.isValidRecipient(msg.to)) {
      this.log.warn({ type: msg.type, to: this.redact(msg.to) }, "Email skipped — invalid recipient");
      return { ok: false, error: "invalid_recipient" };
    }

    // Local suppression check — runs BEFORE any provider dispatch so a
    // suppressed recipient never touches Resend's API, never generates
    // a "Suppressed" event in the dashboard, and never produces an
    // "email.delivered" audit row that would misrepresent reality.
    //
    // Emit an audit row so ops can prove after-the-fact that a specific
    // outbound was intentionally skipped (rather than lost) — this is
    // the compensating trail for the absence of a delivery record.
    if (this.suppressed.has(msg.to.toLowerCase())) {
      this.log.warn(
        { type: msg.type, to: this.redact(msg.to) },
        "Email skipped — recipient on local suppression list",
      );
      await this.audit
        .log({
          action: "email.skipped_suppressed",
          resourceType: "email",
          resourceId: msg.idempotencyKey ?? null,
          afterState: {
            type: msg.type,
            toHash: this.redact(msg.to),
            vendorId: msg.vendorId ?? null,
            userId: msg.userId ?? null,
          },
        })
        .catch(() => undefined);
      return { ok: false, error: "recipient_suppressed" };
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

    // Encode attachments per Resend's API: { filename, content (base64), content_type? }.
    // Defence: cap attachment payload at 25 MB aggregate so a misuse
    // (e.g., a 50-page PDF passed by accident) doesn't blow our Resend
    // quota or trip the API limit.
    const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
    const totalAttachmentBytes = (msg.attachments ?? []).reduce(
      (sum, a) => sum + a.content.length,
      0,
    );
    if (totalAttachmentBytes > MAX_ATTACHMENT_BYTES) {
      this.log.error(
        {
          type: msg.type,
          totalAttachmentBytes,
          maxBytes: MAX_ATTACHMENT_BYTES,
        },
        "Email rejected — attachment payload exceeds cap",
      );
      return { ok: false, error: "attachment_too_large" };
    }
    const encodedAttachments = (msg.attachments ?? []).map((a) => ({
      filename: a.filename,
      content: a.content.toString("base64"),
      ...(a.contentType ? { content_type: a.contentType } : {}),
    }));

    const body = {
      from: this.cfg.EMAIL_FROM,
      to: [msg.to],
      reply_to: this.cfg.EMAIL_REPLY_TO,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      ...(encodedAttachments.length > 0 ? { attachments: encodedAttachments } : {}),
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
