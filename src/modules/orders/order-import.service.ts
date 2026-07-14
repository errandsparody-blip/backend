/**
 * OrderImportService — vendor CSV bulk import (Migration 0046).
 *
 * Parses a CSV upload from the vendor dashboard, validates each row
 * against a strict header schema, and creates an order per row via
 * OrderService.create (so the v1 vs v2 branch, wallet-cover check,
 * shipping-points guard etc. all run identically to the wizard path).
 *
 * SOLID:
 *   * SRP — this service owns ONLY CSV parsing and job orchestration.
 *     Order creation is delegated to OrderService; error translation
 *     to the audit log; user attribution to the caller.
 *   * DIP — OrderService is injected via DI, not imported statically,
 *     so a future job-worker could swap in a queued variant without
 *     changing this file.
 *   * OCP — the header schema is a single `HEADER_SPEC` constant;
 *     adding a column is one line here and one line in the vendor UI.
 *
 * SECURITY / hardening:
 *   * The parser is CSV-only (RFC 4180 subset — quoted fields, escaped
 *     double-quotes, no line breaks inside cells). No formula injection
 *     risk on the read side; on the *write* side, cell values are
 *     never handed to a spreadsheet — they go into DB columns.
 *   * Hard limits: MAX_BYTES (2 MB), MAX_ROWS (500), MAX_CELL (500).
 *     Prevents a malicious paste from OOM-ing the process.
 *   * All fields are trimmed. Empty strings collapse to undefined
 *     (or "" for optional external references). No BOM leaks — the
 *     parser strips a leading UTF-8 BOM.
 *   * Row processing is per-row transactional through OrderService;
 *     a mid-file failure doesn't roll back earlier rows and never
 *     partially commits a single row (OrderService's own transaction
 *     guarantee).
 *   * error payload is capped at MAX_ERRORS (100) so a fully-failed
 *     500-row file doesn't produce a huge JSONB row.
 */

import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import type { CreateOrderInput } from "../../common/schemas/order.schema";
import { PrismaService } from "../../common/prisma.service";

import { OrderService } from "./order.service";

// ---------------------------------------------------------------------------
// Bounds — sized so a malicious client can't OOM the process. These
// are the AUTHORITATIVE limits; the controller validates the wire
// payload against them BEFORE handing off, and the parser re-asserts
// during read so a wrapping layer that forgets the check can't slip
// oversize data past.
// ---------------------------------------------------------------------------

export const IMPORT_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
export const IMPORT_MAX_ROWS = 500;
export const IMPORT_MAX_CELL_LEN = 500;
export const IMPORT_MAX_ERRORS = 100;

// ---------------------------------------------------------------------------
// CSV header contract. The vendor dashboard downloads a template that
// mirrors this list exactly. Adding a column here plus one line in the
// template generator is the only change needed for a new field.
// ---------------------------------------------------------------------------

export const HEADER_SPEC = [
  "external_reference",
  "recipient_name",
  "recipient_email",
  "recipient_phone",
  "ship_address_line1",
  "ship_address_line2",
  "ship_city",
  "ship_state",
  "ship_postal_code",
  "ship_country",
  "sku_id",
  "quantity",
] as const;
export type HeaderKey = (typeof HEADER_SPEC)[number];

// ---------------------------------------------------------------------------

export interface RowResult {
  row: number;
  status: "success" | "error";
  orderId?: string;
  message?: string;
}

export interface JobSummary {
  id: string;
  vendorId: string;
  status: "PROCESSING" | "COMPLETED" | "FAILED";
  sourceFilename: string;
  rowCount: number;
  successCount: number;
  errorCount: number;
  errors: Array<{ row: number; message: string }>;
  createdAt: string;
  completedAt: string | null;
}

// ---------------------------------------------------------------------------

@Injectable()
export class OrderImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrderService,
  ) {}

  // =========================================================================
  // Reads
  // =========================================================================

  async listForVendor(vendorId: string, limit = 50): Promise<JobSummary[]> {
    const rows = await this.prismaAny().orderImportJob.findMany({
      where: { vendorId },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(limit, 1), 100),
    });
    return rows.map((r) => this.toSummary(r));
  }

  async getForVendor(vendorId: string, jobId: string): Promise<JobSummary> {
    const row = await this.prismaAny().orderImportJob.findFirst({
      where: { id: jobId, vendorId },
    });
    if (!row) throw new NotFoundException();
    return this.toSummary(row);
  }

  // =========================================================================
  // Write — process a full CSV upload synchronously.
  //
  // The API-key ingest path (`/v1/integration/orders`) accepts one order
  // per HTTP call; this path batches up to IMPORT_MAX_ROWS orders in a
  // single request. We call OrderService.create per row so all the
  // wallet-cover / SKU-reserve semantics apply identically.
  // =========================================================================

  async importCsv(
    vendorId: string,
    actorId: string,
    input: {
      csv: string;
      sourceFilename: string;
    },
  ): Promise<{ jobId: string; results: RowResult[] } & Omit<JobSummary, "id">> {
    // Bounds check on raw payload — earliest possible reject.
    const filename = (input.sourceFilename ?? "").trim().slice(0, 200);
    if (filename.length === 0) {
      throw new BadRequestException({
        message: "sourceFilename is required.",
        code: "invalid_input",
      });
    }
    if (typeof input.csv !== "string") {
      throw new BadRequestException({
        message: "csv payload must be a string.",
        code: "invalid_input",
      });
    }
    // UTF-8 byte length — count of code units differs from character
    // count for non-ASCII payloads; use Buffer for an exact byte size.
    if (Buffer.byteLength(input.csv, "utf8") > IMPORT_MAX_BYTES) {
      throw new BadRequestException({
        message: `csv exceeds ${IMPORT_MAX_BYTES} bytes.`,
        code: "csv_too_large",
      });
    }

    const rows = this.parseCsv(input.csv);
    if (rows.length === 0) {
      throw new BadRequestException({
        message: "csv contains no data rows.",
        code: "csv_empty",
      });
    }

    // Create the job row up front so a mid-loop crash still surfaces
    // in the vendor's history. status stays PROCESSING until the
    // final update below.
    const job = await this.prismaAny().orderImportJob.create({
      data: {
        vendorId,
        sourceFilename: filename,
        rowCount: rows.length,
        createdBy: actorId,
      },
    });

    const results: RowResult[] = [];
    const errorEntries: Array<{ row: number; message: string }> = [];
    let successCount = 0;

    for (let i = 0; i < rows.length; i++) {
      const csvRowNumber = i + 2; // +1 for 1-indexed, +1 for header row
      try {
        const parsed = this.rowToCreateOrderInput(rows[i]!);
        const order = await this.orders.create(vendorId, actorId, parsed);
        results.push({
          row: csvRowNumber,
          status: "success",
          orderId: order.id,
        });
        successCount++;
      } catch (err) {
        const message = this.formatRowError(err);
        results.push({ row: csvRowNumber, status: "error", message });
        if (errorEntries.length < IMPORT_MAX_ERRORS) {
          errorEntries.push({ row: csvRowNumber, message });
        }
      }
    }

    const errorCount = rows.length - successCount;
    const status: JobSummary["status"] =
      errorCount === rows.length ? "FAILED" : "COMPLETED";

    const updated = await this.prismaAny().orderImportJob.update({
      where: { id: job.id },
      data: {
        status,
        successCount,
        errorCount,
        errors: errorEntries as unknown as Prisma.InputJsonValue,
        completedAt: new Date(),
      },
    });

    const summary = this.toSummary(updated);
    return { jobId: summary.id, results, ...summary };
  }

  // =========================================================================
  // Parsing — small, RFC 4180-subset CSV. Handles quoted fields, escaped
  // double-quotes, CRLF and LF line endings, and a leading UTF-8 BOM.
  // Rejects newlines inside quoted cells (we accept them but the row
  // will spill into the next line — for the vendor use-case, ship
  // addresses don't legitimately contain a newline anyway).
  // =========================================================================

  parseCsv(raw: string): Array<Record<HeaderKey, string>> {
    // Strip UTF-8 BOM if present.
    const stripped = raw.startsWith("﻿") ? raw.slice(1) : raw;
    const lines: string[] = [];
    // Line splitter — the ONLY reason we care about quotes here is
    // to know whether a newline sits INSIDE a quoted cell (in which
    // case it's part of the value, not a row terminator). We
    // preserve the raw byte stream verbatim so `splitCsvLine` does
    // the real dequoting downstream — two passes over the same
    // grammar would strip quotes twice, which was a real bug.
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < stripped.length; i++) {
      const ch = stripped[i];
      const next = stripped[i + 1];
      if (ch === '"') {
        if (inQuotes && next === '"') {
          // Escaped quote (RFC 4180: "" inside a quoted cell). Copy
          // both bytes through without flipping the state; the
          // per-line splitter will collapse them to a single ".
          current += '""';
          i++;
          continue;
        }
        inQuotes = !inQuotes;
        current += ch;
        continue;
      }
      if (!inQuotes && (ch === "\n" || ch === "\r")) {
        if (current.length > 0) lines.push(current);
        current = "";
        if (ch === "\r" && next === "\n") i++;
        continue;
      }
      current += ch;
    }
    if (current.length > 0) lines.push(current);

    if (lines.length === 0) return [];
    if (lines.length - 1 > IMPORT_MAX_ROWS) {
      throw new BadRequestException({
        message: `csv exceeds ${IMPORT_MAX_ROWS} data rows.`,
        code: "csv_too_many_rows",
      });
    }

    const header = this.splitCsvLine(lines[0]!).map((s) => s.trim().toLowerCase());
    // Header must include every expected column and no unknowns.
    for (const key of HEADER_SPEC) {
      if (!header.includes(key)) {
        throw new BadRequestException({
          message: `csv missing required header: ${key}`,
          code: "csv_header_missing",
        });
      }
    }
    for (const col of header) {
      if (!(HEADER_SPEC as readonly string[]).includes(col)) {
        throw new BadRequestException({
          message: `csv contains unknown header: ${col}`,
          code: "csv_header_unknown",
        });
      }
    }

    const out: Array<Record<HeaderKey, string>> = [];
    for (let i = 1; i < lines.length; i++) {
      const cells = this.splitCsvLine(lines[i]!);
      if (cells.every((c) => c.trim().length === 0)) continue; // blank row
      if (cells.length !== header.length) {
        throw new BadRequestException({
          message: `csv row ${i + 1}: expected ${header.length} columns, got ${cells.length}.`,
          code: "csv_row_column_mismatch",
        });
      }
      const record: Partial<Record<HeaderKey, string>> = {};
      for (let c = 0; c < header.length; c++) {
        const key = header[c] as HeaderKey;
        const value = cells[c] ?? "";
        if (value.length > IMPORT_MAX_CELL_LEN) {
          throw new BadRequestException({
            message: `csv row ${i + 1}, column ${key}: cell exceeds ${IMPORT_MAX_CELL_LEN} chars.`,
            code: "csv_cell_too_long",
          });
        }
        record[key] = value;
      }
      out.push(record as Record<HeaderKey, string>);
    }
    return out;
  }

  private splitCsvLine(line: string): string[] {
    const cells: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const next = line[i + 1];
      if (ch === '"') {
        if (inQuotes && next === '"') {
          current += '"';
          i++;
          continue;
        }
        inQuotes = !inQuotes;
        continue;
      }
      if (ch === "," && !inQuotes) {
        cells.push(current);
        current = "";
        continue;
      }
      current += ch;
    }
    cells.push(current);
    return cells;
  }

  // =========================================================================
  // Row → CreateOrderInput mapping. Delegates the actual per-row
  // validation to OrderService's Zod schemas; we just shape the CSV
  // into the wire format and let OrderService reject anything
  // malformed with a friendly error the vendor sees per-row.
  // =========================================================================

  private rowToCreateOrderInput(
    row: Record<HeaderKey, string>,
  ): CreateOrderInput {
    const quantityStr = row.quantity?.trim() ?? "";
    const quantity = Number(quantityStr);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new BadRequestException({
        message: `quantity must be a positive integer, got "${quantityStr}".`,
        code: "invalid_input",
      });
    }
    const skuId = row.sku_id?.trim() ?? "";
    if (skuId.length === 0) {
      throw new BadRequestException({
        message: "sku_id is required.",
        code: "invalid_input",
      });
    }

    const emptyToUndef = (s: string | undefined): string | undefined => {
      const t = (s ?? "").trim();
      return t.length === 0 ? undefined : t;
    };

    const country = emptyToUndef(row.ship_country) ?? "US";

    const input = {
      externalReference: emptyToUndef(row.external_reference),
      recipient: {
        recipientName: (row.recipient_name ?? "").trim(),
        recipientEmail: emptyToUndef(row.recipient_email),
        recipientPhone: emptyToUndef(row.recipient_phone),
        shipAddressLine1: (row.ship_address_line1 ?? "").trim(),
        shipAddressLine2: emptyToUndef(row.ship_address_line2),
        shipCity: (row.ship_city ?? "").trim(),
        shipState: (row.ship_state ?? "").trim().toUpperCase(),
        shipPostalCode: (row.ship_postal_code ?? "").trim(),
        shipCountry: country.toUpperCase(),
      },
      lines: [{ skuId, quantity }],
      insuranceRequested: false,
      // Fulfillment mode always PLATFORM_SHIP for CSV imports — the
      // vendor-carrier branch requires a label URL or tracking, which
      // isn't a natural fit for bulk paste. If a vendor needs that
      // branch they should keep using the wizard.
      fulfillmentMode: "PLATFORM_SHIP" as const,
    };
    return input as unknown as CreateOrderInput;
  }

  private formatRowError(err: unknown): string {
    if (typeof err !== "object" || err === null) return "Unknown error.";
    // NestJS HttpException carries a response we want to surface.
    const anyErr = err as {
      response?: { message?: string | string[]; code?: string };
      message?: string;
    };
    if (anyErr.response?.message) {
      return Array.isArray(anyErr.response.message)
        ? anyErr.response.message.join("; ")
        : anyErr.response.message;
    }
    if (anyErr.message) return anyErr.message;
    return "Unknown error.";
  }

  // =========================================================================
  // Serialisation helpers
  // =========================================================================

  private toSummary(row: {
    id: string;
    vendorId: string;
    status: JobSummary["status"];
    sourceFilename: string;
    rowCount: number;
    successCount: number;
    errorCount: number;
    errors: Prisma.JsonValue;
    createdAt: Date;
    completedAt: Date | null;
  }): JobSummary {
    const errors = Array.isArray(row.errors)
      ? (row.errors as Array<{ row: number; message: string }>)
      : [];
    return {
      id: row.id,
      vendorId: row.vendorId,
      status: row.status,
      sourceFilename: row.sourceFilename,
      rowCount: row.rowCount,
      successCount: row.successCount,
      errorCount: row.errorCount,
      errors,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
    };
  }

  /**
   * Prisma client hasn't been regenerated for orderImportJob in the
   * sandbox; cast so the code compiles. In CI (post `prisma generate`)
   * the delegate is present.
   */
  private prismaAny(): {
    orderImportJob: {
      findMany: (args: unknown) => Promise<
        Array<{
          id: string;
          vendorId: string;
          status: JobSummary["status"];
          sourceFilename: string;
          rowCount: number;
          successCount: number;
          errorCount: number;
          errors: Prisma.JsonValue;
          createdAt: Date;
          completedAt: Date | null;
        }>
      >;
      findFirst: (args: unknown) => Promise<null | {
        id: string;
        vendorId: string;
        status: JobSummary["status"];
        sourceFilename: string;
        rowCount: number;
        successCount: number;
        errorCount: number;
        errors: Prisma.JsonValue;
        createdAt: Date;
        completedAt: Date | null;
      }>;
      create: (args: {
        data: {
          vendorId: string;
          sourceFilename: string;
          rowCount: number;
          createdBy: string;
        };
      }) => Promise<{
        id: string;
        vendorId: string;
        status: JobSummary["status"];
        sourceFilename: string;
        rowCount: number;
        successCount: number;
        errorCount: number;
        errors: Prisma.JsonValue;
        createdAt: Date;
        completedAt: Date | null;
      }>;
      update: (args: {
        where: { id: string };
        data: {
          status: JobSummary["status"];
          successCount: number;
          errorCount: number;
          errors: Prisma.InputJsonValue;
          completedAt: Date;
        };
      }) => Promise<{
        id: string;
        vendorId: string;
        status: JobSummary["status"];
        sourceFilename: string;
        rowCount: number;
        successCount: number;
        errorCount: number;
        errors: Prisma.JsonValue;
        createdAt: Date;
        completedAt: Date | null;
      }>;
    };
  } {
    return this.prisma as unknown as ReturnType<
      OrderImportService["prismaAny"]
    >;
  }
}
