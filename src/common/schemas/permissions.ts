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
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
