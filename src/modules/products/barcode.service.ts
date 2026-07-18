/**
 * BarcodeService — Migration 0044.
 *
 * Product-barcode registration and lookup. A barcode maps globally to
 * exactly one product; the DB unique constraint is the authoritative
 * guard, we just translate the constraint violation into a friendly
 * 409 (`barcode_taken`).
 *
 * SRP: this service owns ONLY the barcode catalog. It does not decide
 * which barcodes belong to which orders (that's the pack service).
 *
 * SECURITY / correctness
 *   * `register` validates the barcode against `BARCODE_RE` (printable
 *     ASCII, ≤ 48 chars) before Prisma. Same rule as the DB CHECK
 *     constraint — belt and braces.
 *   * `register` in a transaction: if `isPrimary=true`, demote any
 *     existing primary for the product first, then insert. The
 *     partial-unique index on (product_id) WHERE is_primary would
 *     otherwise reject a second primary; we make sure the demote
 *     happens first.
 *   * `remove` requires the caller to specify the barcode id (not
 *     the raw barcode string), preventing the barcode-string from
 *     acting as a lookup key across tenant boundaries.
 *   * `lookup` returns { productId, vendorId, ... } so a downstream
 *     tenant guard can verify the barcode belongs to the vendor
 *     whose order is being packed.
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { PrismaService } from "../../common/prisma.service";

// ---------------------------------------------------------------------------

export const BARCODE_SYMBOLOGIES = [
  "EAN13",
  "UPC_A",
  "CODE128",
  "GTIN14",
  "OTHER",
] as const;
export type BarcodeSymbology = (typeof BARCODE_SYMBOLOGIES)[number];

// Printable ASCII, 1..48. Rejects any whitespace / control character
// so a paste from a rich-text source can't sneak invisible chars in.
const BARCODE_RE = /^[!-~]{1,48}$/;

export interface RegisterBarcodeInput {
  barcode: string;
  symbology?: BarcodeSymbology | undefined;
  isPrimary?: boolean | undefined;
}

export interface PublicBarcode {
  id: string;
  productId: string;
  barcode: string;
  symbology: BarcodeSymbology;
  isPrimary: boolean;
  createdAt: string;
}

export interface BarcodeLookupResult {
  barcodeId: string;
  productId: string;
  vendorId: string;
  productName: string;
  productCode: string;
  variant: string;
  symbology: BarcodeSymbology;
  /**
   * Set only when the lookup fell through to a SKU-ID match (tier 2 —
   * Avery-printed labels). Null when the match came from the
   * product_barcodes table (tier 1 — retail UPC/EAN registered by a
   * super admin) because a single product-barcode row can cover
   * multiple SKUs (different variants of the same product).
   *
   * The pack scanner uses this to match at the SKU level per the v2
   * spec ("Match the barcode to an expected SKU"). When null, it
   * falls back to product-level matching.
   */
  skuId: string | null;
}

// ---------------------------------------------------------------------------

@Injectable()
export class BarcodeService {
  constructor(private readonly prisma: PrismaService) {}

  // =========================================================================
  // Reads
  // =========================================================================

  async listForProduct(productId: string): Promise<PublicBarcode[]> {
    const rows = await this.prismaAny().productBarcode.findMany({
      where: { productId },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    });
    return rows.map(toPublic);
  }

  async lookup(barcode: string): Promise<BarcodeLookupResult | null> {
    const cleaned = this.normalise(barcode);
    if (cleaned === null) return null;
    // Tier 1 — registered product_barcodes lookup (retail UPC/EAN/GTIN
    // deliberately typed in by super-admin on the product page).
    const row = await this.prismaAny().productBarcode.findUnique({
      where: { barcode: cleaned },
      include: { product: true },
    });
    if (row) {
      return {
        barcodeId: row.id,
        productId: row.productId,
        vendorId: row.product.vendorId,
        productName: row.product.name,
        productCode: row.product.code,
        variant: row.product.variant,
        symbology: row.symbology,
        skuId: null,
      };
    }

    // Tier 2 — fall through to SKU-ID match. The warehouse prints Avery
    // labels from /admin/inventory/[skuId]/label that encode the SKU
    // ID (e.g. `UER-AA571B-BIKINI-STD`) as CODE128. That printed label
    // IS the barcode for private-label / no-manufacturer-barcode
    // inventory; no separate registration is required. If the scan
    // matches a SKU id verbatim, synthesise the same lookup shape so
    // downstream consumers (pack scanner) don't need to know which
    // tier resolved it.
    //
    // SRP note: BarcodeService remains the single lookup surface. The
    // pack service, PSN receive, and any future consumer all call
    // this one method and get a uniform response.
    const sku = await this.prisma.sku.findUnique({
      where: { id: cleaned },
      include: {
        product: {
          select: {
            vendorId: true,
            name: true,
            code: true,
            variant: true,
          },
        },
      },
    });
    if (sku) {
      return {
        // No product_barcode row exists — barcodeId is the SKU id itself
        // for traceability. Consumers should treat this as opaque.
        barcodeId: sku.id,
        productId: sku.productId,
        vendorId: sku.product.vendorId,
        productName: sku.product.name,
        productCode: sku.product.code,
        variant: sku.variant ?? sku.product.variant,
        symbology: "CODE128",
        skuId: sku.id,
      };
    }

    return null;
  }

  // =========================================================================
  // Writes
  // =========================================================================

  async register(
    productId: string,
    actorId: string,
    input: RegisterBarcodeInput,
  ): Promise<PublicBarcode> {
    const cleaned = this.normalise(input.barcode);
    if (cleaned === null) {
      throw new BadRequestException({
        message: "barcode must be printable ASCII, 1..48 characters.",
        code: "invalid_input",
      });
    }
    const symbology = input.symbology ?? "OTHER";
    if (!BARCODE_SYMBOLOGIES.includes(symbology)) {
      throw new BadRequestException({
        message: `symbology must be one of ${BARCODE_SYMBOLOGIES.join(", ")}.`,
        code: "invalid_input",
      });
    }
    // Confirm the product exists first — Prisma's FK violation gives
    // a P2003 that's harder to translate cleanly than a pre-flight read.
    const productExists = await this.prisma.product.findFirst({
      where: { id: productId },
      select: { id: true },
    });
    if (!productExists) throw new NotFoundException();

    try {
      // Transaction: demote any existing primary before insert when the
      // caller asks for isPrimary=true, so the partial unique index on
      // (product_id) WHERE is_primary can't reject the insert.
      const row = await this.prisma.$transaction(async (tx) => {
        const txAny = tx as unknown as {
          productBarcode: {
            updateMany: (args: {
              where: { productId: string; isPrimary: boolean };
              data: { isPrimary: boolean };
            }) => Promise<{ count: number }>;
            create: (args: {
              data: {
                productId: string;
                barcode: string;
                symbology: BarcodeSymbology;
                isPrimary: boolean;
                createdBy: string;
              };
            }) => Promise<{
              id: string;
              productId: string;
              barcode: string;
              symbology: BarcodeSymbology;
              isPrimary: boolean;
              createdAt: Date;
            }>;
          };
        };
        if (input.isPrimary === true) {
          await txAny.productBarcode.updateMany({
            where: { productId, isPrimary: true },
            data: { isPrimary: false },
          });
        }
        return txAny.productBarcode.create({
          data: {
            productId,
            barcode: cleaned,
            symbology,
            isPrimary: input.isPrimary === true,
            createdBy: actorId,
          },
        });
      });
      return toPublic(row);
    } catch (err) {
      throw this.reformatUnique(err, cleaned);
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await this.prismaAny().productBarcode.delete({ where: { id } });
    } catch (err) {
      if (this.isRecordNotFound(err)) throw new NotFoundException();
      throw err;
    }
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  private normalise(barcode: string | undefined): string | null {
    if (typeof barcode !== "string") return null;
    const trimmed = barcode.trim();
    if (!BARCODE_RE.test(trimmed)) return null;
    return trimmed;
  }

  private reformatUnique(err: unknown, code: string): unknown {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "P2002"
    ) {
      return new ConflictException({
        message: `The barcode "${code}" is already registered to another product.`,
        code: "barcode_taken",
      });
    }
    return err;
  }

  private isRecordNotFound(err: unknown): boolean {
    return (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "P2025"
    );
  }

  private prismaAny(): {
    productBarcode: {
      findMany: (args: unknown) => Promise<
        Array<{
          id: string;
          productId: string;
          barcode: string;
          symbology: BarcodeSymbology;
          isPrimary: boolean;
          createdAt: Date;
        }>
      >;
      findUnique: (args: unknown) => Promise<null | {
        id: string;
        productId: string;
        barcode: string;
        symbology: BarcodeSymbology;
        isPrimary: boolean;
        createdAt: Date;
        product: {
          vendorId: string;
          name: string;
          code: string;
          variant: string;
        };
      }>;
      delete: (args: { where: { id: string } }) => Promise<unknown>;
    };
  } {
    return this.prisma as unknown as ReturnType<BarcodeService["prismaAny"]>;
  }
}

// ---------------------------------------------------------------------------

function toPublic(row: {
  id: string;
  productId: string;
  barcode: string;
  symbology: BarcodeSymbology;
  isPrimary: boolean;
  createdAt: Date | string;
}): PublicBarcode {
  return {
    id: row.id,
    productId: row.productId,
    barcode: row.barcode,
    symbology: row.symbology,
    isPrimary: row.isPrimary,
    createdAt:
      typeof row.createdAt === "string"
        ? row.createdAt
        : row.createdAt.toISOString(),
  };
}

// Re-export for tests that need to reference the constraint set
// without pulling in the whole service. The Prisma type used above
// is intentionally not exported — the service owns the schema shape.
export { BARCODE_RE };
export type { Prisma };
