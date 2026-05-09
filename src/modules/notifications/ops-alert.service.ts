/**
 * OpsAlertService — sends an email to every address in OPS_ALERT_EMAILS.
 *
 * Used for internal team alerts that aren't tied to a specific vendor (new
 * KYC submissions, new shopper requests, buyer chat messages awaiting
 * reply). Best-effort: a delivery failure is logged but never throws back
 * to the caller — the in-app surface (admin queue/dashboard) is the
 * authoritative view.
 *
 * If OPS_ALERT_EMAILS is empty (default in dev), this is a no-op.
 */

import { Injectable, Logger } from "@nestjs/common";

import { loadConfig } from "../../common/config";

import { EmailService } from "../email/email.service";

export interface OpsAlertArgs {
  /** Stable code for the audit log: "ops.psn.new", "ops.shopper.request", … */
  type: string;
  subject: string;
  html: string;
  text: string;
  /**
   * Stable per-event idempotency key. Using a per-event id (e.g. the PSN id
   * or shopper request id) means a duplicate trigger will get deduped by
   * Resend rather than spamming the team.
   */
  idempotencyKey: string;
}

@Injectable()
export class OpsAlertService {
  private readonly log = new Logger(OpsAlertService.name);
  private readonly recipients: string[];

  constructor(private readonly email: EmailService) {
    this.recipients = loadConfig().OPS_ALERT_EMAILS;
  }

  async send(args: OpsAlertArgs): Promise<void> {
    if (this.recipients.length === 0) {
      this.log.debug({ type: args.type }, "OPS_ALERT_EMAILS unset — skipping ops alert");
      return;
    }
    // Fan out one email per address so each recipient sees themselves in
    // To: rather than as a CC. Idempotency key is suffixed with the
    // recipient so per-address dedupe still works.
    await Promise.all(
      this.recipients.map((to) =>
        this.email
          .send({
            to,
            subject: args.subject,
            html: args.html,
            text: args.text,
            type: args.type,
            idempotencyKey: `${args.idempotencyKey}:${to}`,
          })
          .catch((err) => {
            this.log.warn({ err, to: this.redact(to), type: args.type }, "Ops alert send failed");
          }),
      ),
    );
  }

  private redact(email: string): string {
    const [local, domain] = email.split("@");
    if (!domain) return "[redacted]";
    const safeLocal = local && local.length > 0 ? `${local[0]}***` : "***";
    return `${safeLocal}@${domain}`;
  }
}
