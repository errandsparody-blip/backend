/**
 * VendorAssignmentService — USA + Canada operational control (migration 0078).
 *
 * SUPER_ADMIN-only management of which operational ADMIN handles which vendor,
 * per country, plus setting an admin's own country. Reads/writes the
 * `vendor_admin_assignments` table and `users.admin_country`.
 *
 * Uses raw SQL for the 0078 table/column because the committed Prisma client
 * is regenerated only on deploy; this is the same stale-client pattern the rest
 * of the codebase uses for freshly-migrated columns.
 */

import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, Role } from "@prisma/client";

import { PrismaService } from "../../common/prisma.service";
import { toFulfillmentCountry, type FulfillmentCountry } from "../../common/fulfillment-country";
import { AuditService } from "../audit/audit.service";

// Stale-client guard: the generated Role enum may predate ADMIN (migration
// 0039). String constant → compiles regardless; exact at runtime.
const ROLE_ADMIN = "ADMIN" as Role;

export interface VendorAssignmentRow {
  vendorId: string;
  vendorBusinessName: string;
  country: FulfillmentCountry;
  adminUserId: string;
  adminEmail: string;
  updatedAt: string;
}

@Injectable()
export class VendorAssignmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Set (or clear) the country an operational admin is scoped to. */
  async setAdminCountry(
    actorId: string,
    adminUserId: string,
    country: "US" | "CA" | null,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: adminUserId },
      select: { id: true, role: true, email: true },
    });
    if (!user) throw new NotFoundException("Admin user not found.");
    if (user.role !== ROLE_ADMIN) {
      throw new BadRequestException("Only ADMIN users can be scoped to a country.");
    }
    const value = country ? toFulfillmentCountry(country) : null;
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE users SET admin_country = ${value} WHERE id = ${adminUserId}::uuid
    `);
    await this.audit.log({
      actorId,
      action: "admin.country_set",
      resourceType: "user",
      resourceId: adminUserId,
      afterState: { adminCountry: value },
    });
  }

  /**
   * Assign a vendor to an operational admin for a country. Upserts on
   * (vendorId, country) so re-assigning simply moves the vendor to the new
   * admin. The admin must already be scoped to that country.
   */
  async assign(
    actorId: string,
    input: { vendorId: string; country: "US" | "CA"; adminUserId: string },
  ): Promise<void> {
    const country = toFulfillmentCountry(input.country);

    const vendor = await this.prisma.vendor.findUnique({
      where: { id: input.vendorId },
      select: { id: true },
    });
    if (!vendor) throw new NotFoundException("Vendor not found.");

    const admin = await this.prisma.user.findUnique({
      where: { id: input.adminUserId },
      select: { id: true, role: true },
    });
    if (!admin || admin.role !== ROLE_ADMIN) {
      throw new BadRequestException("Assignee must be an ADMIN user.");
    }
    // The admin's own country must match what they're being assigned for — a
    // USA Admin can't own a Canada assignment.
    const rows = await this.prisma.$queryRaw<Array<{ admin_country: string | null }>>(
      Prisma.sql`SELECT admin_country FROM users WHERE id = ${input.adminUserId}::uuid`,
    );
    const adminCountry = rows[0]?.admin_country ? toFulfillmentCountry(rows[0].admin_country) : null;
    if (adminCountry !== country) {
      throw new BadRequestException(
        `That admin is scoped to ${adminCountry ?? "no country"}, not ${country}. Set their country first.`,
      );
    }

    await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO vendor_admin_assignments (vendor_id, country, admin_user_id, assigned_by_id)
      VALUES (${input.vendorId}::uuid, ${country}, ${input.adminUserId}::uuid, ${actorId}::uuid)
      ON CONFLICT (vendor_id, country)
      DO UPDATE SET admin_user_id = EXCLUDED.admin_user_id,
                    assigned_by_id = EXCLUDED.assigned_by_id,
                    updated_at = CURRENT_TIMESTAMP
    `);
    await this.audit.log({
      actorId,
      action: "vendor.admin_assigned",
      resourceType: "vendor",
      resourceId: input.vendorId,
      afterState: { country, adminUserId: input.adminUserId },
    });
  }

  /** Remove a vendor's admin assignment for a country (reverts to Super Admin only). */
  async unassign(actorId: string, vendorId: string, country: "US" | "CA"): Promise<void> {
    const c = toFulfillmentCountry(country);
    await this.prisma.$executeRaw(Prisma.sql`
      DELETE FROM vendor_admin_assignments
      WHERE vendor_id = ${vendorId}::uuid AND country = ${c}
    `);
    await this.audit.log({
      actorId,
      action: "vendor.admin_unassigned",
      resourceType: "vendor",
      resourceId: vendorId,
      afterState: { country: c },
    });
  }

  /** All assignments, newest first — for the Super Admin assignment screen. */
  async list(): Promise<VendorAssignmentRow[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        vendor_id: string;
        business_name: string;
        country: string;
        admin_user_id: string;
        email: string;
        updated_at: Date;
      }>
    >(Prisma.sql`
      SELECT a.vendor_id, v.business_name, a.country, a.admin_user_id, u.email, a.updated_at
      FROM vendor_admin_assignments a
      JOIN vendors v ON v.id = a.vendor_id
      JOIN users u ON u.id = a.admin_user_id
      ORDER BY a.updated_at DESC
    `);
    return rows.map((r) => ({
      vendorId: r.vendor_id,
      vendorBusinessName: r.business_name,
      country: toFulfillmentCountry(r.country),
      adminUserId: r.admin_user_id,
      adminEmail: r.email,
      updatedAt: r.updated_at.toISOString(),
    }));
  }
}
