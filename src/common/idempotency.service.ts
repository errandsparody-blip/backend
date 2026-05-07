/**
 * IdempotencyService — guards state-changing endpoints against duplicate
 * processing. Implementation Plan §11.1.
 *
 * Contract:
 *   1. Caller passes an Idempotency-Key header (UUID, ≤ 255 chars).
 *   2. Service computes sha256(canonical(body)) and stores it on first use.
 *   3. Same key + same hash → returns the original cached response.
 *   4. Same key + different hash → 409 (conflict). Replay attempts cannot mutate.
 *   5. Keys are scoped to (vendor, endpoint) so two vendors cannot collide.
 *
 * TTL: 30 days. The DB function purge_expired_idempotency_keys() (migration
 * 0004) clears the table; the cron is scheduled in P2.7 worker.
 */

import { ConflictException, Injectable } from "@nestjs/common";

import { CryptoService } from "./crypto.service";
import { PrismaService } from "./prisma.service";

export interface CachedIdempotentResponse {
  status: number;
  body: unknown;
}

interface BeginArgs {
  key: string;
  endpoint: string;
  vendorId: string | null;
  body: unknown;
}

@Injectable()
export class IdempotencyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  /**
   * Look up an existing cached response. Returns null if this is a fresh key.
   * Throws ConflictException if the same key was used previously with a
   * different request body.
   */
  async lookup(args: BeginArgs): Promise<CachedIdempotentResponse | null> {
    const requestHash = this.hashRequest(args.body);
    const existing = await this.prisma.idempotencyKey.findUnique({
      where: { key: this.scopedKey(args.key, args.endpoint, args.vendorId) },
    });
    if (!existing) return null;

    if (existing.requestHash !== requestHash) {
      throw new ConflictException({
        message:
          "Idempotency-Key has been used previously with a different request body. Use a fresh key.",
        code: "idempotency_key_mismatch",
      });
    }
    return { status: existing.responseStatus, body: existing.responseBody as unknown };
  }

  /**
   * Persist the response of a successful operation against the idempotency key.
   * Should run inside the same DB transaction as the mutation it guards.
   */
  async commit(
    args: BeginArgs & { responseStatus: number; responseBody: unknown },
    tx?: { idempotencyKey: { create: (data: unknown) => Promise<unknown> } },
  ): Promise<void> {
    const requestHash = this.hashRequest(args.body);
    const ttlMs = 30 * 24 * 60 * 60 * 1000; // 30 days
    const key = this.scopedKey(args.key, args.endpoint, args.vendorId);
    const create = tx?.idempotencyKey.create ?? this.prisma.idempotencyKey.create.bind(this.prisma.idempotencyKey);
    await create({
      data: {
        key,
        endpoint: args.endpoint,
        requestHash,
        responseStatus: args.responseStatus,
        responseBody: args.responseBody as object,
        vendorId: args.vendorId,
        expiresAt: new Date(Date.now() + ttlMs),
      },
    });
  }

  // -------------------------------------------------------------------------

  private hashRequest(body: unknown): string {
    // Canonicalize: sort keys deterministically. JSON.stringify alone preserves
    // insertion order, which is fragile across clients.
    const canonical = JSON.stringify(this.canonicalize(body));
    return this.crypto.sha256(canonical);
  }

  private canonicalize(input: unknown): unknown {
    if (input === null || typeof input !== "object") return input;
    if (Array.isArray(input)) return input.map((v) => this.canonicalize(v));
    return Object.keys(input as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = this.canonicalize((input as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }

  private scopedKey(key: string, endpoint: string, vendorId: string | null): string {
    return `${vendorId ?? "_"}::${endpoint}::${key}`;
  }
}
