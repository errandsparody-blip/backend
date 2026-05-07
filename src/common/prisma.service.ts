/**
 * PrismaService — Postgres connection lifecycle + safety rails.
 *
 * Production hardening (P5.4 / Implementation Plan §9.1):
 *
 *   - statement_timeout       — defends against runaway queries by killing
 *                               anything that runs longer than 10 seconds at
 *                               the database level.
 *   - lock_timeout            — caps how long a query waits for a row lock,
 *                               so a stuck transaction can't pile up.
 *   - idle_in_transaction_*   — kills idle-in-transaction sessions after 30s
 *                               (a common cause of deadlocks).
 *   - application_name        — every connection tagged so pg_stat_activity
 *                               clearly shows which process owns which session.
 *
 * The connection pool is sized via the DATABASE_URL itself
 * (`?connection_limit=...&pool_timeout=...`) per Prisma's config; we don't
 * override that here because PgBouncer in transaction-mode is the real pool
 * in production. In dev, the default pool size of CPU*2 is fine.
 */

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

const STATEMENT_TIMEOUT_MS = 10_000;
const LOCK_TIMEOUT_MS = 5_000;
const IDLE_IN_TX_TIMEOUT_MS = 30_000;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: [
        { emit: "event", level: "warn" },
        { emit: "event", level: "error" },
      ],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();

    // Apply per-session safety rails. These are session-scoped; on a pooled
    // connection (PgBouncer transaction mode) they're set per-connection at
    // the start of the connection, which is what we want. Run all four in
    // parallel — failure of any halts boot, which is the right default.
    await Promise.all([
      this.$executeRawUnsafe(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`),
      this.$executeRawUnsafe(`SET lock_timeout = ${LOCK_TIMEOUT_MS}`),
      this.$executeRawUnsafe(`SET idle_in_transaction_session_timeout = ${IDLE_IN_TX_TIMEOUT_MS}`),
      this.$executeRawUnsafe(`SET application_name = 'usa-errands-api'`),
    ]);

    this.logger.log(
      { statementTimeoutMs: STATEMENT_TIMEOUT_MS, lockTimeoutMs: LOCK_TIMEOUT_MS },
      "Prisma connected",
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log("Prisma disconnected");
  }
}
