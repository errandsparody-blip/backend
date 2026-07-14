/**
 * Admin role permissions — dedicated endpoints for the ADMIN
 * page-permission matrix. Introduced by migration 0039.
 *
 *   GET   /v1/admin/role-permissions           read the ADMIN overrides map
 *   PATCH /v1/admin/role-permissions           replace the ADMIN overrides map
 *
 * SUPER_ADMIN only. Separate from the generic AdminConfigController
 * because:
 *   1. Write path filters unknown keys through PagePermissionService,
 *      so a hand-crafted request can't smuggle a bogus permission
 *      into the JSON blob.
 *   2. The response shape is UI-optimised (full permission map, not
 *      raw JSON) so the toggle matrix on /admin/config/admin-permissions
 *      can render without any JSON-parsing knowledge.
 *   3. Every PATCH writes a scoped audit-log entry
 *      (`admin.role_permissions.updated`) so "who changed the ADMIN
 *      role's access" is greppable in the audit view without wading
 *      through generic `config.update` rows.
 *
 * Read-side of the config is ALSO exposed under
 * `/v1/auth/me/page-permissions` — but scoped to the *current* user.
 * That endpoint is for the sidebar; this endpoint is for the admin
 * matrix editor.
 */

import { Body, Controller, Get, HttpCode, HttpStatus, Patch } from "@nestjs/common";
import { Role } from "@prisma/client";
import { z } from "zod";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  ADMIN_DEFAULT_PERMISSIONS,
  ADMIN_ROLE_PERMISSIONS_CONFIG_KEY,
  PAGE_KEYS,
  type PageKey,
} from "../../common/schemas/page-permissions";
import { PagePermissionService } from "../../common/services/page-permission.service";
import { AuditService } from "../audit/audit.service";

// Deliberately loose Zod shape: `Record<string, boolean>`. The service
// filters unknown keys at write time; keeping the schema loose keeps
// the client honest ("send whatever, only canonical keys stick") and
// avoids a Zod regen every time we add a page key to the registry.
const patchSchema = z.object({
  permissions: z.record(z.string(), z.boolean()),
});
type PatchInput = z.infer<typeof patchSchema>;

@Controller({ path: "admin/role-permissions", version: "1" })
@Roles(Role.SUPER_ADMIN)
export class AdminRolePermissionsController {
  constructor(
    private readonly permissions: PagePermissionService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Fresh read (skips the 30s per-process cache) so the toggle
   * matrix is never stale after a Save round-trip. Also returns
   * the compiled-in default set + the canonical key list so the
   * editor can render an "is this key at its default?" affordance
   * and stay in lockstep with the backend registry.
   */
  @Get()
  async get(): Promise<{
    overrides: Partial<Record<PageKey, boolean>>;
    defaults: readonly PageKey[];
    knownKeys: readonly PageKey[];
  }> {
    const overrides = await this.permissions.readAdminOverridesFresh();
    return {
      overrides,
      defaults: ADMIN_DEFAULT_PERMISSIONS,
      knownKeys: PAGE_KEYS,
    };
  }

  @Patch()
  @HttpCode(HttpStatus.OK)
  async patch(
    @CurrentUser() actor: AuthenticatedUser,
    @Body(new ZodValidationPipe(patchSchema)) body: PatchInput,
  ): Promise<{ overrides: Partial<Record<PageKey, boolean>> }> {
    // Snapshot the previous state so the audit-log entry captures a
    // clean before/after diff — cheap; we already need a read to
    // decide whether the write is a no-op.
    const before = await this.permissions.readAdminOverridesFresh();
    const after = await this.permissions.writeAdminOverrides(body.permissions);

    // Best-effort audit. Failing the audit MUST NOT roll back the
    // permission write — the write succeeded, we just miss a log line.
    // ADMIN role_permissions changes are rare enough that we accept
    // this tiny risk in exchange for the endpoint always succeeding
    // when the DB write succeeds.
    void this.audit
      .log({
        actorId: actor.sub,
        action: "admin.role_permissions.updated",
        resourceType: "configuration",
        resourceId: ADMIN_ROLE_PERMISSIONS_CONFIG_KEY,
        beforeState: before,
        afterState: after,
      })
      .catch(() => undefined);

    return { overrides: after };
  }
}
