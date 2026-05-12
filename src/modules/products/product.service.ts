/**
 * ProductService — vendor-scoped product catalogue. Every method takes
 * vendorId as the first parameter. Lookups always include vendorId in the
 * where clause — no exceptions.
 *
 * 404 (not 403) is intentionally returned when a product exists but belongs
 * to another vendor. We don't confirm existence to the wrong tenant.
 *
 * Implementation Plan §4.3, §6.1.
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Prisma, Product } from "@prisma/client";

import { PrismaService } from "../../common/prisma.service";
import type {
  CreateProductInput,
  ListProductsInput,
  UpdateProductInput,
} from "../../common/schemas/product.schema";
import { AuditService } from "../audit/audit.service";

export interface PublicProduct {
  id: string;
  code: string;
  name: string;
  variant: string;
  hsCode: string | null;
  countryOfOrigin: string;
  declaredValueCents: number;
  weightOz: number;
  lengthIn: number | null;
  widthIn: number | null;
  heightIn: number | null;
  storageTier: "SMALL" | "MEDIUM" | "LARGE" | "X_LARGE" | "PALLET";
  /**
   * Migration 0022 — optional product image (URL into our R2 bucket).
   * `null` when the vendor hasn't uploaded an image. NEVER locked — image
   * is purely cosmetic and editing it never affects shipping, customs,
   * or storage billing, so we keep it editable even after stock arrives.
   */
  imageUrl: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  /**
   * True once any SKU exists for this product (i.e. stock has been
   * received). Locks all fields except `status` and `imageUrl`. Computed
   * at read time; the frontend uses it to render the form as read-only
   * and to surface the "archive + recreate" hint.
   */
  locked: boolean;
}

@Injectable()
export class ProductService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(vendorId: string, actorId: string, input: CreateProductInput): Promise<PublicProduct> {
    try {
      // Spread-conditional pattern for the nullable dimension fields:
      // omitting a field entirely lets Postgres pick its default (now NULL
      // after migration 0009).
      //
      // The `as Prisma.ProductCreateInput` cast is the only piece that
      // looks unusual here. The generated Prisma client typings still
      // mark length/width/height as required `Float` because schema.prisma
      // was changed in this same commit and `prisma generate` hadn't run
      // yet at the time of typecheck. After deploy, the postinstall hook
      // regenerates the client and the cast becomes a no-op. Runtime is
      // already correct because migration 0009 made the columns nullable.
      const data = {
        vendorId,
        code: input.code,
        name: input.name,
        variant: input.variant,
        hsCode: input.hsCode ?? null,
        countryOfOrigin: input.countryOfOrigin,
        declaredValueCents: input.declaredValueCents,
        weightOz: input.weightOz,
        ...(input.lengthIn != null ? { lengthIn: input.lengthIn } : {}),
        ...(input.widthIn != null ? { widthIn: input.widthIn } : {}),
        ...(input.heightIn != null ? { heightIn: input.heightIn } : {}),
        storageTier: input.storageTier,
        // Migration 0022 — optional product image. Cast keeps the call
        // compiling against the stale generated client until Railway
        // re-runs `prisma generate` on next deploy.
        ...(input.imageUrl != null ? { imageUrl: input.imageUrl } : {}),
      };
      const product = await this.prisma.product.create({
        data: data as Prisma.ProductUncheckedCreateInput,
      });
      await this.audit.log({
        actorId,
        action: "product.created",
        resourceType: "product",
        resourceId: product.id,
        afterState: { code: product.code, name: product.name },
      });
      return this.toPublic(product);
    } catch (e) {
      // Prisma P2002 = unique constraint violation
      if ((e as { code?: string }).code === "P2002") {
        throw new ConflictException({
          message: `A product with code '${input.code}' already exists.`,
          code: "product_code_taken",
        });
      }
      throw e;
    }
  }

  async list(
    vendorId: string,
    input: ListProductsInput,
  ): Promise<{ items: PublicProduct[]; nextCursor: string | null }> {
    const where: Prisma.ProductWhereInput = { vendorId };
    if (input.status) where.status = input.status;
    if (input.search) {
      where.OR = [
        { code: { contains: input.search, mode: "insensitive" } },
        { name: { contains: input.search, mode: "insensitive" } },
      ];
    }

    const items = await this.prisma.product.findMany({
      where,
      take: input.limit + 1,
      orderBy: { createdAt: "desc" },
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    });

    let nextCursor: string | null = null;
    if (items.length > input.limit) {
      const next = items.pop();
      nextCursor = next?.id ?? null;
    }
    return { items: items.map((p) => this.toPublic(p)), nextCursor };
  }

  async get(vendorId: string, id: string): Promise<PublicProduct> {
    // CRITICAL: vendorId in the where clause. Never findUnique({ where: { id } }) for
    // vendor-scoped lookups. NotFoundException, not Forbidden — we don't confirm
    // existence to the wrong tenant.
    const product = await this.prisma.product.findFirst({ where: { id, vendorId } });
    if (!product) throw new NotFoundException();
    // Compute lock state — needed for the form to render fields read-only.
    // Done at read time rather than persisted because it's a pure function
    // of `count(skus where productId)` and we'd otherwise need triggers to
    // keep a `lockedAt` column in sync.
    const skuCount = await this.prisma.sku.count({ where: { productId: id, vendorId } });
    return this.toPublic(product, { locked: skuCount > 0 });
  }

  async update(
    vendorId: string,
    actorId: string,
    id: string,
    patch: UpdateProductInput,
  ): Promise<PublicProduct> {
    const before = await this.prisma.product.findFirst({ where: { id, vendorId } });
    if (!before) throw new NotFoundException();

    // Once stock has been received under this product (i.e. any SKU exists),
    // the entire product becomes IMMUTABLE except for `status` — vendors
    // can still archive. Rationale:
    //
    //   - variant   → part of the SKU id format (`UER-<vendor>-<code>-<variant>`).
    //                 Editing would silently fork ids on the next receive.
    //   - weight, dimensions, storageTier
    //               → drive shipping rates and storage billing. Edits would
    //                 desync our published prices from what the vendor signed
    //                 up for and let a vendor under-declare retroactively to
    //                 dodge carrier reweigh charges and storage fees.
    //   - declaredValueCents, countryOfOrigin, hsCode
    //               → customs declarations on every order we&apos;ve already
    //                 shipped. Editing creates retroactive customs liability.
    //   - name      → labels physical inventory in the warehouse. Renaming
    //                 mid-flight breaks pick lists.
    //
    // The escape hatch is the same as before: archive the product and create
    // a fresh one with the new attributes. Historical orders/PSNs stay
    // attached to the archived product for audit purposes.
    const skuCount = await this.prisma.sku.count({
      where: { productId: id, vendorId },
    });
    // NOTE: `imageUrl` is deliberately NOT in this list. Images are
    // cosmetic — they don't affect shipping rates, customs, storage
    // billing, or pick lists. Letting vendors refresh a stale or
    // low-quality image even after stock has arrived is a UX win with
    // zero compliance cost.
    const lockableFields: Array<keyof UpdateProductInput> = [
      "name",
      "variant",
      "hsCode",
      "countryOfOrigin",
      "declaredValueCents",
      "weightOz",
      "lengthIn",
      "widthIn",
      "heightIn",
      "storageTier",
    ];
    if (skuCount > 0) {
      // Detect *attempted* changes — patch fields that differ from the
      // current value. A patch that just re-sends the same value is a
      // no-op idempotent edit and we accept it silently.
      const changedFields = lockableFields.filter((field) => {
        const next = patch[field];
        if (next === undefined) return false;
        const current = (before as unknown as Record<string, unknown>)[field];
        return next !== current;
      });
      if (changedFields.length > 0) {
        throw new BadRequestException({
          message:
            "Product can't be edited once stock has been received. Archive this product and create a new one with the updated details instead.",
          code: "product_locked",
          fields: changedFields,
        });
      }
    }

    const updated = await this.prisma.product.update({
      where: { id }, // safe — we just confirmed scope above
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.variant !== undefined ? { variant: patch.variant } : {}),
        ...(patch.hsCode !== undefined ? { hsCode: patch.hsCode } : {}),
        ...(patch.countryOfOrigin !== undefined ? { countryOfOrigin: patch.countryOfOrigin } : {}),
        ...(patch.declaredValueCents !== undefined ? { declaredValueCents: patch.declaredValueCents } : {}),
        ...(patch.weightOz !== undefined ? { weightOz: patch.weightOz } : {}),
        // Dimensions: null/undefined both mean "don't touch this field" so
        // we can keep the Prisma client type-clean against the stale
        // generated types (pre-regenerate). Clearing a previously-set
        // dimension isn't supported through this path; vendors who need to
        // clear can archive and re-create. Trade-off documented in
        // migration 0009.
        ...(patch.lengthIn != null ? { lengthIn: patch.lengthIn } : {}),
        ...(patch.widthIn != null ? { widthIn: patch.widthIn } : {}),
        ...(patch.heightIn != null ? { heightIn: patch.heightIn } : {}),
        ...(patch.storageTier !== undefined ? { storageTier: patch.storageTier } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        // Image: explicitly accept `null` so a vendor can clear an
        // existing image (e.g. they uploaded the wrong one). The Zod
        // layer above normalised "" → null already.
        ...(patch.imageUrl !== undefined ? { imageUrl: patch.imageUrl } : {}),
      } as Prisma.ProductUncheckedUpdateInput,
    });

    await this.audit.log({
      actorId,
      action: "product.updated",
      resourceType: "product",
      resourceId: id,
      beforeState: this.diffSnapshot(before),
      afterState: this.diffSnapshot(updated),
    });
    return this.toPublic(updated, { locked: skuCount > 0 });
  }

  /**
   * Soft-delete via status='ARCHIVED'. We don't hard-delete because SKUs and
   * historical PSN lines reference products.
   */
  async archive(vendorId: string, actorId: string, id: string): Promise<PublicProduct> {
    return this.update(vendorId, actorId, id, { status: "ARCHIVED" });
  }

  private toPublic(p: Product, opts: { locked?: boolean } = {}): PublicProduct {
    return {
      id: p.id,
      code: p.code,
      name: p.name,
      variant: p.variant,
      hsCode: p.hsCode,
      countryOfOrigin: p.countryOfOrigin,
      declaredValueCents: p.declaredValueCents,
      weightOz: p.weightOz,
      lengthIn: p.lengthIn,
      widthIn: p.widthIn,
      heightIn: p.heightIn,
      // The stale Prisma client (pre-`prisma generate`) doesn't yet
      // know about storage_tier. Read it via a cast; runtime is correct
      // because migration 0010 added the column with a SMALL default.
      storageTier:
        ((p as unknown as { storageTier?: PublicProduct["storageTier"] }).storageTier ??
          "SMALL") as PublicProduct["storageTier"],
      // Stale-client guard: pre-`prisma generate` builds don't have the
      // `imageUrl` field on the model type. We still want the runtime
      // value (the column exists in the DB after migration 0022).
      imageUrl:
        (p as unknown as { imageUrl?: string | null }).imageUrl ?? null,
      status: p.status,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      // `locked` defaults to false. Caller passes true for the per-product
      // detail path where we counted SKUs. The list path passes false to
      // avoid an N+1 SKU-count query — the list table doesn't render an
      // edit form anyway.
      locked: opts.locked ?? false,
    };
  }

  private diffSnapshot(p: Product) {
    return {
      name: p.name,
      variant: p.variant,
      hsCode: p.hsCode,
      countryOfOrigin: p.countryOfOrigin,
      declaredValueCents: p.declaredValueCents,
      weightOz: p.weightOz,
      lengthIn: p.lengthIn,
      widthIn: p.widthIn,
      heightIn: p.heightIn,
      status: p.status,
    };
  }
}
