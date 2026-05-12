/**
 * OpsAlertService — fans an ops event out to two surfaces:
 *
 *   1. Email to every address in OPS_ALERT_EMAILS (existing behaviour).
 *   2. In-app notification rows for every active admin user
 *      (WAREHOUSE_OPERATOR / FINANCE_ADMIN / SUPER_ADMIN) so the bell,
 *      sidebar badges, and /admin/notifications page light up the same
 *      way the vendor portal does for vendor-scoped events.
 *
 * Both surfaces are best-effort: a failure on either side is logged
 * but never thrown back to the caller. Losing an ops alert must not
 * break the underlying business operation (PSN submit, shopper intake,
 * etc.).
 *
 * If OPS_ALERT_EMAILS is empty (default in dev), the email leg is a
 * no-op but the in-app leg STILL fires — admin notifications are the
 * authoritative surface, so devs running locally see them in the UI
 * even without an alert mailing list configured.
 */

import { Injectable, Logger } from "@nestjs/common";
import type { NotificationSeverity, Prisma } from "@prisma/client";

import { loadConfig } from "../../common/config";
import { PrismaService } from "../../common/prisma.service";

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
  /**
   * Optional deep-link href for the in-app notification row. When set,
   * clicking the row in the bell dropdown / notifications page takes
   * the operator straight to the relevant admin screen.
   */
  href?: string;
  /**
   * Optional severity for the in-app row. Defaults to INFO. Use WARNING
   * for things that need attention but aren't critical (e.g. proof
   * uploaded, awaiting review); ERROR is rare here.
   */
  severity?: NotificationSeverity;
}

@Injectable()
export class OpsAlertService {
  private readonly log = new Logger(OpsAlertService.name);
  private readonly recipients: string[];

  constructor(
    private readonly email: EmailService,
    private readonly prisma: PrismaService,
  ) {
    this.recipients = loadConfig().OPS_ALERT_EMAILS;
  }

  async send(args: OpsAlertArgs): Promise<void> {
    // Run both surfaces in parallel so a slow email send can't delay
    // the in-app row landing in the admin UI. Each leg catches its own
    // failures — we never let one knock out the other.
    await Promise.all([
      this.sendEmail(args).catch((err) =>
        this.log.warn({ err, type: args.type }, "Ops alert email leg failed"),
      ),
      this.sendInApp(args).catch((err) =>
        this.log.warn({ err, type: args.type }, "Ops alert in-app leg failed"),
      ),
    ]);
  }

  private async sendEmail(args: OpsAlertArgs): Promise<void> {
    if (this.recipients.length === 0) {
      this.log.debug({ type: args.type }, "OPS_ALERT_EMAILS unset — skipping ops alert email");
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

  /**
   * Create one in-app Notification row per active admin user. Vendor
   * notifications are emitted with `vendorId` and scoped to the vendor
   * org; admin notifications are emitted with `userId` so they hit each
   * operator's personal feed. The two scopes are disjoint at the data
   * layer — no risk of crossing wires.
   *
   * Type normalisation: callers tag ops alerts with `ops.<category>.*`
   * (e.g. `ops.psn.new`). The frontend bucketises notifications by the
   * leading segment of `type` for sidebar badges, so we strip the
   * leading `ops.` here. After strip: `ops.psn.new` → `psn.new` →
   * category bucket `psn`. Items without an `ops.` prefix pass through
   * unchanged so existing call sites that already use the bare type
   * still bucket correctly.
   *
   * Body truncated to 240 chars (the notification card's safe display
   * length). Subject becomes the title verbatim — it's already
   * single-line by convention.
   */
  private async sendInApp(args: OpsAlertArgs): Promise<void> {
    const admins = await this.prisma.user.findMany({
      where: {
        role: { in: ["WAREHOUSE_OPERATOR", "FINANCE_ADMIN", "SUPER_ADMIN"] },
        status: "ACTIVE",
      },
      select: { id: true },
    });
    if (admins.length === 0) {
      this.log.debug(
        { type: args.type },
        "No active admin users found — skipping in-app ops fanout",
      );
      return;
    }

    // Strip the leading "ops." segment so the category bucket reads as
    // the underlying domain (psn / shopper / kyc / order / ...).
    const type = args.type.replace(/^ops\./, "");

    // Plain-text body for the notification row. Email templates send
    // multi-paragraph text; the notification card is a single tight
    // line, so we truncate and collapse whitespace.
    const body = args.text
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);

    const rows: Prisma.NotificationCreateManyInput[] = admins.map((a) => ({
      userId: a.id,
      vendorId: null,
      type,
      severity: args.severity ?? "INFO",
      title: args.subject,
      body,
      href: args.href ?? null,
    }));

    // `createMany` is one round-trip even for dozens of admins. Failures
    // bubble up to the catch in send() — a partial insert here would be
    // unusual; Prisma is all-or-nothing inside createMany unless we
    // pass skipDuplicates (we don't need it — there's no unique index).
    await this.prisma.notification.createMany({ data: rows });
  }

  private redact(email: string): string {
    const [local, domain] = email.split("@");
    if (!domain) return "[redacted]";
    const safeLocal = local && local.length > 0 ? `${local[0]}***` : "***";
    return `${safeLocal}@${domain}`;
  }
}
