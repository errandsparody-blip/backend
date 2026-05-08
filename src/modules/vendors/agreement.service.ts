/**
 * AgreementService — single source of truth for "what's the current
 * agreement version?" Read once and cached briefly so we don't query
 * the configuration table on every request.
 *
 * The cache is intentionally tiny — we want a version bump in
 * /admin/config/policy to take effect within ~30s without requiring
 * a deploy. Operationally that's fast enough for a re-acceptance
 * rollout, and hot enough to remove the config row from the per-request
 * query budget for normal traffic.
 */

import { Injectable, InternalServerErrorException, Logger } from "@nestjs/common";

import { PrismaService } from "../../common/prisma.service";

const CACHE_TTL_MS = 30_000;

@Injectable()
export class AgreementService {
  private readonly logger = new Logger(AgreementService.name);
  private cached: { version: string; at: number } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns the current published agreement version. Throws an
   * InternalServerErrorException with a stable code if the row is missing
   * — same defensive pattern as `loadFeeSchedule()`.
   */
  async getCurrentVersion(): Promise<string> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < CACHE_TTL_MS) {
      return this.cached.version;
    }
    const row = await this.prisma.configuration.findUnique({
      where: { key: "agreement_version" },
    });
    if (!row) {
      throw new InternalServerErrorException({
        message: "Vendor agreement version is not configured on this environment.",
        code: "agreement_version_missing",
      });
    }
    // The seed stores it as a JSON string (e.g. "1.0"). Defensive coerce.
    const value = row.value as unknown;
    const version = typeof value === "string" ? value : String(value ?? "");
    if (!version || version === "null") {
      throw new InternalServerErrorException({
        message: "Vendor agreement version is empty.",
        code: "agreement_version_missing",
      });
    }
    this.cached = { version, at: now };
    return version;
  }

  /** Force-clear the cache. Called after the admin updates the version. */
  invalidate(): void {
    this.cached = null;
    this.logger.log("agreement_version cache invalidated");
  }
}
