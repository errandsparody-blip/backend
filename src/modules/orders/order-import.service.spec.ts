/**
 * OrderImportService — CSV parser tests.
 *
 * Only the pure-function surface of the service is exercised here
 * (`parseCsv` — no DB touch). The row-to-create + job orchestration
 * paths are covered end-to-end by an integration test that spins
 * up the real OrderService dependency.
 */

import { BadRequestException } from "@nestjs/common";

import type { PrismaService } from "../../common/prisma.service";

import { OrderImportService } from "./order-import.service";
import type { OrderService } from "./order.service";

describe("OrderImportService.parseCsv", () => {
  let svc: OrderImportService;

  beforeEach(() => {
    // Minimal fakes — parseCsv doesn't touch either dependency, but the
    // constructor asks for them.
    svc = new OrderImportService(
      {} as unknown as PrismaService,
      {} as unknown as OrderService,
    );
  });

  const HEADER =
    "external_reference,recipient_name,recipient_email,recipient_phone," +
    "ship_address_line1,ship_address_line2,ship_city,ship_state,ship_postal_code,ship_country," +
    "sku_id,quantity";

  it("parses a simple valid CSV", () => {
    const csv =
      HEADER +
      "\n" +
      "ORD-1,Jane Doe,jane@example.com,3055551212,123 Main St,,Miami,FL,33101,US,UER-VA-T-STD,1";
    const rows = svc.parseCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      external_reference: "ORD-1",
      recipient_name: "Jane Doe",
      sku_id: "UER-VA-T-STD",
      quantity: "1",
    });
  });

  it("strips a leading UTF-8 BOM", () => {
    const csv =
      "﻿" +
      HEADER +
      "\n" +
      "ORD-1,Jane,jane@example.com,,123 Main,,Miami,FL,33101,US,SKU,1";
    const rows = svc.parseCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.external_reference).toBe("ORD-1");
  });

  it("supports quoted cells with commas and escaped double-quotes", () => {
    // recipient_name has a literal comma; ship_address_line1 has an
    // escaped double-quote (RFC 4180: "" → ").
    const row =
      'ORD-1,"Doe, Jane",jane@example.com,,"123 ""Main"" St",,Miami,FL,33101,US,SKU,1';
    const rows = svc.parseCsv(HEADER + "\n" + row);
    expect(rows[0]!.recipient_name).toBe("Doe, Jane");
    expect(rows[0]!.ship_address_line1).toBe('123 "Main" St');
  });

  it("skips blank lines", () => {
    const csv =
      HEADER +
      "\n" +
      "ORD-1,Jane,jane@example.com,,123 Main,,Miami,FL,33101,US,SKU,1\n" +
      "\n" +
      "ORD-2,John,john@example.com,,124 Main,,Miami,FL,33101,US,SKU,2";
    const rows = svc.parseCsv(csv);
    expect(rows).toHaveLength(2);
  });

  it("rejects a CSV missing a required header", () => {
    const bad = HEADER.replace(",quantity", "");
    expect(() =>
      svc.parseCsv(bad + "\n" + "ORD-1,Jane,,,,,,,,US,SKU"),
    ).toThrow(BadRequestException);
  });

  it("rejects a CSV containing an unknown header", () => {
    const bad = HEADER + ",extra_column";
    expect(() =>
      svc.parseCsv(
        bad +
          "\n" +
          "ORD-1,Jane,,,123 Main,,Miami,FL,33101,US,SKU,1,huh",
      ),
    ).toThrow(BadRequestException);
  });

  it("rejects a data row whose column count doesn't match the header", () => {
    const csv = HEADER + "\n" + "ORD-1,Jane,,,Miami,FL,33101,US,SKU,1"; // short
    expect(() => svc.parseCsv(csv)).toThrow(BadRequestException);
  });

  it("rejects a cell exceeding IMPORT_MAX_CELL_LEN", () => {
    const long = "X".repeat(501);
    const csv =
      HEADER +
      "\n" +
      `ORD-1,Jane,,,${long},,Miami,FL,33101,US,SKU,1`;
    expect(() => svc.parseCsv(csv)).toThrow(BadRequestException);
  });

  it("rejects a CSV with too many rows", () => {
    const one = "ORD-1,Jane,,,123 Main,,Miami,FL,33101,US,SKU,1";
    // 501 data rows → over cap.
    const body = Array.from({ length: 501 }, () => one).join("\n");
    expect(() => svc.parseCsv(HEADER + "\n" + body)).toThrow(BadRequestException);
  });

  it("returns [] when no rows follow the header", () => {
    expect(svc.parseCsv(HEADER + "\n")).toEqual([]);
  });

  it("returns [] on a fully empty input", () => {
    expect(svc.parseCsv("")).toEqual([]);
  });
});
