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
  // Vendor-scoped reads (back-compat — kept so existing callers don't break)
  // ---------------------------------------------------------------------------

  async listForVendor(
    vendorId: string,
    input: { unreadOnly?: boolean; limit: number; cursor?: string },
  ): Promise<{ items: PublicNotification[]; nextCursor: string | null; unreadCount: number }> {
    return this.listForRecipient({ vendorId }, input);
  }

  // ---------------------------------------------------------------------------
  // Recipient-scoped reads — vendor OR admin user
  // ---------------------------------------------------------------------------

  /**
   * List notifications for a recipient (either a vendor's whole org or a
   * single admin user). Pass exactly one of `vendorId` / `userId`. The two
   * scopes are disjoint by construction (vendor rows have vendorId set;
   * admin rows have userId set) so we never need to OR them.
   */
  async listForRecipient(
    scope: { vendorId?: string; userId?: string },
    input: { unreadOnly?: boolean; limit: number; cursor?: string },
  ): Promise<{ items: PublicNotification[]; nextCursor: string | null; unreadCount: number }> {
    const where = this.scopeFilter(scope);
    const whereWithRead: Prisma.NotificationWhereInput = input.unreadOnly
      ? { ...where, readAt: null }
      : where;

    const [items, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where: whereWithRead,
        take: input.limit + 1,
        orderBy: { createdAt: "desc" },
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      }),
      this.prisma.notification.count({ where: { ...where, readAt: null } }),
    ]);

    let nextCursor: string | null = null;
    if (items.length > input.limit) {
      const next = items.pop();
      nextCursor = next?.id ?? null;
    }
    return { items: items.map((n) => this.toPublic(n)), nextCursor, unreadCount };
  }

  /**
   * Unread notification counts bucketed by the leading segment of the
   * notification `type`. e.g. type "psn.submitted" → bucket "psn". The
   * frontend uses this to render per-tab badges on the sidebar.
   *
   * Returns `{ total, byCategory: { psn: 3, order: 2, ... } }`. Categories
   * with zero unread are omitted to keep the payload small.
   */
  async unreadCountsForRecipient(
    scope: { vendorId?: string; userId?: string },
  ): Promise<{ total: number; byCategory: Record<string, number> }> {
    const where = { ...this.scopeFilter(scope), readAt: null };
    const rows = await this.prisma.notification.groupBy({
      by: ["type"],
      where,
      _count: { _all: true },
    });
    let total = 0;
    const byCategory: Record<string, number> = {};
    for (const r of rows) {
      const n = r._count._all;
      total += n;
      const bucket = this.categoryFromType(r.type);
      byCategory[bucket] = (byCategory[bucket] ?? 0) + n;
    }
    return { total, byCategory };
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  /** Vendor-scoped mark-read. Back-compat wrapper. */
  async markRead(vendorId: string, id: string): Promise<void> {
    return this.markReadForRecipient({ vendorId }, id);
  }

  /** Vendor-scoped mark-all-read. Back-compat wrapper. */
  async markAllRead(vendorId: string): Promise<{ updated: number }> {
    return this.markAllReadForRecipient({ vendorId });
  }

  async markReadForRecipient(
    scope: { vendorId?: string; userId?: string },
    id: string,
  ): Promise<void> {
    const where = this.scopeFilter(scope);
    const notif = await this.prisma.notification.findFirst({ where: { ...where, id } });
    if (!notif) throw new NotFoundException();
    if (notif.readAt) return;
    await this.prisma.notification.update({ where: { id }, data: { readAt: new Date() } });
  }

  async markAllReadForRecipient(
    scope: { vendorId?: string; userId?: string },
  ): Promise<{ updated: number }> {
    const where = this.scopeFilter(scope);
    const r = await this.prisma.notification.updateMany({
      where: { ...where, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: r.count };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Build the Prisma `where` clause for a recipient. Exactly one of
   * `vendorId` / `userId` must be set — we throw otherwise so a buggy
   * caller can't accidentally fall back to a global query that would
   * leak data across tenants.
   */
  private scopeFilter(scope: {
    vendorId?: string;
    userId?: string;
  }): Prisma.NotificationWhereInput {
    if (scope.vendorId && scope.userId) {
      throw new Error("notification scope must be vendorId XOR userId");
    }
    if (scope.vendorId) return { vendorId: scope.vendorId };
    if (scope.userId) return { userId: scope.userId };
    throw new Error("notification scope requires vendorId or userId");
  }

  /**
   * Map `type` to a sidebar category. `psn.submitted` → `psn`,
   * `shopper.new_message` → `shopper`, etc. Unknown types fall into the
   * `other` bucket so the total still reconciles.
   */
  private categoryFromType(type: string): string {
    const first = type.split(".")[0]?.trim().toLowerCase();
    if (!first) return "other";
    // Whitelist of known category prefixes — keeps the map stable for the
    // frontend. Anything outside this list lands in `other` and shows up
    // only in the global bell, not on any specific sidebar item.
    const known = new Set([
      "psn",
      "order",
      "return",
      "wallet",
      "shopper",
      "kyc",
      "verification",
      "vendor",
    ]);
    return known.has(first) ? first : "other";
  }

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
