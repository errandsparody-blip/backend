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
  /** Migration 0054 — vendor's own store SKU used to map integration orders. */
  storeSku: string | null;
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
   * `null` when the vendor hasn't uploaded an image. Locked the moment the
   * product is created — the same immutability rule that protects identity,
   * customs, and dimension fields applies here. The image is what admin
   * receivers visually match against incoming stock, so swapping it after
   * the fact would break the photographic audit trail. To change a wrong
   * image, archive the product and recreate it.
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
        // Migration 0054 — optional store-SKU mapping.
        ...(input.storeSku ? { storeSku: input.storeSku } : {}),
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
      // Prisma P2002 = unique constraint violation. Distinguish the two
      // unique keys so the vendor sees the right message.
      if ((e as { code?: string }).code === "P2002") {
        const target = String((e as { meta?: { target?: unknown } }).meta?.target ?? "");
        if (target.includes("store_sku")) {
          throw new ConflictException({
            message: `The store SKU '${input.storeSku}' is already mapped to another product.`,
            code: "product_store_sku_taken",
          });
        }
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
    // Products are always locked for vendors once they exist (the only
    // changes allowed are image + archive). Returning `locked: true`
    // here tells the frontend to render every field read-only. The
    // backend enforces the same lock in `update()` for defence in depth.
    return this.toPublic(product, { locked: true });
  }

  async update(
    vendorId: string,
    actorId: string,
    id: string,
    patch: UpdateProductInput,
  ): Promise<PublicProduct> {
    const before = await this.prisma.product.findFirst({ where: { id, vendorId } });
    if (!before) throw new NotFoundException();

    // Products are IMMUTABLE for vendors the moment they're created. The
    // only fields they can change post-create are `status` (archive) and
    // `imageUrl` (cosmetic, no compliance impact).
    //
    // Rationale — the same constraints that used to fire only once stock
    // existed apply just as well from day one:
    //
    //   - variant   → part of the SKU id format (`UER-<vendor>-<code>-<variant>`).
    //                 Editing would silently fork ids on the next receive.
    //   - weight, dimensions, storageTier
    //               → drive shipping rates and storage billing. Locking at
    //                 creation eliminates the entire class of "edit my
    //                 product to under-declare and dodge carrier reweigh
    //                 charges" attack.
    //   - declaredValueCents, countryOfOrigin, hsCode
    //               → customs declarations. Any future PSN / order that
    //                 references this product needs the originally-declared
    //                 values; editing creates retroactive customs liability.
    //   - name      → labels physical inventory in the warehouse. Renaming
    //                 breaks pick lists for any future receive.
    //
    // Escape hatch: archive the product and create a fresh one with the
    // new attributes. Historical orders/PSNs stay attached to the
    // archived product for audit purposes.
    //
    // We previously gated this on `skuCount > 0`. That left a window
    // where a vendor could rapid-fire edits between creation and the
    // first PSN — useful for typo fixes, but also abusable. Per product
    // owner decision (2026-05): lock at creation, no window.

    // `imageUrl` is now also locked. The product image is part of the
    // visual record admin receivers match against incoming stock — if the
    // vendor could swap it after PSNs were submitted, the photographic
    // audit trail would silently drift. Locking from creation onwards
    // mirrors the rule for every other identity / customs / dimension
    // field. The escape hatch is the same: archive and recreate.
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
      "imageUrl",
    ];
    // Detect *attempted* changes — patch fields that differ from the
    // current value. A patch that re-sends the same value is a no-op
    // idempotent edit and we accept it silently so a benign re-save
    // from the UI doesn't surface a "product_locked" 400.
    const changedFields = lockableFields.filter((field) => {
      const next = patch[field];
      if (next === undefined) return false;
      const current = (before as unknown as Record<string, unknown>)[field];
      return next !== current;
    });
    if (changedFields.length > 0) {
      throw new BadRequestException({
        message:
          "Products can't be edited after they're created. Archive this product and create a new one with the updated details instead.",
        code: "product_locked",
        fields: changedFields,
      });
    }

    let updated: Product;
    try {
      updated = await this.prisma.product.update({
      where: { id }, // safe — we just confirmed scope above
      data: {
        // Migration 0054 — store SKU is a mapping convenience, NOT a locked
        // identity/compliance field, so vendors can set or change it any
        // time (empty string clears it). It's absent from `lockableFields`.
        ...(patch.storeSku !== undefined
          ? { storeSku: patch.storeSku ? patch.storeSku : null }
          : {}),
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
        // `imageUrl` is no longer accepted on update — it's locked. The
        // lock-check above already rejects any attempt to change it, so we
        // intentionally do NOT spread `patch.imageUrl` into the persisted
        // data here. Idempotent re-saves of the same image value are
        // tolerated by the lock check (no diff = no error) and end up as
        // a no-op write, which is fine.
      } as Prisma.ProductUncheckedUpdateInput,
      });
    } catch (e) {
      if (
        (e as { code?: string }).code === "P2002" &&
        String((e as { meta?: { target?: unknown } }).meta?.target ?? "").includes("store_sku")
      ) {
        throw new ConflictException({
          message: `The store SKU '${patch.storeSku}' is already mapped to another product.`,
          code: "product_store_sku_taken",
        });
      }
      throw e;
    }

    await this.audit.log({
      actorId,
      action: "product.updated",
      resourceType: "product",
      resourceId: id,
      beforeState: this.diffSnapshot(before),
      afterState: this.diffSnapshot(updated),
    });
    // Always locked from the vendor's POV — the only fields this PATCH
    // accepted are `imageUrl` / `status`, which are intentionally outside
    // the lockable set. Returning `locked: true` keeps the form rendered
    // in its read-only state across the round trip.
    return this.toPublic(updated, { locked: true });
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
      // Stale-client guard (pre-`prisma generate`): store_sku added in 0054.
      storeSku: (p as unknown as { storeSku?: string | null }).storeSku ?? null,
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
      storageTier:
        (p as unknown as { storageTier?: string }).storageTier ?? "SMALL",
      status: p.status,
    };
  }

  // ---------------------------------------------------------------------------
  // Admin override path
  //
  // Products are locked to vendors from the moment they're created so
  // they can't under-declare weights to dodge shipping costs after the
  // fact. The warehouse, however, weighs and measures every incoming
  // unit — and the receiving fee the vendor already paid covers that
  // work. When physical measurements differ from what the vendor
  // declared, the admin needs an escape hatch to correct the record.
  //
  // editAsAdmin bypasses the lock check and persists the corrected
  // shipping-critical fields. Every change is audit-logged with
  // before/after snapshots so finance can reconcile any disputes.
  //
  // Two fields stay LOCKED even for admins:
  //   - `variant` — part of the SKU id format. Editing forks ids on
  //     the next receive and corrupts historical references.
  //   - `code`    — part of the SKU id format too. Same risk.
  //
  // Vendor-side reads from the same Product row, so corrections
  // propagate automatically: the vendor's product detail page will
  // show the warehouse-measured values on the next page load.
  // ---------------------------------------------------------------------------

  /**
   * Admin-only product lookup (no vendor scope). Returns the public
   * shape with `locked: true` so the admin form knows the vendor view
   * is still read-only.
   */
  async getByIdAsAdmin(id: string): Promise<
    PublicProduct & { vendorId: string; vendorBusinessName: string }
  > {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: {
        vendor: { select: { businessName: true } },
      },
    });
    if (!product) throw new NotFoundException();
    const pub = this.toPublic(product, { locked: true });
    return {
      ...pub,
      vendorId: product.vendorId,
      vendorBusinessName: product.vendor.businessName,
    };
  }

  /**
   * Admin override — corrects vendor-declared weight / dimensions /
   * declared value / HS code / country / storage tier from the
   * warehouse measurements. NOT scoped to a vendor; caller is
   * SUPER_ADMIN-gated at the controller layer.
   *
   * The patch shape is the same as the vendor's `UpdateProductInput`
   * minus the fields admin can't safely edit (`variant`, `code`,
   * `name`, `imageUrl`, `status`). Empty / undefined fields are
   * skipped so a partial edit (e.g. weightOz only) leaves the rest
   * untouched.
   */
  async editAsAdmin(
    actorId: string,
    id: string,
    patch: AdminProductEditInput,
  ): Promise<PublicProduct> {
    const before = await this.prisma.product.findUnique({ where: { id } });
    if (!before) throw new NotFoundException();

    const data: Prisma.ProductUncheckedUpdateInput = {};
    if (patch.weightOz !== undefined) data.weightOz = patch.weightOz;
    if (patch.lengthIn !== undefined) data.lengthIn = patch.lengthIn;
    if (patch.widthIn !== undefined) data.widthIn = patch.widthIn;
    if (patch.heightIn !== undefined) data.heightIn = patch.heightIn;
    if (patch.declaredValueCents !== undefined)
      data.declaredValueCents = patch.declaredValueCents;
    if (patch.hsCode !== undefined) data.hsCode = patch.hsCode;
    if (patch.countryOfOrigin !== undefined)
      data.countryOfOrigin = patch.countryOfOrigin;
    if (patch.storageTier !== undefined) data.storageTier = patch.storageTier;

    // Idempotent no-op safeguard: if the patch matches what's already
    // on the row, skip the update + audit so we don't pollute the
    // audit log with empty diffs from accidental double-submits.
    const changed = Object.keys(data).some((k) => {
      const next = (data as Record<string, unknown>)[k];
      const current = (before as unknown as Record<string, unknown>)[k];
      return next !== current;
    });
    if (!changed) return this.toPublic(before, { locked: true });

    const updated = await this.prisma.product.update({
      where: { id },
      data,
    });

    await this.audit.log({
      actorId,
      action: "product.admin_edited",
      resourceType: "product",
      resourceId: id,
      beforeState: this.diffSnapshot(before),
      afterState: {
        ...this.diffSnapshot(updated),
        // Echo the admin's reason note into the audit row when given,
        // so finance can scan the log without joining tables.
        adminReason: patch.reason ?? null,
      },
    });

    return this.toPublic(updated, { locked: true });
  }
}

/**
 * Fields the admin override accepts. Intentionally narrower than the
 * vendor's UpdateProductInput — `variant`, `code`, `name`, and
 * `imageUrl` stay locked because changing them after SKUs exist would
 * break historical references and the photographic audit trail.
 */
export interface AdminProductEditInput {
  weightOz?: number;
  lengthIn?: number | null;
  widthIn?: number | null;
  heightIn?: number | null;
  declaredValueCents?: number;
  hsCode?: string | null;
  countryOfOrigin?: string;
  storageTier?: "SMALL" | "MEDIUM" | "LARGE" | "X_LARGE" | "PALLET";
  /** Optional free-text reason ("warehouse re-weighed", "customs correction") logged on the audit row. */
  reason?: string;
}
