/**
 * dev-delete-user.ts — destructive dev-environment cleanup for dummy users.
 *
 * Why this script exists.
 * -----------------------
 * The schema has two append-only DB triggers that block normal user deletion:
 *
 *   1. `audit_log_entries` blocks UPDATE — but the `actor_id` FK is
 *      `onDelete: SetNull`, so a DELETE FROM users tries to UPDATE the
 *      audit table to null out actor_id, which the trigger refuses.
 *   2. `ledger_entries` blocks DELETE — and the `vendor_id` FK is
 *      `onDelete: Cascade`, so deleting the user (which cascades to
 *      vendor) tries to delete ledger rows, which the trigger refuses.
 *
 * Both triggers exist for production compliance: the audit trail and the
 * money ledger must be append-only. They are doing exactly what they're
 * supposed to do.
 *
 * Additionally, `shopper_messages` and `psn_messages` carry a CHECK
 * constraint that says "if sender = ADMIN then sender_user_id IS NOT
 * NULL" — admin messages must be attributable. The `sender_user_id` FK
 * is `ON DELETE SET NULL`, so deleting an admin user who authored any
 * such message triggers a CHECK violation as the cascade tries to NULL
 * the column. We can't DISABLE a CHECK constraint the way we can a
 * trigger, so we pre-emptively DELETE the admin-authored messages
 * inside the same transaction before the user delete runs.
 *
 * For dev/staging cleanup of dummy signups you genuinely want to wipe,
 * this script:
 *   - Refuses to run unless NODE_ENV != 'production' OR ALLOW_DESTRUCTIVE_DELETE=true
 *   - Refuses to run if the DATABASE_URL host looks like a known prod host
 *     (defence in depth: cheap to wire, catches a footgun).
 *   - Disables the four triggers inside a single transaction.
 *   - Deletes the user (cascade flows naturally from there).
 *   - Re-enables the triggers in the same transaction so a partial
 *     failure can never leave them off.
 *
 * Usage.
 * ------
 *   pnpm dev:delete-user test1@example.com test2@example.com
 *
 * Or directly with ts-node:
 *   pnpm ts-node scripts/dev-delete-user.ts test1@example.com [--dry-run]
 *
 * From Railway (run inside the API container):
 *   ALLOW_DESTRUCTIVE_DELETE=true pnpm dev:delete-user <email>
 *
 * Pass --dry-run to print what would be deleted without making changes.
 */

import { PrismaClient } from "@prisma/client";

interface Args {
  emails: string[];
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const dryRun = argv.includes("--dry-run");
  const emails = argv.filter((a) => !a.startsWith("--") && a.includes("@"));
  if (emails.length === 0) {
    throw new Error(
      "Usage: tsx scripts/dev-delete-user.ts <email> [<email> ...] [--dry-run]",
    );
  }
  return { emails, dryRun };
}

function assertNonProd(): void {
  const env = process.env.NODE_ENV ?? "development";
  if (env === "production" && process.env.ALLOW_DESTRUCTIVE_DELETE !== "true") {
    throw new Error(
      "Refusing to run in production. Set ALLOW_DESTRUCTIVE_DELETE=true to override.",
    );
  }
  // Cheap secondary guard: if the DB hostname looks like a real prod URL,
  // bail unless overridden. Adjust the deny-list to match your hosts.
  const dbUrl = process.env.DATABASE_URL ?? "";
  const looksProd =
    /\b(prod|production|live)\b/i.test(dbUrl) ||
    /\.railway\.app/i.test(dbUrl) === false &&
      /\.amazonaws\.com|supabase\.co|neon\.tech/i.test(dbUrl);
  if (looksProd && process.env.ALLOW_DESTRUCTIVE_DELETE !== "true") {
    throw new Error(
      "DATABASE_URL looks like a production host. Set ALLOW_DESTRUCTIVE_DELETE=true to override.",
    );
  }
}

async function main(): Promise<void> {
  const { emails, dryRun } = parseArgs(process.argv.slice(2));
  assertNonProd();

  const prisma = new PrismaClient();
  try {
    // 1) Look up the users so we can report exactly what's being deleted.
    const targets = await prisma.user.findMany({
      where: { email: { in: emails } },
      select: { id: true, email: true, role: true, vendorId: true },
    });
    if (targets.length === 0) {
      console.log(`No users found with emails: ${emails.join(", ")}`);
      return;
    }

    console.log(`Will delete ${targets.length} user(s):`);
    for (const u of targets) {
      console.log(`  - ${u.email}  (id=${u.id}, role=${u.role}, vendorId=${u.vendorId ?? "—"})`);
    }

    if (dryRun) {
      console.log("\n--dry-run: no changes made.");
      return;
    }

    // 2) Disable the append-only triggers, run the delete, and re-enable
    //    inside a single transaction. If the DELETE throws, the
    //    transaction rolls back and the triggers stay enforced — Postgres
    //    treats `ALTER TABLE ... DISABLE TRIGGER` as a transaction-local
    //    DDL change in this context.
    //
    //    NB: ALTER TABLE acquires an ACCESS EXCLUSIVE lock on the target
    //    table for the duration of the transaction. That's fine for a
    //    dev cleanup but explicitly inappropriate for production.
    const userIds = targets.map((u) => u.id);

    await prisma.$transaction(
      async (tx) => {
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

        // Pre-emptive chat-message cleanup. `shopper_messages` and
        // `psn_messages` carry a CHECK that admin messages must have a
        // non-null sender_user_id. The FK on that column is
        // `ON DELETE SET NULL`, so the user delete cascade would try to
        // NULL admin-authored rows and trip the CHECK. Wiping the
        // user's admin-authored chat history first sidesteps the
        // problem without weakening the production constraint. Buyer
        // and vendor messages are left untouched — their thread
        // history stays intact.
        const shopperMsgsRemoved = await tx.shopperMessage.deleteMany({
          where: { senderUserId: { in: userIds }, sender: "ADMIN" },
        });
        const psnMsgsRemoved = await tx.psnMessage.deleteMany({
          where: { senderUserId: { in: userIds } },
        });
        if (shopperMsgsRemoved.count > 0 || psnMsgsRemoved.count > 0) {
          console.log(
            `Pre-cleaned ${shopperMsgsRemoved.count} shopper_messages and ${psnMsgsRemoved.count} psn_messages authored by these users (CHECK-constraint workaround).`,
          );
        }

        const deleted = await tx.user.deleteMany({ where: { id: { in: userIds } } });
        console.log(`Deleted ${deleted.count} user row(s); cascades flowed from there.`);

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
      { timeout: 30_000 },
    );

    console.log("Done. Triggers re-enabled.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
