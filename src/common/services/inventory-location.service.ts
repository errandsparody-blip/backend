/**
 * InventoryLocationService — Migration 0045.
 *
 * Owns the warehouse-location catalog AND SKU-to-location assignment.
 *
 * SOLID / hardening notes:
 *   * SRP: this service NEVER touches inventory quantities or order
 *     rows. Callers that need to move stock still go through the
 *     inventory movement service.
 *   * DIP: only PrismaService is injected — no leakage of
 *     packing / order dependencies.
 *   * Cached list-active (5 s) mirrors the packaging-library pattern
 *     so the pack + PSN receive UIs get near-zero cost lookups.
 *   * Every mutation validates ranges and normalises `code` to
 *     UPPERCASE, matching the DB CHECK constraint (regex `[A-Z0-9-]`).
 *   * P2002 unique violations are rethrown as
 *     `ConflictException("location_code_taken")`; P2025 as `NotFoundException`.
 *   * `assignToSku(skuId, null)` unassigns — never throws on already-null.
 *   * SKU tenant guard lives at the caller (admin controllers only —
 *     no vendor-facing surface).
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Prisma } from "@prisma/client";

import { PrismaService } from "../prisma.service";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface InventoryLocation {
  id: string;
  code: string;
  label: string;
  aisle: string | null;
  bay: string | null;
  shelf: string | null;
  bin: string | null;
  isActive: boolean;
  sortOrder: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLocationInput {
  code: string;
  label: string;
  aisle?: string | undefined;
  bay?: string | undefined;
  shelf?: string | undefined;
  bin?: string | undefined;
  sortOrder?: number | undefined;
  notes?: string | undefined;
}

export interface UpdateLocationInput {
  label?: string;
  aisle?: string | null;
  bay?: string | null;
  shelf?: string | null;
  bin?: string | null;
  sortOrder?: number;
  notes?: string | null;
  isActive?: boolean;
}

export interface SkuLocationLookup {
  skuId: string;
  location: InventoryLocation | null;
}

// ---------------------------------------------------------------------------
// Bounds — kept in one place; mirror the DB CHECK constraints.
// ---------------------------------------------------------------------------

const CODE_RE = /^[A-Z0-9-]{2,32}$/;
const FIELD_MAX_LEN = 16;
const LABEL_MAX_LEN = 80;
const NOTES_MAX_LEN = 280;
const SORT_MAX = 10_000;

const CACHE_TTL_MS = 5_000;

// ---------------------------------------------------------------------------

@Injectable()
export class InventoryLocationService {
  private cache: { at: number; items: InventoryLocation[] } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  // =========================================================================
  // Reads
  // =========================================================================

  async listAll(): Promise<InventoryLocation[]> {
    const rows = await this.prismaAny().inventoryLocation.findMany({
      orderBy: [{ isActive: "desc" }, { sortOrder: "asc" }, { code: "asc" }],
    });
    return rows.map((r) => this.toPublic(r));
  }

  async listActive(): Promise<InventoryLocation[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < CACHE_TTL_MS) {
      return this.cache.items;
    }
    const rows = await this.prismaAny().inventoryLocation.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
    });
    const items = rows.map((r) => this.toPublic(r));
    this.cache = { at: now, items };
    return items;
  }

  async getById(id: string): Promise<InventoryLocation | null> {
    const row = await this.prismaAny().inventoryLocation.findUnique({
      where: { id },
    });
    return row ? this.toPublic(row) : null;
  }

  async getByCode(code: string): Promise<InventoryLocation | null> {
    const normalised = code.trim().toUpperCase();
    const row = await this.prismaAny().inventoryLocation.findUnique({
      where: { code: normalised },
    });
    return row ? this.toPublic(row) : null;
  }

  /** Resolve a SKU → its assigned location (or null). */
  async lookupForSku(skuId: string): Promise<SkuLocationLookup> {
    const sku = await this.prismaAny().sku.findUnique({
      where: { id: skuId },
      include: { location: true },
    });
    if (!sku) throw new NotFoundException();
    return {
      skuId,
      location: sku.location ? this.toPublic(sku.location) : null,
    };
  }

  // =========================================================================
  // Writes
  // =========================================================================

  async create(input: CreateLocationInput): Promise<InventoryLocation> {
    const code = this.validateCode(input.code);
    const label = this.validateLabel(input.label);
    const sort = this.validateSort(input.sortOrder ?? 100);
    const aisle = this.validateField("aisle", input.aisle);
    const bay = this.validateField("bay", input.bay);
    const shelf = this.validateField("shelf", input.shelf);
    const bin = this.validateField("bin", input.bin);
    const notes = this.validateNotes(input.notes);

    try {
      const row = await this.prismaAny().inventoryLocation.create({
        data: {
          code,
          label,
          aisle,
          bay,
          shelf,
          bin,
          sortOrder: sort,
          notes,
        },
      });
      this.cache = null;
      return this.toPublic(row);
    } catch (err) {
      throw this.reformatUnique(err, code);
    }
  }

  async update(
    id: string,
    input: UpdateLocationInput,
  ): Promise<InventoryLocation> {
    const patch: Record<string, unknown> = {};
    if (input.label !== undefined) patch.label = this.validateLabel(input.label);
    if (input.aisle !== undefined) patch.aisle = this.validateField("aisle", input.aisle);
    if (input.bay !== undefined) patch.bay = this.validateField("bay", input.bay);
    if (input.shelf !== undefined) patch.shelf = this.validateField("shelf", input.shelf);
    if (input.bin !== undefined) patch.bin = this.validateField("bin", input.bin);
    if (input.sortOrder !== undefined) patch.sortOrder = this.validateSort(input.sortOrder);
    if (input.notes !== undefined) patch.notes = this.validateNotes(input.notes);
    if (input.isActive !== undefined) patch.isActive = input.isActive;

    if (Object.keys(patch).length === 0) {
      throw new BadRequestException({
        message: "No fields to update.",
        code: "invalid_input",
      });
    }

    try {
      const row = await this.prismaAny().inventoryLocation.update({
        where: { id },
        data: patch,
      });
      this.cache = null;
      return this.toPublic(row);
    } catch (err) {
      if (this.isRecordNotFound(err)) throw new NotFoundException();
      throw err;
    }
  }

  async deactivate(id: string): Promise<InventoryLocation> {
    return this.update(id, { isActive: false });
  }
  async reactivate(id: string): Promise<InventoryLocation> {
    return this.update(id, { isActive: true });
  }

  /**
   * Assign a SKU to a location (or clear the assignment with locationId=null).
   *
   * Idempotent — assigning the same location is a no-op. Never throws
   * on already-null when clearing. Verifies both the SKU AND the
   * target location exist and (for non-null) that the location is
   * active. The DB FK would reject an unknown location, but the
   * friendly 404 saves the caller a round-trip.
   */
  async assignToSku(
    skuId: string,
    locationId: string | null,
  ): Promise<{ skuId: string; locationId: string | null }> {
    if (locationId !== null) {
      const target = await this.getById(locationId);
      if (!target) throw new NotFoundException();
      if (!target.isActive) {
        throw new BadRequestException({
          message: "Target location is inactive — reactivate it before assigning.",
          code: "location_inactive",
        });
      }
    }
    try {
      await this.prismaAny().sku.update({
        where: { id: skuId },
        data: { locationId },
      });
    } catch (err) {
      if (this.isRecordNotFound(err)) throw new NotFoundException();
      throw err;
    }
    return { skuId, locationId };
  }

  // =========================================================================
  // Validation
  // =========================================================================

  private validateCode(code: string): string {
    const normalised = (code ?? "").trim().toUpperCase();
    if (!CODE_RE.test(normalised)) {
      throw new BadRequestException({
        message: "code must match [A-Z0-9-]{2,32} (case-insensitive on input).",
        code: "invalid_input",
      });
    }
    return normalised;
  }
  private validateLabel(label: string): string {
    const trimmed = (label ?? "").trim();
    if (trimmed.length < 1 || trimmed.length > LABEL_MAX_LEN) {
      throw new BadRequestException({
        message: `label must be 1..${LABEL_MAX_LEN} characters.`,
        code: "invalid_input",
      });
    }
    return trimmed;
  }
  private validateField(name: string, value: string | null | undefined): string | null {
    if (value === undefined || value === null) return null;
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    if (trimmed.length > FIELD_MAX_LEN) {
      throw new BadRequestException({
        message: `${name} must be ${FIELD_MAX_LEN} characters or fewer.`,
        code: "invalid_input",
      });
    }
    return trimmed;
  }
  private validateSort(value: number): number {
    if (!Number.isInteger(value) || value < 0 || value > SORT_MAX) {
      throw new BadRequestException({
        message: `sortOrder must be an integer 0..${SORT_MAX}.`,
        code: "invalid_input",
      });
    }
    return value;
  }
  private validateNotes(value: string | null | undefined): string | null {
    if (value === undefined || value === null) return null;
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    if (trimmed.length > NOTES_MAX_LEN) {
      throw new BadRequestException({
        message: `notes must be ${NOTES_MAX_LEN} characters or fewer.`,
        code: "invalid_input",
      });
    }
    return trimmed;
  }

  // =========================================================================
  // Cast / error helpers
  // =========================================================================

  private reformatUnique(err: unknown, code: string): unknown {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "P2002"
    ) {
      return new ConflictException({
        message: `An inventory location with code "${code}" already exists.`,
        code: "location_code_taken",
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

  private toPublic(row: {
    id: string;
    code: string;
    label: string;
    aisle: string | null;
    bay: string | null;
    shelf: string | null;
    bin: string | null;
    isActive: boolean;
    sortOrder: number;
    notes: string | null;
    createdAt: Date | string;
    updatedAt: Date | string;
  }): InventoryLocation {
    return {
      id: row.id,
      code: row.code,
      label: row.label,
      aisle: row.aisle,
      bay: row.bay,
      shelf: row.shelf,
      bin: row.bin,
      isActive: row.isActive,
      sortOrder: row.sortOrder,
      notes: row.notes,
      createdAt:
        typeof row.createdAt === "string"
          ? row.createdAt
          : row.createdAt.toISOString(),
      updatedAt:
        typeof row.updatedAt === "string"
          ? row.updatedAt
          : row.updatedAt.toISOString(),
    };
  }

  /**
   * Prisma client hasn't been regenerated for the new inventoryLocation
   * delegate in the sandbox; cast so the code compiles. In CI (post
   * `prisma generate`) the property exists on the delegate.
   */
  private prismaAny(): {
    inventoryLocation: {
      findMany: (args: unknown) => Promise<
        Array<{
          id: string;
          code: string;
          label: string;
          aisle: string | null;
          bay: string | null;
          shelf: string | null;
          bin: string | null;
          isActive: boolean;
          sortOrder: number;
          notes: string | null;
          createdAt: Date | string;
          updatedAt: Date | string;
        }>
      >;
      findUnique: (args: unknown) => Promise<null | {
        id: string;
        code: string;
        label: string;
        aisle: string | null;
        bay: string | null;
        shelf: string | null;
        bin: string | null;
        isActive: boolean;
        sortOrder: number;
        notes: string | null;
        createdAt: Date | string;
        updatedAt: Date | string;
      }>;
      create: (args: {
        data: {
          code: string;
          label: string;
          aisle: string | null;
          bay: string | null;
          shelf: string | null;
          bin: string | null;
          sortOrder: number;
          notes: string | null;
        };
      }) => Promise<{
        id: string;
        code: string;
        label: string;
        aisle: string | null;
        bay: string | null;
        shelf: string | null;
        bin: string | null;
        isActive: boolean;
        sortOrder: number;
        notes: string | null;
        createdAt: Date | string;
        updatedAt: Date | string;
      }>;
      update: (args: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => Promise<{
        id: string;
        code: string;
        label: string;
        aisle: string | null;
        bay: string | null;
        shelf: string | null;
        bin: string | null;
        isActive: boolean;
        sortOrder: number;
        notes: string | null;
        createdAt: Date | string;
        updatedAt: Date | string;
      }>;
    };
    sku: {
      findUnique: (args: {
        where: { id: string };
        include?: { location?: boolean };
      }) => Promise<
        | null
        | {
            id: string;
            location: null | {
              id: string;
              code: string;
              label: string;
              aisle: string | null;
              bay: string | null;
              shelf: string | null;
              bin: string | null;
              isActive: boolean;
              sortOrder: number;
              notes: string | null;
              createdAt: Date;
              updatedAt: Date;
            };
          }
      >;
      update: (args: {
        where: { id: string };
        data: { locationId: string | null };
      }) => Promise<unknown>;
    };
  } {
    return this.prisma as unknown as ReturnType<
      InventoryLocationService["prismaAny"]
    >;
  }
}

// Alias used by callers that only need the light shape for
// serialising into API responses.
export type { Prisma };
