/**
 * ConfigFlagService — reads boolean switches from the `configuration` table.
 *
 * Used for operational feature flags that a SUPER_ADMIN flips without a deploy,
 * e.g. `country_routing_enabled` (migration 0077/0078): while OFF, allocation
 * does not constrain an order to same-country stock, so the platform behaves
 * exactly as it does today. It flips ON only once the Canada rollout is
 * complete (admins, migration and Canada stock all in place).
 *
 * Reads are cached for a short TTL so a hot allocation path doesn't hit the DB
 * every time; a flag change propagates within the TTL.
 */

import { Injectable } from "@nestjs/common";

import { PrismaService } from "../prisma.service";

@Injectable()
export class ConfigFlagService {
  private cache = new Map<string, { value: boolean; at: number }>();
  private readonly TTL_MS = 30_000;

  constructor(private readonly prisma: PrismaService) {}

  /** True iff the configuration row for `key` holds a truthy "enabled". */
  async isEnabled(key: string): Promise<boolean> {
    const hit = this.cache.get(key);
    const now = Date.now();
    if (hit && now - hit.at < this.TTL_MS) return hit.value;

    let value = false;
    try {
      const row = await this.prisma.configuration.findUnique({ where: { key } });
      value = this.coerce(row?.value);
    } catch {
      // A config read failure must never break allocation — fail closed (off).
      value = false;
    }
    this.cache.set(key, { value, at: now });
    return value;
  }

  /** Accepts `true`, `{ enabled: true }`, or `"true"` as enabled. */
  private coerce(raw: unknown): boolean {
    if (raw === true) return true;
    if (typeof raw === "string") return raw.toLowerCase() === "true";
    if (raw && typeof raw === "object" && "enabled" in raw) {
      return (raw as { enabled?: unknown }).enabled === true;
    }
    return false;
  }
}
