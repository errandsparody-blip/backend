/**
 * NotificationService — emits in-app notifications. When `email` is present,
 * the equivalent message is also dispatched through EmailService — best-effort:
 * email failures never break the in-app emit. Implementation Plan §6.8, §6.9.
 */

import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Notification, NotificationSeverity, Prisma } from "@prisma/client";

import { PrismaService } from "../../common/prisma.service";
import { EmailService, type EmailMessage } from "../email/email.service";

export interface EmitArgs {
  vendorId?: string;
  userId?: string;
  type: string;
  severity?: NotificationSeverity;
  title: string;
  body: string;
  href?: string;
  /**
   * If present, queue an email to this address with the rendered subject/html/text.
   * The caller chooses the template by passing the rendered message; the service
   * here only fans the email out.
   */
  email?: { to?: string; subject: string; html: string; text: string };
}

export interface PublicNotification {
  id: string;
  type: string;
  severity: NotificationSeverity;
  title: string;
  body: string;
  href: string | null;
  readAt: Date | null;
  createdAt: Date;
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  /**
   * Emit a notification. Failures are logged but never thrown — losing a
   * notification must not break the calling business operation. If `email`
   * is provided, fan an email out as well; the email path is also
   * isolated — a delivery failure does not break the in-app row.
   */
  async emit(args: EmitArgs): Promise<void> {
    if (!args.vendorId && !args.userId) {
      this.logger.warn({ type: args.type }, "emit called with neither vendorId nor userId");
      return;
    }
    try {
      await this.prisma.notification.create({
        data: {
          vendorId: args.vendorId ?? null,
          userId: args.userId ?? null,
          type: args.type,
          severity: args.severity ?? "INFO",
          title: args.title,
          body: args.body,
          href: args.href ?? null,
        },
      });
    } catch (err) {
      this.logger.error({ err, args: { type: args.type } }, "Failed to emit notification");
    }

    if (args.email) {
      // Re-narrow `args` to satisfy fanoutEmail's signature — TS doesn't
      // carry the `args.email` truthy check across the function boundary.
      const withEmail = args as EmitArgs & { email: NonNullable<EmitArgs["email"]> };
      void this.fanoutEmail(withEmail).catch((err) =>
        this.logger.error({ err, type: args.type }, "Email fanout failed"),
      );
    }
  }

  // ---------------------------------------------------------------------------

  /** Resolve recipient(s) and send. Active vendor users only; never CLOSED/SUSPENDED. */
  private async fanoutEmail(args: EmitArgs & { email: NonNullable<EmitArgs["email"]> }): Promise<void> {
    let recipients: string[] = [];
    if (args.email.to) {
      recipients = [args.email.to];
    } else if (args.userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: args.userId },
        select: { email: true, status: true, emailVerified: true },
      });
      if (user && user.status === "ACTIVE" && user.emailVerified) recipients = [user.email];
    } else if (args.vendorId) {
      // Send to every ACTIVE, email-verified user on the vendor. Sub-users
      // typically opt-out of finance-y notifications via a future preference;
      // for v1 everyone receives the alert.
      const users = await this.prisma.user.findMany({
        where: { vendorId: args.vendorId, status: "ACTIVE", emailVerified: true },
        select: { email: true },
      });
      recipients = users.map((u) => u.email);
    }

    for (const to of recipients) {
      const message: EmailMessage = {
        to,
        subject: args.email.subject,
        html: args.email.html,
        text: args.email.text,
        type: args.type,
        ...(args.vendorId ? { vendorId: args.vendorId } : {}),
        ...(args.userId ? { userId: args.userId } : {}),
        idempotencyKey: `${args.type}:${args.vendorId ?? args.userId ?? "x"}:${Date.now()}`,
      };
      await this.email.send(message);
    }
  }

  // ---------------------------------------------------------------------------
  // Vendor-scoped reads
  // ---------------------------------------------------------------------------

  async listForVendor(
    vendorId: string,
    input: { unreadOnly?: boolean; limit: number; cursor?: string },
  ): Promise<{ items: PublicNotification[]; nextCursor: string | null; unreadCount: number }> {
    const where: Prisma.NotificationWhereInput = { vendorId };
    if (input.unreadOnly) where.readAt = null;

    const [items, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        take: input.limit + 1,
        orderBy: { createdAt: "desc" },
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      }),
      this.prisma.notification.count({ where: { vendorId, readAt: null } }),
    ]);

    let nextCursor: string | null = null;
    if (items.length > input.limit) {
      const next = items.pop();
      nextCursor = next?.id ?? null;
    }
    return { items: items.map((n) => this.toPublic(n)), nextCursor, unreadCount };
  }

  async markRead(vendorId: string, id: string): Promise<void> {
    const notif = await this.prisma.notification.findFirst({ where: { id, vendorId } });
    if (!notif) throw new NotFoundException();
    if (notif.readAt) return;
    await this.prisma.notification.update({ where: { id }, data: { readAt: new Date() } });
  }

  async markAllRead(vendorId: string): Promise<{ updated: number }> {
    const r = await this.prisma.notification.updateMany({
      where: { vendorId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: r.count };
  }

  // ---------------------------------------------------------------------------

  private toPublic(n: Notification): PublicNotification {
    return {
      id: n.id,
      type: n.type,
      severity: n.severity,
      title: n.title,
      body: n.body,
      href: n.href,
      readAt: n.readAt,
      createdAt: n.createdAt,
    };
  }
}
