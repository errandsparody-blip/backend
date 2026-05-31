/**
 * prod-wipe-vendor-data.ts — bulk reset of vendor-owned data, keeping
 * admin accounts and configuration intact.
 *
 * What this DOES delete
 * ---------------------
 *   - Every Vendor row → cascades through the FK graph to:
 *       VendorInvitation, vendor users (User with vendorId), Wallet,
 *       LedgerEntry, Product, Sku, Psn (+ lines, exceptions, holds),
 *       PsnMessage, StorageBox, Order (+ lines, events), Return
 *       (+ lines, attachments), InventoryMovement, Notification
 *       (recipient = vendor user), VendorAgreementAcceptance,
 *       ShopperRequest rows where vendorId was set
 *   - Every ShopperRequest (buyer-facing data — operators won't have
 *     a real customer history to clean up after a vendor wipe; if you
 *     want to keep buyer threads, comment out the shopper_requests
 *     delete below)
 *   - Every webhook_events row (Stripe/Shippo replay history is no
 *     longer relevant once the underlying records are gone)
 *   - Every idempotency_keys row (vendor-scoped request dedup)
 *   - Every pricing_guide_leads row (marketing capture from vendors)
 *   - Every User with role VENDOR or VENDOR_SUB_USER (defensive sweep
 *     for orphan signups that never got linked to a Vendor)
 *
 * What this KEEPS
 * ---------------
 *   - Users with role WAREHOUSE_OPERATOR / FINANCE_ADMIN / SUPER_ADMIN,
 *     plus their sessions, recovery codes, and authored audit entries
 *   - The `configuration` table (fee schedule, tier dimensions,
 *     freight rates, pallet policy, etc.)
 *   - Schema, triggers, indexes — nothing is dropped
 *
 * Why the trigger dance
 * ---------------------
 * The schema has append-only triggers on audit_log_entries and
 * ledger_entries. Cascade-deletes from Vendor will try to either NULL
 * the audit actor_id column (UPDATE blocked) or DELETE ledger rows
 * (DELETE blocked). We disable the four triggers inside the same
 * transaction as the wipe, and re-enable them before COMMIT. If
 * anything throws, the transaction rolls back and the triggers stay
 * enforced — they cannot be left disabled.
 *
 * Safety
 * ------
 *   - Refuses to run in production unless ALLOW_DESTRUCTIVE_DELETE=true
 *   - Always reports the row counts it intends to delete BEFORE the
 *     transaction. Pass --dry-run to stop at that point.
 *   - Without --confirm, requires you to acknowledge the count by
 *     re-running with --confirm. This is the second guard so you
 *     can't accidentally fat-finger a one-line wipe.
 *
 * Usage
 * -----
 *   # 1) Dry run — see what would go
 *   pnpm dev:wipe-vendor-data --dry-run
 *
 *   # 2) Confirm on second invocation (against deploy DB)
 *   ALLOW_DESTRUCTIVE_DELETE=true pnpm dev:wipe-vendor-data --confirm
 *
 * IMPORTANT: take a Postgres backup first. Railway → Postgres service →
 * Backups → Create Backup. Restore is per-table from the backup UI.
 */

import { PrismaClient } from "@prisma/client";

interface Args {
  dryRun: boolean;
  confirm: boolean;
}

function parseArgs(argv: string[]): Args {
  return {
    dryRun: argv.includes("--dry-run"),
    confirm: argv.includes("--confirm"),
  };
}

function assertSafetyOverride(): void {
  const env = process.env.NODE_ENV ?? "development";
  if (env === "production" && process.env.ALLOW_DESTRUCTIVE_DELETE !== "true") {
    throw new Error(
      "Refusing to run in production. Set ALLOW_DESTRUCTIVE_DELETE=true to override.",
    );
  }
  const dbUrl = process.env.DATABASE_URL ?? "";
  if (!dbUrl) {
    throw new Error("DATABASE_URL is not set. Point it at the target database.");
  }
}

/** Report counts of every row class we're about to delete. */
async function reportCounts(prisma: PrismaClient): Promise<{ total: number }> {
  const [
    vendors,
    vendorUsers,
    adminUsers,
    products,
    skus,
    psns,
    orders,
    returns,
    wallets,
    ledger,
    storageBoxes,
    shopperRequests,
    webhookEvents,
    idempotencyKeys,
    pricingLeads,
  ] = await Promise.all([
    prisma.vendor.count(),
    prisma.user.count({ where: { role: { in: ["VENDOR", "VENDOR_SUB_USER"] } } }),
    prisma.user.count({
      where: { role: { in: ["WAREHOUSE_OPERATOR", "FINANCE_ADMIN", "SUPER_ADMIN"] } },
    }),
    prisma.product.count(),
    prisma.sku.count(),
    prisma.psn.count(),
    prisma.order.count(),
    prisma.return.count(),
    prisma.wallet.count(),
    prisma.ledgerEntry.count(),
    prisma.storageBox.count(),
    prisma.shopperRequest.count(),
    prisma.webhookEvent.count(),
    prisma.idempotencyKey.count(),
    prisma.pricingGuideLead.count(),
  ]);

  console.log("\n=== Pre-wipe row counts ===");
  console.log(`  vendors:                ${vendors}`);
  console.log(`  vendor users:           ${vendorUsers}     (WILL DELETE)`);
  console.log(`  admin users:            ${adminUsers}     (KEEP)`);
  console.log(`  products:               ${products}`);
  console.log(`  skus:                   ${skus}`);
  console.log(`  psns:                   ${psns}`);
  console.log(`  orders:                 ${orders}`);
  console.log(`  returns:                ${returns}`);
  console.log(`  wallets:                ${wallets}`);
  console.log(`  ledger entries:         ${ledger}`);
  console.log(`  storage boxes:          ${storageBoxes}`);
  console.log(`  shopper requests:       ${shopperRequests}`);
  console.log(`  webhook events:         ${webhookEvents}`);
  console.log(`  idempotency keys:       ${idempotencyKeys}`);
  console.log(`  pricing guide leads:    ${pricingLeads}`);
  console.log("===========================\n");

  return {
    total:
      vendors +
      vendorUsers +
      products +
      skus +
      psns +
      orders +
      returns +
      wallets +
      ledger +
      storageBoxes +
      shopperRequests +
      webhookEvents +
      idempotencyKeys +
      pricingLeads,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  assertSafetyOverride();

  const prisma = new PrismaClient();
  try {
    const { total } = await reportCounts(prisma);

    if (total === 0) {
      console.log("Nothing to delete — every targeted table is already empty.");
      return;
    }

    if (args.dryRun) {
      console.log("--dry-run: no changes made.");
      return;
    }

    if (!args.confirm) {
      console.log(
        "Refusing to delete without --confirm. Re-run with --confirm if the counts above are what you expect.",
      );
      console.log(
        "Example: ALLOW_DESTRUCTIVE_DELETE=true pnpm dev:wipe-vendor-data --confirm",
      );
      process.exitCode = 1;
      return;
    }

    console.log("Starting wipe transaction…");

    await prisma.$transaction(
      async (tx) => {
        // 1) Disable the append-only triggers for the duration of this
        //    transaction. If the wipe throws, ROLLBACK restores them.
        await tx.$executeRawUnsafe(
          `ALTER TABLE audit_log_entries DISABLE TRIGGER trg_audit_log_no_update`,
        );
        await tx.$executeRawUnsafe(
          `ALTER TABLE audit_log_entries DISABLE TRIGGER trg_audit_log_no_delete`,
        );
        await tx.$executeRawUnsafe(
          `ALTER TABLE ledger_entries DISABLE TRIGGER trg_ledger_no_update`,
        );
        await tx.$executeRawUnsafe(
          `ALTER TABLE ledger_entries DISABLE TRIGGER trg_ledger_no_delete`,
        );

        // 2) Pre-clean check-constrained chat rows that block cascade.
        //    Admin-authored psn_messages + shopper_messages enforce
        //    "sender = ADMIN ⇒ sender_user_id NOT NULL"; the FK is
        //    ON DELETE SET NULL, so we wipe them up front rather than
        //    leave the cascade to trip the CHECK.
        const psnMsgs = await tx.psnMessage.deleteMany({});
        const shopperMsgs = await tx.shopperMessage.deleteMany({});
        console.log(
          `  Cleared ${psnMsgs.count} psn_messages, ${shopperMsgs.count} shopper_messages`,
        );

        // 3) Shopper requests — buyer-facing thread state. Wipe before
        //    vendors so the cascade-from-vendor doesn't have to walk
        //    them. If you want to KEEP buyer history, delete this line.
        const shopperReqs = await tx.shopperRequest.deleteMany({});
        console.log(`  Cleared ${shopperReqs.count} shopper_requests`);

        // 4) Pricing guide leads (marketing capture, vendor-leaning)
        const leads = await tx.pricingGuideLead.deleteMany({});
        console.log(`  Cleared ${leads.count} pricing_guide_leads`);

        // 5) Webhook events + idempotency keys — replay/dedup state
        //    that's pointless once the underlying rows are gone.
        const webhooks = await tx.webhookEvent.deleteMany({});
        const idemp = await tx.idempotencyKey.deleteMany({});
        console.log(
          `  Cleared ${webhooks.count} webhook_events, ${idemp.count} idempotency_keys`,
        );

        // 6) THE BIG ONE — delete all vendors. Cascades flow from here
        //    to: vendor_invitations, vendor users (User.vendorId FK
        //    Cascade), wallets, ledger_entries, products, skus, psns
        //    (+ lines + exceptions + holds), storage_boxes, orders
        //    (+ lines + events), returns (+ lines + attachments),
        //    inventory_movements, notifications, vendor agreement
        //    acceptances.
        const vendors = await tx.vendor.deleteMany({});
        console.log(`  Deleted ${vendors.count} vendors (cascade flowed)`);

        // 7) Defensive sweep — any remaining User rows with vendor role
        //    that didn't have a vendorId (e.g. PENDING_EMAIL_VERIFICATION
        //    signups that never finished onboarding).
        const orphanUsers = await tx.user.deleteMany({
          where: { role: { in: ["VENDOR", "VENDOR_SUB_USER"] } },
        });
        console.log(`  Swept ${orphanUsers.count} orphan vendor users`);

        // 8) Re-enable triggers. If anything above threw, we never get
        //    here and the transaction rolls back — triggers stay on.
        await tx.$executeRawUnsafe(
          `ALTER TABLE audit_log_entries ENABLE TRIGGER trg_audit_log_no_update`,
        );
        await tx.$executeRawUnsafe(
          `ALTER TABLE audit_log_entries ENABLE TRIGGER trg_audit_log_no_delete`,
        );
        await tx.$executeRawUnsafe(
          `ALTER TABLE ledger_entries ENABLE TRIGGER trg_ledger_no_update`,
        );
        await tx.$executeRawUnsafe(
          `ALTER TABLE ledger_entries ENABLE TRIGGER trg_ledger_no_delete`,
        );
      },
      { timeout: 120_000 },
    );

    console.log("\nDone. Triggers re-enabled. Re-running count report:");
    await reportCounts(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
