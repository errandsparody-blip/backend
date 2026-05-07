/**
 * RFC 4180 CSV utilities.
 *
 * Goals:
 *   - Quote any field that contains a comma, double-quote, CR, or LF.
 *   - Escape embedded double-quotes by doubling them.
 *   - **Defang formula injection** (CSV injection / "Excel macro" attack) by
 *     prefixing any cell that starts with `=`, `+`, `-`, `@`, TAB, or CR with
 *     a single quote. OWASP CSV-Injection-cheatsheet.
 *
 * Usage: `streamCsv(res, header, rowsAsyncIterable)` writes rows lazily; the
 * server never buffers more than one row at a time. The HTTP layer sets the
 * filename + Content-Type before calling.
 */

import type { Response } from "express";

const FORMULA_TRIGGERS = /^[\t\r=+\-@]/;

export function csvEscape(input: unknown): string {
  if (input === null || input === undefined) return "";
  let v = typeof input === "string" ? input : String(input);

  // Defang formulas. Only do this on strings — pure numeric values that we
  // converted via String() would never start with one of the trigger chars.
  if (typeof input === "string" && v.length > 0 && FORMULA_TRIGGERS.test(v[0]!)) {
    v = `'${v}`;
  }

  if (/[",\r\n]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

export function csvRow(cells: readonly unknown[]): string {
  return cells.map(csvEscape).join(",") + "\r\n";
}

/**
 * Stream a CSV response. Buffers nothing beyond one row. Caller must already
 * have set Content-Type / Content-Disposition.
 */
export async function streamCsv(
  res: Response,
  header: readonly string[],
  rows: AsyncIterable<readonly unknown[]>,
): Promise<void> {
  res.write(csvRow(header));
  for await (const row of rows) {
    res.write(csvRow(row));
  }
  res.end();
}

export function csvHeaders(filename: string): Record<string, string> {
  // Ensure the filename is safe for the Content-Disposition header.
  const safe = filename.replace(/[^A-Za-z0-9._\-]/g, "_");
  return {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${safe}"`,
    // Hint to spreadsheet apps that the file is a UTF-8 CSV.
    "Cache-Control": "no-store",
  };
}
