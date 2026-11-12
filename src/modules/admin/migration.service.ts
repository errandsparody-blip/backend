/**
 * MigrationService — USA + Canada cutover (Phase 3), SUPER_ADMIN only.
 *
 * This is NOT a destructive data migration. Existing stock, PSNs and orders are
 * already classified USA by the country-column defaults (migrations 0077/0081),
 * with quantities, PSNs and history preserved and nothing duplicated. What
 * remains is a *controlled switch-on* of country routing, which the spec gates:
 *
 *   * The "Mandatory Dishie Skincare checkpoint" — before cutover, surface any
 *     vendor that has in-flight Canada orders but no received Canada stock
 *     (Dishie is the known case). Those orders would be flagged for review
 *     rather than pulling USA stock once routing is on.
 *   * Do NOT enable routing until the Super Admin explicitly confirms, after
 *     preparing Canada stock (e.g. Dishie's Canada PSN received).
 *
 * `enableCountryRouting` flips the `country_routing_enabled` config flag that
 * the allocation paths read. It is fully reversible via `disableCountryRouting`.
 */

import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { COUNTRY_ROUTING_CONFIG_KEY } from "../../common/fulfillment-country";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../audit/audit.service";

export interface MigrationReadiness {
  countryRoutingEnabled: boolean;
  /**
   * Vendors with in-flight Canada orders but no received Canada stock — these
   * must be prepared (Canada PSN received) before cutover, or their orders will
   * be flagged for review. The Dishie Skincare checkpoint lives here.
   */
  vendorsNeedingCanadaStock: Array<{
    vendorId: string;
    businessName: string;
    canadaOrderCount: number;
  }>;
  /** Total received Canada stock buckets on the platform (sanity signal). */
  canadaStockBuckets: number;
  generatedAt: string;
}

// In-flight = not in a terminal state. These orders would route to stock once
// country routing is on.
const IN_FLIGHT_EXCLUDED = ["CANCELLED", "DELIVERED", "RETURNED"];

@Injectable()
export class MigrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Snapshot the cutover preconditions, including the Dishie checkpoint. */
  async readiness(): Promise<MigrationReadiness> {
    const flagRow = await this.prisma.configuration.findUnique({
      where: { key: COUNTRY_ROUTING_CONFIG_KEY },
    });
    const countryRoutingEnabled = this.flagEnabled(flagRow?.value);

    // Vendors with in-flight Canada orders.
    const caOrderVendors = await this.prisma.$queryRaw<
      Array<{ vendor_id: string; business_name: string; n: bigint }>
    >(Prisma.sql`
      SELECT o.vendor_id, v.business_name, COUNT(*) AS n
      FROM orders o
      JOIN vendors v ON v.id = o.vendor_id
      WHERE o.ship_country = 'CA'
        AND o.status NOT IN (${Prisma.join(IN_FLIGHT_EXCLUDED)})
      GROUP BY o.vendor_id, v.business_name
    `);

    // Vendors that already have received Canada stock.
    const caStockVendors = await this.prisma.$queryRaw<Array<{ vendor_id: string }>>(Prisma.sql`
      SELECT DISTINCT vendor_id FROM skus WHERE country = 'CA' AND status = 'ACTIVE'
    `);
    const hasCaStock = new Set(caStockVendors.map((r) => r.vendor_id));

    const vendorsNeedingCanadaStock = caOrderVendors
      .filter((r) => !hasCaStock.has(r.vendor_id))
      .map((r) => ({
        vendorId: r.vendor_id,
        businessName: r.business_name,
        canadaOrderCount: Number(r.n),
      }));

    const stockCountRows = await this.prisma.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
      SELECT COUNT(*) AS n FROM skus WHERE country = 'CA' AND status = 'ACTIVE'
    `);

    return {
      countryRoutingEnabled,
      vendorsNeedingCanadaStock,
      canadaStockBuckets: Number(stockCountRows[0]?.n ?? 0),
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * The gated cutover. Enables country routing so orders allocate against
   * same-country stock. Requires explicit confirmation. If any vendor still has
   * Canada orders without Canada stock (the Dishie checkpoint), the caller must
   * additionally acknowledge that those orders will be held for review.
   */
  async enableCountryRouting(
    actorId: string,
    input: { confirm: boolean; acknowledgePendingCanada?: boolean },
  ): Promise<{ enabled: true; flaggedVendors: number }> {
    if (!input.confirm) {
      throw new BadRequestException({
        message: "Confirm the cutover explicitly (confirm: true).",
        code: "migration_not_confirmed",
      });
    }
    const readiness = await this.readiness();
    if (readiness.vendorsNeedingCanadaStock.length > 0 && !input.acknowledgePendingCanada) {
      throw new BadRequestException({
        message:
          "Some vendors have Canada orders but no received Canada stock (Dishie Skincare checkpoint). " +
          "Receive their Canada PSN first, or re-send with acknowledgePendingCanada: true to proceed — " +
          "those orders will be held for review rather than pulling USA stock.",
        code: "migration_pending_canada_stock",
        vendors: readiness.vendorsNeedingCanadaStock,
      });
    }

    await this.prisma.configuration.upsert({
      where: { key: COUNTRY_ROUTING_CONFIG_KEY },
      create: { key: COUNTRY_ROUTING_CONFIG_KEY, value: { enabled: true } },
      update: { value: { enabled: true } },
    });
    await this.audit.log({
      actorId,
      action: "migration.country_routing_enabled",
      resourceType: "configuration",
      resourceId: COUNTRY_ROUTING_CONFIG_KEY,
      afterState: {
        enabled: true,
        acknowledgedPendingCanadaVendors: readiness.vendorsNeedingCanadaStock.length,
      },
    });
    return { enabled: true, flaggedVendors: readiness.vendorsNeedingCanadaStock.length };
  }

  /** Reverse the cutover — back to single-pool allocation. */
  async disableCountryRouting(actorId: string): Promise<{ enabled: false }> {
    await this.prisma.configuration.upsert({
      where: { key: COUNTRY_ROUTING_CONFIG_KEY },
      create: { key: COUNTRY_ROUTING_CONFIG_KEY, value: { enabled: false } },
      update: { value: { enabled: false } },
    });
    await this.audit.log({
      actorId,
      action: "migration.country_routing_disabled",
      resourceType: "configuration",
      resourceId: COUNTRY_ROUTING_CONFIG_KEY,
      afterState: { enabled: false },
    });
    return { enabled: false };
  }

  private flagEnabled(raw: unknown): boolean {
    if (raw === true) return true;
    if (raw && typeof raw === "object" && "enabled" in raw) {
      return (raw as { enabled?: unknown }).enabled === true;
    }
    return false;
  }
}
