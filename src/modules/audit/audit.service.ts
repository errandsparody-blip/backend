/**
 * AuditService — every privileged or financial action goes through here.
 * Append-only at both the DB privilege level (migration 0002) and the
 * application level (no update/delete methods exist).
 *
 * Implementation Plan §4.7.
 */

import { Injectable, Logger } from "@nestjs/common";
import type { Prisma, Role } from "@prisma/client";

import { PrismaService } from "../../common/prisma.service";

export interface AuditEntry {
  actorId?: string | null;
  actorRole?: Role | null;
  onBehalfOfVendorId?: string | null;
  sourceIp?: string | null | undefined;
  userAgent?: string | null | undefined;
  correlationId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  beforeState?: Prisma.InputJsonValue | null;
  afterState?: Prisma.InputJsonValue | null;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Write an audit entry. Failures are logged but never thrown — losing an
   * audit write must not break the calling business operation. The retention
   * job + nightly reconciliation catch any anomalies.
   */
  async log(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLogEntry.create({
        data: {
          actorId: entry.actorId ?? null,
          actorRole: entry.actorRole ?? null,
          onBehalfOfVendorId: entry.onBehalfOfVendorId ?? null,
          sourceIp: entry.sourceIp ?? null,
          userAgent: entry.userAgent ?? null,
          correlationId: entry.correlationId ?? null,
          action: entry.action,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId ?? null,
          beforeState: entry.beforeState ?? undefined,
          afterState: entry.afterState ?? undefined,
        },
      });
    } catch (err) {
      this.logger.error(
        { err, entry: { action: entry.action, resourceType: entry.resourceType } },
        "Audit write failed",
      );
    }
  }
}
