import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import { Role } from "@prisma/client";
import { z } from "zod";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { TenantGuard } from "../../common/guards/tenant.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  createProductSchema,
  listProductsSchema,
  updateProductSchema,
  type CreateProductInput,
  type ListProductsInput,
  type UpdateProductInput,
} from "../../common/schemas/product.schema";
import { R2Service } from "../integrations/r2/r2.service";

import { ProductService } from "./product.service";

// Presign-upload payload for product images. Smaller MIME whitelist than
// the shopper attachment endpoint — products shouldn't accept PDF (we
// render <img>, not a viewer). 10 MB cap — high-resolution catalog
// images are routinely 3–6 MB; anything past 10 is either a video by
// mistake or a poor crop and should be rejected client-side.
const PRODUCT_IMAGE_ALLOWED_MIME = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
] as const;
const PRODUCT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const presignProductImageSchema = z.object({
  filename: z
    .string()
    .trim()
    .min(1, "Filename required.")
    .max(200, "Filename too long.")
    // Same character ban as the shopper uploader: path separators, shell
    // metas, and Windows-reserved chars. R2 generates a fresh key so this
    // is belt-and-braces, but cheap.
    .regex(/^[^\\/<>:"|?*]+$/, "Filename contains invalid characters."),
  contentType: z.enum(PRODUCT_IMAGE_ALLOWED_MIME),
  contentLengthBytes: z
    .number()
    .int()
    .positive()
    .max(
      PRODUCT_IMAGE_MAX_BYTES,
      `File too large — max ${PRODUCT_IMAGE_MAX_BYTES / (1024 * 1024)} MB.`,
    ),
});
type PresignProductImageInput = z.infer<typeof presignProductImageSchema>;

@Controller({ path: "products", version: "1" })
@Roles(Role.VENDOR, Role.VENDOR_SUB_USER)
@UseGuards(TenantGuard)
export class ProductController {
  constructor(
    private readonly products: ProductService,
    private readonly r2: R2Service,
  ) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(listProductsSchema)) q: ListProductsInput,
  ) {
    return this.products.list(user.vendorId!, q);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createProductSchema)) body: CreateProductInput,
  ) {
    return this.products.create(user.vendorId!, user.sub, body);
  }

  /**
   * POST /v1/products/uploads — presign an R2 PUT for a product image.
   *
   * Vendor-scoped: the key is prefixed with the calling vendor's ID so
   * uploads from different tenants can never collide. R2 has to be
   * configured for this environment — otherwise we surface a structured
   * 503 rather than a 500 so the frontend can render a helpful message.
   *
   * The body the vendor saves alongside the product is just the
   * returned `publicUrl` — we don't store the key here; the URL is the
   * source of truth.
   */
  @Post("uploads")
  @HttpCode(HttpStatus.OK)
  presignImageUpload(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(presignProductImageSchema))
    body: PresignProductImageInput,
  ) {
    if (!this.r2.isConfigured()) {
      throw new ServiceUnavailableException({
        message: "Image uploads are not configured for this environment.",
        code: "r2_not_configured",
      });
    }
    // Scope the R2 key under the vendor so multi-tenant uploads never
    // collide and a vendor's images stay grouped together for audit /
    // bulk operations.
    const key = this.r2.generateKey(`products/${user.vendorId}`, body.filename);
    return this.r2.presignPut({
      key,
      contentType: body.contentType,
      contentLengthBytes: body.contentLengthBytes,
    });
  }

  @Get(":id")
  get(@CurrentUser() user: AuthenticatedUser, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.products.get(user.vendorId!, id);
  }

  @Patch(":id")
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateProductSchema)) body: UpdateProductInput,
  ) {
    return this.products.update(user.vendorId!, user.sub, id, body);
  }

  @Delete(":id")
  archive(@CurrentUser() user: AuthenticatedUser, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.products.archive(user.vendorId!, user.sub, id);
  }
}
