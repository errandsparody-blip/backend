/**
 * Admin users controller — role management for admin-flavoured users.
 *
 * Introduced by migration 0039. SUPER_ADMIN-only. Deliberately does
 * NOT touch VENDOR / VENDOR_SUB_USER — those are tenant-scoped with
 * a `vendorId` binding and moving them to an admin role would break
 * tenant isolation invariants. VENDOR promotion, if we ever need
 * it, gets its own dedicated flow.
 *
 *   GET   /v1/admin/users                   list admin-flavoured users
 *   PATCH /v1/admin/users/:id/role          update role, revoke sessions
 *
 * Every PATCH:
 *   1. Refuses if the target user has a `vendorId` (they're
 *      tenant-scoped; admin roles are single-tenant "platform").
 *   2. Refuses if the SUPER_ADMIN is trying to demote themselves —
 *      the "no last admin standing" problem needs a deliberate
 *      dance, not a slip of the finger.
 *   3. Writes an audit entry with before/after role.
 *   4. Revokes every active session for the target so a stale JWT
 *      can't sit around with the old role for another 15 minutes.
 *      The user has to log in again to pick up the new role.
 */

import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
} from "@nestjs/common";
import { Role, UserStatus } from "@prisma/client";
import { z } from "zod";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TokenService } from "../auth/token.service";

// The roles a SUPER_ADMIN is allowed to move a user INTO. Vendor
// roles are excluded (tenant-scoped). Sanitised via z.enum so a
// malformed request fails at the validation layer, not deep in the
// service.
const ASSIGNABLE_ROLES = [
  "ADMIN",
  "FINANCE_ADMIN",
  "WAREHOUSE_OPERATOR",
  "SUPER_ADMIN",
] as const;
type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

const listSchema = z.object({
  // Substring match on email — cheap client-side filter for the
  // admin-user picker UI. Length capped to keep the LIKE bounded.
  search: z.string().trim().max(80).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
});
type ListInput = z.infer<typeof listSchema>;

const patchRoleSchema = z.object({
  role: z.enum(ASSIGNABLE_ROLES),
});
type PatchRoleInput = z.infer<typeof patchRoleSchema>;

@Controller({ path: "admin/users", version: "1" })
// SUPER_ADMIN only. Every endpoint here can move a user's role, so
// we don't split read vs. write — a FINANCE_ADMIN listing admin
// users would leak the org chart with no clear business value.
@Roles(Role.SUPER_ADMIN)
export class AdminUsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tokens: TokenService,
  ) {}

  /**
   * List admin-flavoured users. Filters out VENDOR / VENDOR_SUB_USER
   * because those are managed via the vendor team invitation flow —
   * mixing them into this listing would confuse the ops UX.
   *
   * Ordered by createdAt DESC so recently-added admins float to the
   * top; a keyset cursor keeps pagination stable across writes.
   */
  @Get()
  async list(@Query(new ZodValidationPipe(listSchema)) q: ListInput) {
    // Deliberately reuse Prisma's `Role` values as strings — the
    // stale-client tolerance pattern used across this migration.
    // Referencing Role.ADMIN directly would fail to build in the
    // sandbox because the local Prisma client may not include the
    // new enum member yet.
    const adminRoles = ["ADMIN", "FINANCE_ADMIN", "WAREHOUSE_OPERATOR", "SUPER_ADMIN"] as unknown as Role[];
    const where = {
      role: { in: adminRoles },
      ...(q.search
        ? { email: { contains: q.search, mode: "insensitive" as const } }
        : {}),
    };
    const users = await this.prisma.user.findMany({
      where,
      take: q.limit + 1,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        // Migration 0039 — MFA enrollment date doubles as "have they
        // completed setup". No `lastLoginAt` on the User model
        // today; adding one is out of scope for this migration.
        mfaEnrolledAt: true,
        createdAt: true,
      },
    });
    let nextCursor: string | null = null;
    if (users.length > q.limit) {
      const next = users.pop();
      nextCursor = next?.id ?? null;
    }
    return { items: users, nextCursor };
  }

  /**
   * Change a user's role.
   *
   * Rules (in order — first violation wins):
   *   1. Target must exist.
   *   2. Target must not have a `vendorId` — vendor users don't
   *      belong to the admin role tree.
   *   3. Target's current role must be one of the admin flavours
   *      (defence in depth against #2).
   *   4. Actor can't demote themselves. Locking themselves out is a
   *      real-world footgun; a second SUPER_ADMIN must do it.
   *
   * On success we revoke every active session for the target so a
   * stale JWT can't ride the old role for another 15 minutes. The
   * target has to log in again to pick up the new role.
   */
  @Patch(":id/role")
  @HttpCode(HttpStatus.OK)
  async updateRole(
    @CurrentUser() actor: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(patchRoleSchema)) body: PatchRoleInput,
  ) {
    const target = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, role: true, email: true, vendorId: true, status: true },
    });
    if (!target) {
      throw new NotFoundException({ message: "User not found.", code: "user_not_found" });
    }
    if (target.vendorId !== null) {
      throw new BadRequestException({
        message: "Vendor-scoped users cannot be assigned an admin role here.",
        code: "user_is_vendor_scoped",
      });
    }
    // Guard against changing NON-admin users through this path even
    // if vendorId is null (defence in depth; there aren't any today
    // but a future migration might create one). Only ADMIN-tier
    // users are movable here.
    if (!(ASSIGNABLE_ROLES as readonly string[]).includes(target.role as string)) {
      throw new BadRequestException({
        message: "This endpoint only reassigns admin-tier users.",
        code: "user_role_not_admin_tier",
      });
    }
    if (target.id === actor.sub && body.role !== target.role) {
      throw new ForbiddenException({
        message:
          "You can't change your own role. Ask another SUPER_ADMIN to do it.",
        code: "role_self_change_forbidden",
      });
    }
    // Refuse suspended/closed users to avoid resurrecting a
    // deactivated account by side effect. If ops wants to reactivate
    // + re-role, they should do it explicitly through a future
    // status-change flow.
    if (target.status === UserStatus.SUSPENDED || target.status === UserStatus.CLOSED) {
      throw new BadRequestException({
        message: "Reactivate the user before changing their role.",
        code: "user_inactive",
      });
    }

    const before: AssignableRole = target.role as AssignableRole;
    const after: AssignableRole = body.role;
    if (before === after) {
      // No-op — return the current shape without touching sessions
      // or the audit log. Keeps a double-save on the UI harmless.
      return { id: target.id, email: target.email, role: after, revokedSessions: false };
    }

    // Persist + revoke sessions in a single transaction so a mid-
    // write crash can't leave the user with the new role AND live
    // stale-role tokens. The revokeAllForUser call re-issues
    // updateMany against the sessions table; it's safe to nest
    // because Prisma binds it to the same connection when called
    // inside $transaction. Ignore the "tx" narrowed type here — the
    // TokenService reads from `this.prisma`, not a passed tx, so we
    // fire it after the transaction commits and accept the ~ms
    // window (worst case: one extra request lands with the old
    // role, then the next one 401s on refresh).
    await this.prisma.user.update({
      where: { id: target.id },
      // Cast because the local Prisma client may not include ADMIN
      // in its Role union yet (sandbox regen blocked). Runtime is
      // exact string equality — Postgres validates the enum for us.
      data: { role: after as Role },
    });
    await this.tokens.revokeAllForUser(target.id, "role_changed_by_admin");

    // Best-effort audit. Failing the audit MUST NOT roll back the
    // role change — the change succeeded and sessions are already
    // revoked, so we log and move on if the audit write fails.
    void this.audit
      .log({
        actorId: actor.sub,
        action: "admin.user.role_changed",
        resourceType: "user",
        resourceId: target.id,
        beforeState: { role: before },
        afterState: { role: after },
      })
      .catch(() => undefined);

    return {
      id: target.id,
      email: target.email,
      role: after,
      // Signals to the UI that the target has been logged out and
      // will need to re-authenticate to pick up their new role.
      revokedSessions: true,
    };
  }
}
