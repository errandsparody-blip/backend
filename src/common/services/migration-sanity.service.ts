/**
 * MigrationSanityService — boot-time guard against a mis-deployed
 * environment.
 *
 * If the app is started against a database that hasn't run the
 * migrations the code depends on, it will happily boot and then 500
 * on the first request that hits the missing schema. That's what
 * happened in prod after Phase C shipped without `prisma migrate
 * deploy` in the release step.
 *
 * This service runs ONCE on onApplicationBootstrap and verifies that
 * a small set of critical columns exist in `orders`. If any are
 * missing, it logs the missing set and throws — Nest treats that as
 * a fatal boot error and refuses to serve requests. Ops sees the
 * exact missing columns in the deploy log instead of a mystery 500
 * an hour later.
 *
 * SOLID
 *   * SRP — this service only checks schema; it does not run
 *     migrations, does not fix anything, does not touch data.
 *   * OCP — REQUIRED_COLUMNS is a single constant; adding another
 *     column to the check list is one line.
 *   * Fail-fast is the correct default. Env override
 *     `SKIP_MIGRATION_SANITY_CHECK=true` exists for emergency
 *     recovery scenarios (rare); we log a big warning when it's set
 *     so ops can't silently ignore it.
 *
 * Skipped in test env — jest specs don't spin up a real database.
 */

import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";

import { PrismaService } from "../prisma.service";

/**
 * (table, column) pairs the app REQUIRES to be present. Everything
 * listed here comes from migrations 0040–0047 (Fulfillment v2). If
 * any of these are missing at boot the environment is behind on
 * migrations and requests would 500 as soon as they hit the pack
 * pipeline.
 *
 * Keep this list small and focused on the CRITICAL PATH — every entry
 * costs one round-trip on boot.
 */
const REQUIRED_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  // Migration 0040 — shipping points foundation.
  { table: "products", column: "shipping_points" },
  { table: "orders", column: "workflow_version" },
  // Migration 0041 — Fulfillment v2 estimate columns.
  { table: "orders", column: "estimated_shipping_min_cents" },
  { table: "orders", column: "estimated_shipping_max_cents" },
  // Migration 0042 — pack columns on orders.
  { table: "orders", column: "packed_length_in" },
  { table: "orders", column: "packed_width_in" },
  { table: "orders", column: "packed_height_in" },
  { table: "orders", column: "packed_weight_oz" },
  { table: "orders", column: "packed_by_user_id" },
  { table: "orders", column: "packing_notes" },
  // Migration 0043 — packaging library FK.
  { table: "orders", column: "packaging_option_id" },
  // Migration 0045 — inventory-location FK on SKUs.
  { table: "skus", column: "location_id" },
];

@Injectable()
export class MigrationSanityService implements OnApplicationBootstrap {
  private readonly logger = new Logger(MigrationSanityService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    // Skip during tests — jest runs against a fake Prisma with no real DB.
    if (process.env.NODE_ENV === "test") return;

    if (process.env.SKIP_MIGRATION_SANITY_CHECK === "true") {
      this.logger.warn(
        {
          msg: "MigrationSanityService — SKIPPED via env override. This is an emergency escape hatch; unset SKIP_MIGRATION_SANITY_CHECK ASAP.",
        },
      );
      return;
    }

    // One round-trip using a parameterised IN clause. Postgres returns
    // the (table, column) pairs that DO exist; we compute the missing
    // set client-side.
    const tableNames = Array.from(
      new Set(REQUIRED_COLUMNS.map((c) => c.table)),
    );
    const columnNames = Array.from(
      new Set(REQUIRED_COLUMNS.map((c) => c.column)),
    );

    let rows: Array<{ table_name: string; column_name: string }>;
    try {
      rows = await this.prisma.$queryRawUnsafe<
        Array<{ table_name: string; column_name: string }>
      >(
        `SELECT table_name, column_name
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = ANY($1::text[])
            AND column_name = ANY($2::text[])`,
        tableNames,
        columnNames,
      );
    } catch (err) {
      // Failing the sanity check because we couldn't run the check is
      // safer than failing open. Log the underlying error and rethrow
      // so Nest aborts boot.
      this.logger.error(
        {
          msg: "MigrationSanityService — could not query information_schema; refusing to start.",
          err: err instanceof Error ? err.message : String(err),
        },
        err instanceof Error ? err.stack : undefined,
      );
      throw new Error(
        "Migration sanity check failed: could not read information_schema. See stderr for details.",
      );
    }

    const present = new Set(
      rows.map((r) => `${r.table_name}.${r.column_name}`),
    );
    const missing = REQUIRED_COLUMNS.filter(
      (c) => !present.has(`${c.table}.${c.column}`),
    );

    if (missing.length > 0) {
      this.logger.error({
        msg: "MigrationSanityService — required columns missing. Run `pnpm prisma migrate deploy` before starting the app.",
        missing: missing.map((c) => `${c.table}.${c.column}`),
        expectedMigrations: [
          "0040_shipping_points_foundation",
          "0041_fulfillment_v2_statuses",
          "0042_pack_and_rate_cache",
          "0043_packaging_library",
          "0045_inventory_locations",
        ],
      });
      throw new Error(
        `Migration sanity check failed: ${missing.length} required column(s) missing (${missing
          .map((c) => `${c.table}.${c.column}`)
          .join(", ")}). Run 'pnpm prisma migrate deploy' and restart.`,
      );
    }

    this.logger.log({
      msg: "MigrationSanityService — all required columns present.",
      checked: REQUIRED_COLUMNS.length,
    });
  }
}
