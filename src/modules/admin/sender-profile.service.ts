/**
 * SenderProfileService — USA + Canada (migration 0082).
 *
 * Manages Shippo "ship from" sender profiles (one per operational admin, plus a
 * "DEFAULT"), and resolves the right one for an order at label time:
 *   order.processingUserId's profile → DEFAULT profile → (caller falls back to
 *   the env warehouse address).
 *
 * Raw SQL throughout because the `shippo_sender_profiles` table is regenerated
 * into the Prisma client only on deploy.
 */

import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { PrismaService } from "../../common/prisma.service";
import type { SenderOverride } from "../integrations/shippo/shippo.service";
import { AuditService } from "../audit/audit.service";

export interface SenderProfile {
  key: string;
  label: string;
  name: string;
  phone: string;
  email: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

const DEFAULT_KEY = "DEFAULT";

@Injectable()
export class SenderProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<SenderProfile[]> {
    const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT key, label, name, phone, email, line1, line2, city, state, postal_code, country
      FROM shippo_sender_profiles ORDER BY (key = 'DEFAULT') DESC, label ASC
    `);
    return rows.map((r) => this.toProfile(r));
  }

  /** Upsert a profile by key (admin user id, or "DEFAULT"). */
  async upsert(actorId: string, input: SenderProfile): Promise<SenderProfile> {
    await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO shippo_sender_profiles
        (key, label, name, phone, email, line1, line2, city, state, postal_code, country)
      VALUES (${input.key}, ${input.label}, ${input.name}, ${input.phone}, ${input.email},
              ${input.line1}, ${input.line2 ?? null}, ${input.city}, ${input.state},
              ${input.postalCode}, ${input.country})
      ON CONFLICT (key) DO UPDATE SET
        label = EXCLUDED.label, name = EXCLUDED.name, phone = EXCLUDED.phone,
        email = EXCLUDED.email, line1 = EXCLUDED.line1, line2 = EXCLUDED.line2,
        city = EXCLUDED.city, state = EXCLUDED.state, postal_code = EXCLUDED.postal_code,
        country = EXCLUDED.country, updated_at = CURRENT_TIMESTAMP
    `);
    await this.audit.log({
      actorId,
      action: "shippo.sender_profile_set",
      resourceType: "shippo_sender_profile",
      resourceId: input.key,
      afterState: { label: input.label, name: input.name, country: input.country },
    });
    return input;
  }

  async remove(actorId: string, key: string): Promise<void> {
    await this.prisma.$executeRaw(
      Prisma.sql`DELETE FROM shippo_sender_profiles WHERE key = ${key}`,
    );
    await this.audit.log({
      actorId,
      action: "shippo.sender_profile_removed",
      resourceType: "shippo_sender_profile",
      resourceId: key,
    });
  }

  /**
   * Resolve the ship-from override for an order: the processing admin's profile
   * if present, else the DEFAULT profile, else undefined (caller uses the env
   * warehouse address). Never throws — a lookup failure just falls back.
   */
  async resolveForOrder(orderId: string): Promise<SenderOverride | undefined> {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ processing_user_id: string | null }>>(
        Prisma.sql`SELECT processing_user_id FROM orders WHERE id = ${orderId}::uuid`,
      );
      const processingUserId = rows[0]?.processing_user_id ?? null;
      const keys = processingUserId ? [processingUserId, DEFAULT_KEY] : [DEFAULT_KEY];
      const profiles = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT key, label, name, phone, email, line1, line2, city, state, postal_code, country
        FROM shippo_sender_profiles WHERE key IN (${Prisma.join(keys)})
      `);
      if (profiles.length === 0) return undefined;
      // Prefer the processing admin's profile over DEFAULT.
      const byKey = new Map(profiles.map((p) => [String(p.key), this.toProfile(p)]));
      const chosen =
        (processingUserId ? byKey.get(processingUserId) : undefined) ?? byKey.get(DEFAULT_KEY);
      if (!chosen) return undefined;
      return {
        name: chosen.name,
        street1: chosen.line1,
        street2: chosen.line2 ?? undefined,
        city: chosen.city,
        state: chosen.state,
        zip: chosen.postalCode,
        country: chosen.country,
        phone: chosen.phone,
        email: chosen.email,
      };
    } catch {
      return undefined;
    }
  }

  private toProfile(r: Record<string, unknown>): SenderProfile {
    return {
      key: String(r.key),
      label: String(r.label),
      name: String(r.name),
      phone: String(r.phone),
      email: String(r.email),
      line1: String(r.line1),
      line2: (r.line2 as string | null) ?? null,
      city: String(r.city),
      state: String(r.state),
      postalCode: String(r.postal_code),
      country: String(r.country),
    };
  }
}
