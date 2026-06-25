/**
 * VendorApiKeyService — portal-side (JWT-authed) management of storefront
 * integration credentials and the per-vendor default shipping settings
 * (Migration 0038).
 *
 * Key lifecycle:
 *   create  → generates uer_live_<keyId>.<secret>, stores keyId + SHA-256(secret),
 *             returns the FULL key exactly once (never retrievable again).
 *   list    → public views only (keyId/display prefix, never the secret).
 *   revoke  → soft delete (revoked_at) so the audit trail survives.
 *
 * The secret is generated and hashed here (CryptoService is available); the
 * wire format lives in common/api-key.ts so the guard and this service agree.
 */

import { Injectable, NotFoundException } from "@nestjs/common";

import { apiKeyDisplayPrefix, formatApiKey } from "../../common/api-key";
import { CryptoService } from "../../common/crypto.service";
import { PrismaService } from "../../common/prisma.service";
import type { UpdateIntegrationSettingsInput } from "../../common/schemas/integration.schema";
import { AuditService } from "../audit/audit.service";

export interface PublicApiKey {
  id: string;
  name: string;
  /** Public, displayable prefix, e.g. "uer_live_ab12cd34ef56ab78". */
  displayPrefix: string;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface IntegrationSettings {
  defaultCarrierService: string | null;
  defaultInsurance: boolean;
  keys: PublicApiKey[];
}

@Injectable()
export class VendorApiKeyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  /** Create a key. Returns the full plaintext key ONCE plus the public view. */
  async createKey(
    vendorId: string,
    actorId: string,
    name: string,
  ): Promise<{ fullKey: string; key: PublicApiKey }> {
    const keyId = this.crypto.randomToken(8); // 16 hex chars
    const secret = this.crypto.randomToken(32); // 64 hex chars
    const secretHash = this.crypto.sha256(secret);

    const row = await this.prisma.vendorApiKey.create({
      data: { vendorId, name, keyId, secretHash, createdBy: actorId },
    });

    await this.audit.log({
      actorId,
      action: "integration.api_key.created",
      resourceType: "vendor_api_key",
      resourceId: row.id,
      afterState: { name, keyId },
    });

    return { fullKey: formatApiKey(keyId, secret), key: this.toPublic(row) };
  }

  async listKeys(vendorId: string): Promise<PublicApiKey[]> {
    const rows = await this.prisma.vendorApiKey.findMany({
      where: { vendorId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((r) => this.toPublic(r));
  }

  async revokeKey(vendorId: string, actorId: string, id: string): Promise<void> {
    // Scope the update to the vendor so one tenant can't revoke another's key.
    const result = await this.prisma.vendorApiKey.updateMany({
      where: { id, vendorId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) {
      throw new NotFoundException({
        message: "API key not found or already revoked.",
        code: "api_key_not_found",
      });
    }
    await this.audit.log({
      actorId,
      action: "integration.api_key.revoked",
      resourceType: "vendor_api_key",
      resourceId: id,
    });
  }

  async getSettings(vendorId: string): Promise<IntegrationSettings> {
    const vendor = await this.prisma.vendor.findUniqueOrThrow({
      where: { id: vendorId },
      select: {
        integrationDefaultCarrierService: true,
        integrationDefaultInsurance: true,
      },
    });
    return {
      defaultCarrierService: vendor.integrationDefaultCarrierService,
      defaultInsurance: vendor.integrationDefaultInsurance,
      keys: await this.listKeys(vendorId),
    };
  }

  async updateSettings(
    vendorId: string,
    actorId: string,
    input: UpdateIntegrationSettingsInput,
  ): Promise<IntegrationSettings> {
    const data: {
      integrationDefaultCarrierService?: string | null;
      integrationDefaultInsurance?: boolean;
    } = {};
    if (input.defaultCarrierService !== undefined) {
      // Normalize the "cheapest" sentinel / empty to null.
      const v = input.defaultCarrierService;
      data.integrationDefaultCarrierService =
        !v || v.toUpperCase() === "CHEAPEST" ? null : v;
    }
    if (input.defaultInsurance !== undefined) {
      data.integrationDefaultInsurance = input.defaultInsurance;
    }
    await this.prisma.vendor.update({ where: { id: vendorId }, data });
    await this.audit.log({
      actorId,
      action: "integration.settings.updated",
      resourceType: "vendor",
      resourceId: vendorId,
      afterState: data,
    });
    return this.getSettings(vendorId);
  }

  private toPublic(row: {
    id: string;
    name: string;
    keyId: string;
    lastUsedAt: Date | null;
    revokedAt: Date | null;
    createdAt: Date;
  }): PublicApiKey {
    return {
      id: row.id,
      name: row.name,
      displayPrefix: apiKeyDisplayPrefix(row.keyId),
      lastUsedAt: row.lastUsedAt,
      revokedAt: row.revokedAt,
      createdAt: row.createdAt,
    };
  }
}
