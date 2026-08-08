/**
 * backfill-vendor-carrier-handoff.ts — one-off corrective backfill for
 * VENDOR_CARRIER orders that got stranded in the Fulfillment v2 label
 * flow before the recordPack hand-off fix shipped.
 *
 * Background
 * ----------
 * Before the fix, a "use my own carrier" (VENDOR_CARRIER) order was
 * created in PENDING_PACKING like any other v2 order, packed into
 * PACKING_COMPLETED, and then surfaced in the rate picker — where the
 * admin was wrongly pushed to buy a platform label. The fix diverts
 * these orders straight to HANDED_OFF at pack time, but any order that
 * was ALREADY packed before the deploy is still sitting in one of the
 * pre-label v2 statuses. This script completes those hand-offs.
 *
 * What it targets
 * ---------------
 * Orders where ALL of:
 *   - fulfillment_mode = 'VENDOR_CARRIER'
 *   - workflow_version = 2
 *   - status IN ('PACKING_COMPLETED',
 *                'AWAITING_SHIPPING_SELECTION',
 *                'AWAITING_WALLET_FUNDING')
 *
 * PENDING_PACKING is intentionally EXCLUDED: those aren't stuck in the
 * label flow — the operator just packs them normally and the fixed
 * recordPack hands them off automatically.
 *
 * What it does per order (one transaction each)
 * ---------------------------------------------
 *   1. Locks the order row (FOR UPDATE) and re-verifies mode/status.
 *   2. Drops any cached Shippo rate options (they were never valid).
 *   3. Decrements each SKU's reserved qty, writes a SHIP inventory
 *      movement, and marks each order line SHIPPED — identical
 *      bookkeeping to OrderPackService's vendor-carrier hand-off.
 *   4. Sets status = HANDED_OFF and stamps handed_off_at.
 *   5. Writes an order.handed_off event noting this was a backfill.
 *
 * The PACKING_COMPLETED / AWAITING_* → HANDED_OFF transitions are all
 * forward moves (trigger ranks 1.6/1.65/1.7 → 7.5), so the order
 * status-machine trigger allows them without a whitelist.
 *
 * What it does NOT do
 * -------------------
 *   - No wallet movement. VENDOR_CARRIER orders only ever paid the
 *     fulfillment fee (at submit); there is no shipping charge to add
 *     or refund.
 *   - No vendor notification. These parcels were physically handled
 *     out-of-band while stuck; a fresh "handed off" email could confuse
 *     a vendor whose customer already has the package. Coordinate comms
 *     manually if needed.
 *
 * Safety
 * ------
 *   - Dry-run by default: prints the exact orders it WOULD hand off and
 *     stops. Pass --confirm to actually write.
 *   - --actor <uuid> optionally attributes the movements/events to a
 *     specific admin user; otherwise they're recorded with a null actor
 *     and source=CRON (both columns are nullable).
 *   - Each order is its own transaction, so one failure can't roll back
 *     the others; the summary reports successes and failures.
 *
 * Usage
 * -----
 *   # 1) See what would be handed off
 *   pnpm ts-node scripts/backfill-vendor-carrier-handoff.ts
 *
 *   # 2) Apply
 *   pnpm ts-node scripts/backfill-vendor-carrier-handoff.ts --confirm
 *
 *   # optionally attribute to an admin user
 *   pnpm ts-node scripts/backfill-vendor-carrier-handoff.ts --confirm --actor <uuid>
 *
 * From Railway: run inside the API container against the deploy DB.
 * Take a Postgres backup first (Railway → Postgres → Backups).
 */

import { PrismaClient, Prisma } from "@prisma/client";

interface Args {
  confirm: boolean;
  actorId: string | null;
}

const TARGET_STATUSES = [
  "PACKING_COMPLETED",
  "AWAITING_SHIPPING_SELECTION",
  "AWAITING_WALLET_FUNDING",
] as const;

function parseArgs(argv: string[]): Args {
  const confirm = argv.includes("--confirm");
  const actorIdx = argv.indexOf("--actor");
  const actorId =
    actorIdx >= 0 && argv[actorIdx + 1] ? argv[actorIdx + 1]! : null;
  return { confirm, actorId };
}

interface Candidate {
  id: string;
  order_number: number;
  status: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();

  try {
    // Find candidates via raw SQL so we read fulfillment_mode straight
    // from the column (the generated client may lag the migration in
    // some environments).
    const candidates = await prisma.$queryRaw<Candidate[]>(Prisma.sql`
      SELECT id, order_number, status
      FROM orders
      WHERE fulfillment_mode = 'VENDOR_CARRIER'
        AND workflow_version = 2
        AND status IN ('PACKING_COMPLETED', 'AWAITING_SHIPPING_SELECTION', 'AWAITING_WALLET_FUNDING')
      ORDER BY order_number ASC
    `);

    if (candidates.length === 0) {
      console.log("No stranded VENDOR_CARRIER orders found. Nothing to do.");
      return;
    }

    console.log(
      `Found ${candidates.length} stranded VENDOR_CARRIER order(s) in the label flow:`,
    );
    for (const c of candidates) {
      console.log(`  #${c.order_number}  (${c.status})  ${c.id}`);
    }

    if (!args.confirm) {
      console.log(
        "\nDRY RUN — no changes made. Re-run with --confirm to hand these off.",
      );
      return;
    }

    if (args.actorId) {
      const actor = await prisma.user.findUnique({
        where: { id: args.actorId },
        select: { id: true },
      });
      if (!actor) {
        throw new Error(`--actor ${args.actorId} is not a known user id.`);
      }
    }

    console.log("\nApplying hand-offs…");
    let ok = 0;
    const failures: Array<{ orderNumber: number; error: string }> = [];

    for (const c of candidates) {
      try {
        await prisma.$transaction(async (tx) => {
          // Re-lock + re-verify inside the tx so a concurrent change
          // (e.g. someone completing it in the UI) can't be clobbered.
          const lockedRows = await tx.$queryRaw<
            Array<{ id: string; status: string; fulfillment_mode: string | null }>
          >(Prisma.sql`
            SELECT id, status, fulfillment_mode
            FROM orders
            WHERE id = ${c.id}::uuid
            FOR UPDATE
          `);
          const locked = lockedRows[0];
          if (!locked) throw new Error("order vanished");
          if (locked.fulfillment_mode !== "VENDOR_CARRIER") {
            throw new Error(`no longer VENDOR_CARRIER (${locked.fulfillment_mode})`);
          }
          if (!TARGET_STATUSES.includes(locked.status as (typeof TARGET_STATUSES)[number])) {
            throw new Error(`status changed to ${locked.status}; skipped`);
          }

          // Drop stale cached rates.
          await tx.$executeRaw(Prisma.sql`
            DELETE FROM order_shipping_rate_options
            WHERE order_id = ${c.id}::uuid
          `);

          // Inventory hand-off bookkeeping — mirrors
          // OrderPackService recordPack (VENDOR_CARRIER branch).
          const lines = await tx.orderLine.findMany({ where: { orderId: c.id } });
          for (const line of lines) {
            await tx.sku.update({
              where: { id: line.skuId },
              data: { quantityReserved: { decrement: line.quantity } },
            });
            await tx.inventoryMovement.create({
              data: {
                vendorId: line.vendorId,
                skuId: line.skuId,
                type: "SHIP",
                deltaAvailable: 0,
                deltaReserved: -line.quantity,
                referenceType: "order",
                referenceId: c.id,
                actorId: args.actorId,
                reason: "Vendor-carrier hand-off backfill",
              },
            });
            await tx.orderLine.update({
              where: { id: line.id },
              data: { allocationStatus: "SHIPPED" },
            });
          }

          const now = new Date();
          await tx.$executeRaw(Prisma.sql`
            UPDATE orders
               SET status = 'HANDED_OFF'::"OrderStatus",
                   handed_off_at = ${now},
                   updated_at = NOW()
             WHERE id = ${c.id}::uuid
          `);

          await tx.orderEvent.create({
            data: {
              orderId: c.id,
              type: "order.handed_off",
              description:
                "Handed to vendor's own carrier (backfill — order was stranded in the v2 label flow before the hand-off fix).",
              source: "CRON",
              actorId: args.actorId,
            },
          });
        });
        ok += 1;
        console.log(`  ✓ #${c.order_number} handed off`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failures.push({ orderNumber: c.order_number, error: msg });
        console.log(`  ✗ #${c.order_number} FAILED: ${msg}`);
      }
    }

    console.log(
      `\nDone. ${ok} handed off, ${failures.length} failed of ${candidates.length}.`,
    );
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
