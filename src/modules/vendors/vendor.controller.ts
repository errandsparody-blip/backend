import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import { Role } from "@prisma/client";
import { z } from "zod";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { TenantGuard } from "../../common/guards/tenant.guard";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  acceptAgreementSchema,
  submitKycV2Schema,
  updateVendorSchema,
  type AcceptAgreementInput,
  type SubmitKycV2Input,
  type UpdateVendorInput,
} from "../../common/schemas/vendor.schema";
import { R2Service } from "../integrations/r2/r2.service";

import { VendorService } from "./vendor.service";

// KYC document upload presign payload. Same shape as the product image
// presign endpoint but with a stricter MIME allow-list (no GIF / HEIC —
// reviewers want clean ID scans, not animated images), a higher PDF
// allowance (business registration certificates are typically PDFs), and
// a `kind` discriminator that the controller maps to the R2 key prefix.
const KYC_UPLOAD_KINDS = [
  "id_front",
  "id_back",
  "id_selfie",
  "business_doc",
] as const;
type KycUploadKind = (typeof KYC_UPLOAD_KINDS)[number];

const KYC_UPLOAD_ALLOWED_MIME = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
] as const;
const KYC_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

const presignKycUploadSchema = z.object({
  // Discriminator — drives the R2 key prefix so reviewers and audits can
  // tell at a glance which document a given object is. Strict enum so a
  // typo can't slip into the bucket as e.g. `kyc/<vendor>/foo/...`.
  kind: z.enum(KYC_UPLOAD_KINDS),
  contentType: z.enum(KYC_UPLOAD_ALLOWED_MIME),
  // Filename optional — the R2 key is generated server-side; we only
  // honour the extension hint so downloaded objects keep their suffix.
  // Same character ban as product image / shopper attachment uploaders
  // (path separators, shell metas, Windows-reserved chars).
  filename: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\\/<>:"|?*]+$/, "Filename contains invalid characters.")
    .optional(),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(
      KYC_UPLOAD_MAX_BYTES,
      `File too large — max ${KYC_UPLOAD_MAX_BYTES / (1024 * 1024)} MB.`,
    ),
});
type PresignKycUploadInput = z.infer<typeof presignKycUploadSchema>;

@Controller({ path: "vendors/me", version: "1" })
@Roles(Role.VENDOR, Role.VENDOR_SUB_USER)
@UseGuards(TenantGuard)
export class VendorController {
  constructor(
    private readonly vendors: VendorService,
    private readonly r2: R2Service,
  ) {}

  @Get()
  async me(@CurrentUser() user: AuthenticatedUser) {
    return this.vendors.getProfile(user.vendorId!);
  }

  /**
   * Recurring monthly storage breakdown for the calling vendor. Same
   * math as the billing cron — what you see here is what you'll be
   * charged on the 1st. Sub-users are allowed: they can see what the
   * account will pay, they just can't fund the wallet to cover it.
   */
  @Get("recurring-storage")
  async recurringStorage(@CurrentUser() user: AuthenticatedUser) {
    return this.vendors.getRecurringStorage(user.vendorId!);
  }

  @Patch()
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(updateVendorSchema)) body: UpdateVendorInput,
  ) {
    // Sub-users can read but not edit the vendor profile. The @Roles decorator
    // on the class allows them to GET; we gate the write here so we don't
    // need a separate controller.
    if (user.role === Role.VENDOR_SUB_USER) {
      throw new ForbiddenException({
        message: "Only the vendor admin can edit account settings.",
        code: "vendor_profile_admin_only",
      });
    }
    return this.vendors.updateProfile(user.vendorId!, user.sub, body);
  }

  @Post("agreement")
  async acceptAgreement(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(acceptAgreementSchema)) body: AcceptAgreementInput,
  ) {
    if (user.role === Role.VENDOR_SUB_USER) {
      throw new ForbiddenException({
        message: "Only the vendor admin can accept the agreement.",
        code: "vendor_agreement_admin_only",
      });
    }
    return this.vendors.acceptAgreement(user.vendorId!, user.sub, body.version, body.signatureName);
  }

  /**
   * Vendor self-submits their account for KYC review. The multi-step wizard
   * calls this on every "Next" with the cumulative form state — partial
   * payloads are accepted and persisted (each step is its own save point).
   * The FINAL submission carries `submitForReview: true`; that flips
   * kycStatus to IN_PROGRESS and stamps `kycSubmittedAt`. Sub-users cannot
   * submit — compliance attestation is the vendor admin's responsibility.
   */
  @Post("kyc/submit")
  async submitKyc(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(submitKycV2Schema)) body: SubmitKycV2Input,
  ) {
    if (user.role === Role.VENDOR_SUB_USER) {
      throw new ForbiddenException({
        message: "Only the vendor admin can submit KYC.",
        code: "vendor_kyc_admin_only",
      });
    }
    return this.vendors.submitKyc(user.vendorId!, user.sub, body);
  }

  /**
   * Presign an R2 PUT for one of the four KYC v2 document uploads.
   *
   * Mirrors the product-image / shopper-attachment presign flow: client
   * POSTs the kind + contentType + sizeBytes; server picks an
   * unguessable key under `kyc/<vendorId>/<kind>/<random>` and returns
   * the signed URL + the public URL the wizard saves on the vendor row
   * via the existing kyc/submit endpoint.
   *
   * Sub-users can't upload — same rationale as kyc/submit (compliance
   * attestation is the vendor admin's responsibility, and an upload is a
   * legal-evidence event we want pinned to the account owner).
   */
  @Post("kyc/uploads/presign")
  @HttpCode(HttpStatus.OK)
  presignKycUpload(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(presignKycUploadSchema)) body: PresignKycUploadInput,
  ) {
    if (user.role === Role.VENDOR_SUB_USER) {
      throw new ForbiddenException({
        message: "Only the vendor admin can upload KYC documents.",
        code: "vendor_kyc_admin_only",
      });
    }
    if (!this.r2.isConfigured()) {
      throw new ServiceUnavailableException({
        message: "Document uploads are not configured for this environment.",
        code: "r2_not_configured",
      });
    }
    // Scope keys under `kyc/<vendorId>/<kind>/...` so:
    //   - tenant uploads can never collide,
    //   - admin audits ("show me every file vendor X has submitted")
    //     reduce to a prefix list, and
    //   - the document type is recoverable from the key alone, even if
    //     the DB reference is later cleared.
    const kindPrefix: Record<KycUploadKind, string> = {
      id_front: "id-front",
      id_back: "id-back",
      id_selfie: "id-selfie",
      business_doc: "business-doc",
    };
    const filename = body.filename ?? `${kindPrefix[body.kind]}.bin`;
    const key = this.r2.generateKey(
      `kyc/${user.vendorId}/${kindPrefix[body.kind]}`,
      filename,
    );
    return this.r2.presignPut({
      key,
      contentType: body.contentType,
      contentLengthBytes: body.sizeBytes,
    });
  }
}
