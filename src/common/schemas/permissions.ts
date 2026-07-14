/**
 * Permission matrix — single source of truth between web (UI gating) and api
 * (RBAC enforcement). Mirrored in usa-errands-web/src/lib/schemas/permissions.ts.
 * Implementation Plan §5.
 */

import { Role } from "@prisma/client";

export const Permission = {
  ManageOwnAccount: "manage:own-account",
  ManageOwnProducts: "manage:own-products",
  ViewOwnInventory: "view:own-inventory",
  SubmitOwnPsn: "submit:own-psn",
  FundOwnWallet: "fund:own-wallet",
  ViewOwnWallet: "view:own-wallet",
  CreateOwnOrder: "create:own-order",
  ViewOwnOrders: "view:own-orders",
  ManageOwnReturns: "manage:own-returns",
  ReceivePsn: "receive:psn",
  GenerateLabels: "generate:labels",
  PerformInventoryAdjustment: "adjust:inventory",
  PickAndPack: "pick-pack:order",
  CreditWallet: "credit:wallet",
  RefundWallet: "refund:wallet",
  ApproveAdjustment: "approve:adjustment",
  ReadAuditLog: "read:audit",
  ReadAnyVendor: "read:any-vendor",
  ManageRbac: "manage:rbac",
  ManageConfiguration: "manage:configuration",
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

/**
 * Static role → permission mapping. This is the LEGACY authorisation
 * layer used by the `hasPermission` helper below and a small number
 * of surviving callers. The newer, more granular
 * `PagePermissionService` (migration 0039) supersedes this map for
 * anything ADMIN-tier: ADMIN's real capabilities come from the
 * per-page overrides in the `admin_role_page_permissions` config row
 * and are enforced by `PagePermissionGuard`, not by anything here.
 *
 * The type is `Partial<Record<Role, ...>>` (not `Record`) so a new
 * Prisma role — like ADMIN in migration 0039 — does NOT force a
 * mandatory entry here. If a role is absent, `hasPermission` treats
 * that as "no static permissions" (opt-in via page permissions),
 * which is exactly what we want for ADMIN. This also avoids the
 * chicken-and-egg problem where local dev has a stale Prisma client
 * (no ADMIN) and Railway has a freshly generated one (has ADMIN):
 * with `Record`, one of the two environments would always fail to
 * compile depending on how the ADMIN entry was written.
 */
export const ROLE_PERMISSIONS: Readonly<
  Partial<Record<Role, readonly Permission[]>>
> = {
  [Role.VENDOR]: [
    Permission.ManageOwnAccount,
    Permission.ManageOwnProducts,
    Permission.ViewOwnInventory,
    Permission.SubmitOwnPsn,
    Permission.FundOwnWallet,
    Permission.ViewOwnWallet,
    Permission.CreateOwnOrder,
    Permission.ViewOwnOrders,
    Permission.ManageOwnReturns,
  ],
  [Role.VENDOR_SUB_USER]: [
    Permission.ManageOwnProducts,
    Permission.ViewOwnInventory,
    Permission.CreateOwnOrder,
    Permission.ViewOwnOrders,
  ],
  [Role.WAREHOUSE_OPERATOR]: [
    Permission.ReceivePsn,
    Permission.GenerateLabels,
    Permission.PerformInventoryAdjustment,
    Permission.PickAndPack,
  ],
  [Role.FINANCE_ADMIN]: [
    Permission.ReceivePsn,
    Permission.PerformInventoryAdjustment,
    Permission.ApproveAdjustment,
    Permission.CreditWallet,
    Permission.RefundWallet,
    Permission.ReadAuditLog,
    Permission.ReadAnyVendor,
  ],
  [Role.SUPER_ADMIN]: Object.values(Permission),
  // Migration 0039 — ADMIN is intentionally absent (see the header
  // comment on ROLE_PERMISSIONS). Its capabilities come from the
  // `admin_role_page_permissions` config row via PagePermissionGuard.
  // `hasPermission` returns `false` for any missing role, which is
  // the correct default (fail closed) for the legacy layer.
};

export function hasPermission(role: Role, permission: Permission): boolean {
  // Missing role → treated as no static permissions (fail closed).
  // ADMIN falls into this branch on purpose; page permissions are the
  // authoritative source for that role.
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}
