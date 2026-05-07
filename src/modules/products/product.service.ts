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
  lengthIn: number;
  widthIn: number;
  heightIn: number;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class ProductService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(vendorId: string, actorId: string, input: CreateProductInput): Promise<PublicProduct> {
    try {
      const product = await this.prisma.product.create({
        data: {
          vendorId,
          code: input.code,
          name: input.name,
          variant: input.variant,
          hsCode: input.hsCode ?? null,
          countryOfOrigin: input.countryOfOrigin,
          declaredValueCents: input.declaredValueCents,
          weightOz: input.weightOz,
          lengthIn: input.lengthIn,
          widthIn: input.widthIn,
          heightIn: input.heightIn,
        },
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
    return this.toPublic(product);
  }

  async update(
    vendorId: string,
    actorId: string,
    id: string,
    patch: UpdateProductInput,
  ): Promise<PublicProduct> {
    const before = await this.prisma.product.findFirst({ where: { id, vendorId } });
    if (!before) throw new NotFoundException();

    const updated = await this.prisma.product.update({
      where: { id }, // safe — we just confirmed scope above
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.variant !== undefined ? { variant: patch.variant } : {}),
        ...(patch.hsCode !== undefined ? { hsCode: patch.hsCode } : {}),
        ...(patch.countryOfOrigin !== undefined ? { countryOfOrigin: patch.countryOfOrigin } : {}),
        ...(patch.declaredValueCents !== undefined ? { declaredValueCents: patch.declaredValueCents } : {}),
        ...(patch.weightOz !== undefined ? { weightOz: patch.weightOz } : {}),
        ...(patch.lengthIn !== undefined ? { lengthIn: patch.lengthIn } : {}),
        ...(patch.widthIn !== undefined ? { widthIn: patch.widthIn } : {}),
        ...(patch.heightIn !== undefined ? { heightIn: patch.heightIn } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
      },
    });

    await this.audit.log({
      actorId,
      action: "product.updated",
      resourceType: "product",
      resourceId: id,
      beforeState: this.diffSnapshot(before),
      afterState: this.diffSnapshot(updated),
    });
    return this.toPublic(updated);
  }

  /**
   * Soft-delete via status='ARCHIVED'. We don't hard-delete because SKUs and
   * historical PSN lines reference products.
   */
  async archive(vendorId: string, actorId: string, id: string): Promise<PublicProduct> {
    return this.update(vendorId, actorId, id, { status: "ARCHIVED" });
  }

  private toPublic(p: Product): PublicProduct {
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
      status: p.status,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
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
