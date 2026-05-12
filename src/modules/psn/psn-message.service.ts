/**
 * PsnMessageService — per-PSN chat thread orchestration.
 *
 * Mirrors the shape + responsibilities of ShopperMessageService:
 *   - listForPsn(psnId): paginated message history.
 *   - postFromVendor(psnId, vendorUserId, body, attachments).
 *   - postFromAdmin(psnId, adminUserId, body, attachments).
 *   - markReadByVendor(psnId) / markReadByAdmin(psnId): bulk-acks so
 *     the per-side unread badges drop to zero on entry.
 *
 * Tenant scoping happens at the controller layer (vendor controllers
 * only ever pass a PSN they own; admin controllers see any PSN). This
 * service trusts the psnId it's handed.
 *
 * Side effects:
 *   - Vendor posts a message → email the OPS alert list + create
 *     in-app rows for every active admin user (via OpsAlertService —
 *     same fan-out as PSN-submitted, KYC-submitted, etc.).
 *   - Admin posts a message → email the vendor's users + create in-app
 *     notifications scoped to the vendor org.
 *
 * Both side effects are best-effort: a missing email / notification
 * insert never breaks the message post itself. The chat row is the
 * source of truth; emails are reminders.
 */

import { Injectable, Logger } from "@nestjs/common";

import { loadConfig } from "../../common/config";
import { PrismaService } from "../../common/prisma.service";

import { EmailService } from "../email/email.service";
import { NotificationService } from "../notifications/notification.service";
import { OpsAlertService } from "../notifications/ops-alert.service";

export type PsnMessageSenderKind = "VENDOR" | "ADMIN";

export interface PublicPsnMessage {
  id: string;
  sender: PsnMessageSenderKind;
  body: string;
  attachmentUrls: string[];
  createdAt: Date;
  readByVendorAt: Date | null;
  readByAdminAt: Date | null;
}

// Stale Prisma client cast — same pattern as ShopperRequest service uses
// while Railway runs `prisma generate` post-deploy.
interface AnyPsnMessageClient {
  create: (args: unknown) => Promise<PublicPsnMessage>;
  findMany: (args: unknown) => Promise<PublicPsnMessage[]>;
  updateMany: (args: unknown) => Promise<{ count: number }>;
}

@Injectable()
export class PsnMessageService {
  private readonly logger = new Logger(PsnMessageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly notifications: NotificationService,
    private readonly opsAlerts: OpsAlertService,
  ) {}

  /**
   * List every message on a PSN. Caller is responsible for confirming the
   * requesting user can see this PSN.
   */
  async listForPsn(psnId: string): Promise<PublicPsnMessage[]> {
    return (
      this.prisma as unknown as { psnMessage: AnyPsnMessageClient }
    ).psnMessage.findMany({
      where: { psnId },
      orderBy: { createdAt: "asc" },
    });
  }

  // ---------------------------------------------------------------------------
  // Posts
  // ---------------------------------------------------------------------------

  async postFromVendor(args: {
    psnId: string;
    senderUserId: string;
    body: string;
    attachmentUrls?: string[];
  }): Promise<PublicPsnMessage> {
    const row = await (
      this.prisma as unknown as { psnMessage: AnyPsnMessageClient }
    ).psnMessage.create({
      data: {
        psnId: args.psnId,
        sender: "VENDOR",
        senderUserId: args.senderUserId,
        body: args.body,
        attachmentUrls: args.attachmentUrls ?? [],
        // The vendor implicitly reads their own message — set the timestamp
        // so re-rendering their own posts doesn't tick their own badge up.
        readByVendorAt: new Date(),
      },
    });

    // Notify admin team. OpsAlertService writes one in-app Notification per
    // active admin user + emails the alert list. Best-effort.
    const preview = args.body.length > 200 ? `${args.body.slice(0, 197)}…` : args.body;
    void this.opsAlerts
      .send({
        // `ops.psn.message` strips to `psn.message` after the service's
        // prefix-strip → buckets into the admin "Receiving" sidebar tab.
        type: "ops.psn.message",
        subject: `New PSN message — ${args.psnId.slice(0, 8)}`,
        html: `<p>Vendor posted on PSN <strong>${this.escapeHtml(args.psnId.slice(0, 8))}</strong>:</p><blockquote>${this.escapeHtml(preview)}</blockquote>`,
        text: `Vendor message on PSN ${args.psnId.slice(0, 8)}:\n\n${preview}`,
        idempotencyKey: `ops:psn:msg:${row.id}`,
        href: `/admin/psn/${args.psnId}/receive`,
        severity: "INFO",
      })
      .catch((err) =>
        this.logger.warn(
          { err, psnId: args.psnId, msgId: row.id },
          "psn.message.ops_alert_failed",
        ),
      );

    return row;
  }

  async postFromAdmin(args: {
    psnId: string;
    senderUserId: string;
    body: string;
    attachmentUrls?: string[];
  }): Promise<PublicPsnMessage> {
    const row = await (
      this.prisma as unknown as { psnMessage: AnyPsnMessageClient }
    ).psnMessage.create({
      data: {
        psnId: args.psnId,
        sender: "ADMIN",
        senderUserId: args.senderUserId,
        body: args.body,
        attachmentUrls: args.attachmentUrls ?? [],
        readByAdminAt: new Date(),
      },
    });

    // Resolve the PSN's vendor so we can fan an in-app notification + email
    // to every active vendor user on that org. Lookup is best-effort —
    // a failure to notify never invalidates the message itself.
    const psn = await this.prisma.psn
      .findUnique({
        where: { id: args.psnId },
        select: { vendorId: true, id: true },
      })
      .catch(() => null);
    if (!psn) return row;

    const preview = args.body.length > 240 ? `${args.body.slice(0, 237)}…` : args.body;
    const cfg = loadConfig();
    const psnUrl = `${cfg.WEB_PUBLIC_URL}/psn/${psn.id}`;
    void this.notifications
      .emit({
        vendorId: psn.vendorId,
        type: "psn.message",
        severity: "INFO",
        title: `New message on PSN ${psn.id.slice(0, 8)}`,
        body: preview,
        href: `/psn/${psn.id}`,
        email: {
          subject: `New message on your PSN ${psn.id.slice(0, 8)}`,
          html: `<p>USA Errands posted on your PSN:</p><blockquote>${this.escapeHtml(preview)}</blockquote><p><a href="${psnUrl}">Open the conversation →</a></p>`,
          text: `USA Errands posted on your PSN:\n\n${preview}\n\nOpen the conversation: ${psnUrl}`,
        },
      })
      .catch((err) =>
        this.logger.warn(
          { err, psnId: args.psnId, msgId: row.id },
          "psn.message.vendor_notify_failed",
        ),
      );

    return row;
  }

  // ---------------------------------------------------------------------------
  // Mark-read (per side)
  // ---------------------------------------------------------------------------

  async markReadByVendor(psnId: string): Promise<void> {
    await (
      this.prisma as unknown as { psnMessage: AnyPsnMessageClient }
    ).psnMessage.updateMany({
      where: { psnId, sender: "ADMIN", readByVendorAt: null },
      data: { readByVendorAt: new Date() },
    });
  }

  async markReadByAdmin(psnId: string): Promise<void> {
    await (
      this.prisma as unknown as { psnMessage: AnyPsnMessageClient }
    ).psnMessage.updateMany({
      where: { psnId, sender: "VENDOR", readByAdminAt: null },
      data: { readByAdminAt: new Date() },
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private escapeHtml(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
}
