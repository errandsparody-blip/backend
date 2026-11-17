/**
 * ClientErrorService — persists + reads vendor-facing client error telemetry.
 *
 * Written with raw SQL on purpose: the generated Prisma client may lag the
 * `client_error_logs` model (sandbox can't regenerate), so we never depend on
 * `prisma.clientErrorLog`. Treated as untrusted input — values are length-
 * capped by the Zod schema before they arrive here.
 */

import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { PrismaService } from "../../common/prisma.service";

export interface RecordClientErrorInput {
  userId: string | null;
  vendorId: string | null;
  role: string | null;
  kind: string;
  message: string;
  code: string | null;
  statusCode: number | null;
  path: string | null;
  stack: string | null;
  context: unknown;
  userAgent: string | null;
}

export interface ClientErrorRow {
  id: string;
  user_id: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  user_email: string | null;
  role: string | null;
  kind: string;
  message: string;
  code: string | null;
  status_code: number | null;
  path: string | null;
  user_agent: string | null;
  created_at: Date;
}

@Injectable()
export class ClientErrorService {
  private readonly logger = new Logger(ClientErrorService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Insert one telemetry row. Best-effort — never throws into the request. */
  async record(input: RecordClientErrorInput): Promise<void> {
    try {
      const contextJson =
        input.context == null ? null : JSON.stringify(input.context).slice(0, 8000);
      await this.prisma.$executeRaw(Prisma.sql`
        INSERT INTO client_error_logs
          (user_id, vendor_id, role, kind, message, code, status_code, path, stack, context, user_agent)
        VALUES (
          ${input.userId}::uuid,
          ${input.vendorId}::uuid,
          ${input.role},
          ${input.kind},
          ${input.message},
          ${input.code},
          ${input.statusCode},
          ${input.path},
          ${input.stack},
          ${contextJson}::jsonb,
          ${input.userAgent}
        )
      `);
    } catch (err) {
      // Telemetry must never break the app. Log and move on.
      this.logger.warn({ err: `${err}` }, "Failed to record client error");
    }
  }

  /**
   * List recent client errors for the super-admin viewer. Optional filters by
   * vendor and kind. Keyset-paginated on created_at (descending) via an
   * optional `before` ISO timestamp cursor.
   */
  async list(input: {
    vendorId?: string;
    kind?: string;
    before?: string;
    limit: number;
  }): Promise<{ items: ClientErrorRow[]; nextBefore: string | null }> {
    const vendorId = input.vendorId ?? null;
    const kind = input.kind ?? null;
    const before = input.before ? new Date(input.before) : null;
    const rows = await this.prisma.$queryRaw<ClientErrorRow[]>(Prisma.sql`
      SELECT e.id, e.user_id, e.vendor_id, e.role, e.kind, e.message, e.code,
             e.status_code, e.path, e.user_agent, e.created_at,
             v.business_name AS vendor_name, u.email AS user_email
      FROM client_error_logs e
      LEFT JOIN vendors v ON v.id = e.vendor_id
      LEFT JOIN users u ON u.id = e.user_id
      WHERE (${vendorId}::uuid IS NULL OR e.vendor_id = ${vendorId}::uuid)
        AND (${kind}::text IS NULL OR e.kind = ${kind})
        AND (${before}::timestamp IS NULL OR e.created_at < ${before})
      ORDER BY e.created_at DESC
      LIMIT ${input.limit + 1}
    `);
    let nextBefore: string | null = null;
    if (rows.length > input.limit) {
      const extra = rows.pop();
      nextBefore = extra ? rows[rows.length - 1]!.created_at.toISOString() : null;
    }
    return { items: rows, nextBefore };
  }
}
