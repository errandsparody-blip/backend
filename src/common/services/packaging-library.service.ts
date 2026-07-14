/**
 * PackagingLibraryService — Migration 0043.
 *
 * Shared, admin-maintained catalog of shippable box / mailer presets.
 * The warehouse pack step reads from this table so an operator can
 * pick "Medium Flat Rate Box" instead of typing 11 × 8.5 × 5.5. When a
 * preset is selected, its dims populate the pack-time dimensions and
 * its tare weight is added to the operator-entered goods weight.
 *
 * SRP: this service owns ONLY the packaging-preset catalog. It does
 * not decide when a preset is required, and never mutates orders.
 * OrderPackService composes with it via `getById()`.
 *
 * SECURITY / correctness
 *   * `create` and `update` validate ranges again in JS even though
 *     the DB has CHECK constraints — a friendly 400 beats a raw
 *     Postgres error surfacing.
 *   * `code` is normalised to lowercase before insert to keep the
 *     unique constraint from being defeated by casing.
 *   * `deactivate` never deletes rows; retiring a preset preserves
 *     historical FK references from orders.
 *   * A small in-process cache (5 s) speeds up the pack-modal read;
 *     `writes` invalidate the cache.
 *
 * Range mirror (kept in sync with 0043 CHECK constraints):
 *   * length/width/height  in inches, > 0, ≤ 48
 *   * tare_weight_oz       in ounces, ≥ 0, ≤ 400
 *   * code                 regex [a-z0-9_-]{2,32}
 *   * label                1..80 chars, trimmed
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

export interface PackagingOption {
  id: string;
  code: string;
  label: string;
  lengthIn: number;
  widthIn: number;
  heightIn: number;
  tareWeightOz: number;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePackagingInput {
  code: string;
  label: string;
  lengthIn: number;
  widthIn: number;
  heightIn: number;
  tareWeightOz?: number;
  sortOrder?: number;
}

export interface UpdatePackagingInput {
  label?: string;
  lengthIn?: number;
  widthIn?: number;
  heightIn?: number;
  tareWeightOz?: number;
  sortOrder?: number;
  isActive?: boolean;
}

// ---------------------------------------------------------------------------
// Bounds — kept in ONE place so a change here surfaces the need to
// update the DB CHECK constraints too.
// ---------------------------------------------------------------------------

const MAX_DIM_IN = 48;
const MAX_TARE_OZ = 400;
const CODE_RE = /^[a-z0-9_-]{2,32}$/;

// 5-second in-process cache — long enough to spare the pack modal a
// round-trip on every keystroke, short enough that an admin's edit
// shows up almost immediately.
const CACHE_TTL_MS = 5_000;

// ---------------------------------------------------------------------------

@Injectable()
export class PackagingLibraryService {
  private cache: { at: number; items: PackagingOption[] } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  // =========================================================================
  // Reads
  // =========================================================================

  /** All packaging options (active AND inactive), sort_order-then-label. */
  async listAll(): Promise<PackagingOption[]> {
    const rows = await this.prismaAny().packagingOption.findMany({
      orderBy: [{ isActive: "desc" }, { sortOrder: "asc" }, { label: "asc" }],
    });
    return rows.map((r) => this.toPublic(r));
  }

  /**
   * Active packaging options only — what the pack modal renders.
   * Cached for 5 s across the process (see CACHE_TTL_MS).
   */
  async listActive(): Promise<PackagingOption[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < CACHE_TTL_MS) {
      return this.cache.items;
    }
    const rows = await this.prismaAny().packagingOption.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { label: "asc" }],
    });
    const items = rows.map((r) => this.toPublic(r));
    this.cache = { at: now, items };
    return items;
  }

  async getById(id: string): Promise<PackagingOption | null> {
    const row = await this.prismaAny().packagingOption.findUnique({
      where: { id },
    });
    return row ? this.toPublic(row) : null;
  }

  async getByCode(code: string): Promise<PackagingOption | null> {
    const normalised = code.trim().toLowerCase();
    const row = await this.prismaAny().packagingOption.findUnique({
      where: { code: normalised },
    });
    return row ? this.toPublic(row) : null;
  }

  // =========================================================================
  // Writes
  // =========================================================================

  async create(input: CreatePackagingInput): Promise<PackagingOption> {
    const code = this.validateCode(input.code);
    const label = this.validateLabel(input.label);
    this.validateDim("lengthIn", input.lengthIn);
    this.validateDim("widthIn", input.widthIn);
    this.validateDim("heightIn", input.heightIn);
    const tare = this.validateTare(input.tareWeightOz ?? 0);
    const sort = this.validateSort(input.sortOrder ?? 100);

    try {
      const row = await this.prismaAny().packagingOption.create({
        data: {
          code,
          label,
          lengthIn: input.lengthIn,
          widthIn: input.widthIn,
          heightIn: input.heightIn,
          tareWeightOz: tare,
          sortOrder: sort,
        },
      });
      this.cache = null;
      return this.toPublic(row);
    } catch (err) {
      throw this.reformatUnique(err, code);
    }
  }

  async update(id: string, input: UpdatePackagingInput): Promise<PackagingOption> {
    const patch: Record<string, unknown> = {};
    if (input.label !== undefined) patch.label = this.validateLabel(input.label);
    if (input.lengthIn !== undefined) {
      this.validateDim("lengthIn", input.lengthIn);
      patch.lengthIn = input.lengthIn;
    }
    if (input.widthIn !== undefined) {
      this.validateDim("widthIn", input.widthIn);
      patch.widthIn = input.widthIn;
    }
    if (input.heightIn !== undefined) {
      this.validateDim("heightIn", input.heightIn);
      patch.heightIn = input.heightIn;
    }
    if (input.tareWeightOz !== undefined) {
      patch.tareWeightOz = this.validateTare(input.tareWeightOz);
    }
    if (input.sortOrder !== undefined) {
      patch.sortOrder = this.validateSort(input.sortOrder);
    }
    if (input.isActive !== undefined) patch.isActive = input.isActive;

    if (Object.keys(patch).length === 0) {
      throw new BadRequestException({
        message: "No fields to update.",
        code: "invalid_input",
      });
    }

    try {
      const row = await this.prismaAny().packagingOption.update({
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

  async deactivate(id: string): Promise<PackagingOption> {
    return this.update(id, { isActive: false });
  }

  async reactivate(id: string): Promise<PackagingOption> {
    return this.update(id, { isActive: true });
  }

  // =========================================================================
  // Validation helpers
  // =========================================================================

  private validateCode(code: string): string {
    const normalised = (code ?? "").trim().toLowerCase();
    if (!CODE_RE.test(normalised)) {
      throw new BadRequestException({
        message: "code must match [a-z0-9_-]{2,32}.",
        code: "invalid_input",
      });
    }
    return normalised;
  }

  private validateLabel(label: string): string {
    const trimmed = (label ?? "").trim();
    if (trimmed.length < 1 || trimmed.length > 80) {
      throw new BadRequestException({
        message: "label must be 1..80 characters.",
        code: "invalid_input",
      });
    }
    return trimmed;
  }

  private validateDim(name: string, value: number): void {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new BadRequestException({
        message: `${name} must be a positive number.`,
        code: "invalid_input",
      });
    }
    if (value > MAX_DIM_IN) {
      throw new BadRequestException({
        message: `${name} exceeds ${MAX_DIM_IN} in.`,
        code: "invalid_input",
      });
    }
  }

  private validateTare(value: number): number {
    if (!Number.isInteger(value) || value < 0 || value > MAX_TARE_OZ) {
      throw new BadRequestException({
        message: `tareWeightOz must be an integer 0..${MAX_TARE_OZ}.`,
        code: "invalid_input",
      });
    }
    return value;
  }

  private validateSort(value: number): number {
    if (!Number.isInteger(value) || value < 0 || value > 10_000) {
      throw new BadRequestException({
        message: "sortOrder must be a non-negative integer under 10000.",
        code: "invalid_input",
      });
    }
    return value;
  }

  // =========================================================================
  // Error / cast helpers
  // =========================================================================

  private reformatUnique(err: unknown, code: string): unknown {
    // Prisma P2002 — unique constraint violation. We re-throw as a
    // 409 with a stable code so the frontend can pin the "code
    // already taken" copy to that message.
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "P2002"
    ) {
      return new ConflictException({
        message: `A packaging option with code "${code}" already exists.`,
        code: "packaging_code_taken",
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
    lengthIn: Prisma.Decimal | number | string;
    widthIn: Prisma.Decimal | number | string;
    heightIn: Prisma.Decimal | number | string;
    tareWeightOz: number;
    isActive: boolean;
    sortOrder: number;
    createdAt: Date;
    updatedAt: Date;
  }): PackagingOption {
    return {
      id: row.id,
      code: row.code,
      label: row.label,
      lengthIn: this.decimalToNumber(row.lengthIn),
      widthIn: this.decimalToNumber(row.widthIn),
      heightIn: this.decimalToNumber(row.heightIn),
      tareWeightOz: row.tareWeightOz,
      isActive: row.isActive,
      sortOrder: row.sortOrder,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private decimalToNumber(value: Prisma.Decimal | number | string): number {
    if (typeof value === "number") return value;
    if (typeof value === "string") return Number(value);
    return Number(value.toString());
  }

  /**
   * Prisma client hasn't been regenerated for the new packagingOption
   * delegate in the sandbox; cast so the code compiles. In CI (post
   * `prisma generate`) the property exists on the delegate.
   */
  private prismaAny(): {
    packagingOption: {
      findMany: (args: unknown) => Promise<Array<Record<string, unknown> & {
        id: string;
        code: string;
        label: string;
        lengthIn: Prisma.Decimal | number | string;
        widthIn: Prisma.Decimal | number | string;
        heightIn: Prisma.Decimal | number | string;
        tareWeightOz: number;
        isActive: boolean;
        sortOrder: number;
        createdAt: Date;
        updatedAt: Date;
      }>>;
      findUnique: (args: unknown) => Promise<null | (Record<string, unknown> & {
        id: string;
        code: string;
        label: string;
        lengthIn: Prisma.Decimal | number | string;
        widthIn: Prisma.Decimal | number | string;
        heightIn: Prisma.Decimal | number | string;
        tareWeightOz: number;
        isActive: boolean;
        sortOrder: number;
        createdAt: Date;
        updatedAt: Date;
      })>;
      create: (args: unknown) => Promise<Record<string, unknown> & {
        id: string;
        code: string;
        label: string;
        lengthIn: Prisma.Decimal | number | string;
        widthIn: Prisma.Decimal | number | string;
        heightIn: Prisma.Decimal | number | string;
        tareWeightOz: number;
        isActive: boolean;
        sortOrder: number;
        createdAt: Date;
        updatedAt: Date;
      }>;
      update: (args: unknown) => Promise<Record<string, unknown> & {
        id: string;
        code: string;
        label: string;
        lengthIn: Prisma.Decimal | number | string;
        widthIn: Prisma.Decimal | number | string;
        heightIn: Prisma.Decimal | number | string;
        tareWeightOz: number;
        isActive: boolean;
        sortOrder: number;
        createdAt: Date;
        updatedAt: Date;
      }>;
    };
  } {
    return this.prisma as unknown as ReturnType<
      PackagingLibraryService["prismaAny"]
    >;
  }
}
