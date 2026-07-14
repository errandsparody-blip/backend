/**
 * Admin audit log viewer.
 *
 * Implementation Plan §6.11.
 *
 *   GET /v1/admin/audit
 *
 * Read-only. SUPER_ADMIN and FINANCE_ADMIN may query. Cursor-paginated, with
 * filters: actor, vendor, action substring, resourceType, date range.
 *
 * The viewer ALSO emits an audit row for itself (`audit.viewed`). This is a
 * compliance requirement — we keep a record of who looked at what and when.
 */

import { Controller, Get, Query } from "@nestjs/common";
import { Role } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { RequiresPage } from "../../common/decorators/requires-page.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../audit/audit.service";

// Migration 0039 — ADMIN role reference.
const ROLE_ADMIN = "ADMIN" as Role;

const listSchema = z.object({
  actorId: z.string().uuid().optional(),
  vendorId: z.string().uuid().optional(),
  // Free-text contains-match on action. e.g. "wallet" matches every wallet.* action.
  action: z.string().trim().min(1).max(80).optional(),
  resourceType: z
    .enum([
      "user",
      "vendor",
      "wallet",
      "ledger",
      "psn",
      "product",
      "sku",
      "order",
      "return",
      "session",
      "configuration",
      "system",
      "email",
      "kyc",
    ])
    .optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});
type ListInput = z.infer<typeof listSchema>;

@Controller({ path: "admin/audit", version: "1" })
// Migration 0039 — ADMIN opt-in via admin.audit.read. Off by default;
// SUPER_ADMIN toggles it on for admins who need to review changes.
@Roles(Role.SUPER_ADMIN, Role.FINANCE_ADMIN, ROLE_ADMIN)
@RequiresPage("admin.audit.read")
export class AdminAuditController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(listSchema)) q: ListInput,
  ) {
    const where: Prisma.AuditLogEntryWhereInput = {};
    if (q.actorId) where.actorId = q.actorId;
    if (q.vendorId) where.onBehalfOfVendorId = q.vendorId;
    if (q.action) where.action = { contains: q.action, mode: "insensitive" };
    if (q.resourceType) where.resourceType = q.resourceType;
    if (q.from || q.to) {
      where.createdAt = {
        ...(q.from ? { gte: q.from } : {}),
        ...(q.to ? { lte: q.to } : {}),
      };
    }

    const items = await this.prisma.auditLogEntry.findMany({
      where,
      include: { actor: { select: { id: true, email: true, role: true } } },
      take: q.limit + 1,
      orderBy: { createdAt: "desc" },
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });

    let nextCursor: string | null = null;
    if (items.length > q.limit) {
      const next = items.pop();
      nextCursor = next?.id ?? null;
    }

    // Self-audit. Compliance trail of who looked at what.
    await this.audit.log({
      actorId: user.sub,
      actorRole: user.role,
      action: "audit.viewed",
      resourceType: "audit_log",
      afterState: {
        filters: {
          actorId: q.actorId ?? null,
          vendorId: q.vendorId ?? null,
          action: q.action ?? null,
          resourceType: q.resourceType ?? null,
          from: q.from?.toISOString() ?? null,
          to: q.to?.toISOString() ?? null,
        },
        rowsReturned: items.length,
      },
    });

    return {
      items: items.map((e) => ({
        id: e.id,
        createdAt: e.createdAt,
        actor: e.actor
          ? { id: e.actor.id, email: e.actor.email, role: e.actor.role }
          : null,
        actorRole: e.actorRole,
        onBehalfOfVendorId: e.onBehalfOfVendorId,
        action: e.action,
        resourceType: e.resourceType,
        resourceId: e.resourceId,
        sourceIp: e.sourceIp,
        correlationId: e.correlationId,
        beforeState: e.beforeState,
        afterState: e.afterState,
      })),
      nextCursor,
    };
  }
}
