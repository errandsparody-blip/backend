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

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
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
  // Migration 0039 — the ADMIN role is intentionally NOT gated by this
  // static permission matrix. Its real capabilities come from the
  // per-page overrides in the `admin_role_page_permissions` config row
  // and are enforced by PagePermissionGuard. The static map here is
  // legacy (pre-page-permissions) and is bypassed for ADMIN callers.
  // Empty array = "opt-in via page permissions" — a defensive default
  // that ensures a mis-wired guard falls closed for ADMIN rather than
  // silently inheriting SUPER_ADMIN capabilities.
  //
  // Referenced as the literal string because the local Prisma client
  // may not yet have regenerated for the ADMIN enum value in every
  // environment (Railway regenerates on deploy).
  ["ADMIN" as Role]: [],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
