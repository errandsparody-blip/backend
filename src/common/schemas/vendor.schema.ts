import { z } from "zod";

// ---------------------------------------------------------------------------
// Social handles
//
// Each platform has its own character set + length limits. We accept input
// with or without the leading "@", lowercase + trim it server-side, then
// validate against the platform's published rules. Empty string → null
// (lets a vendor remove a handle they previously set).
// ---------------------------------------------------------------------------

const stripAt = (s: string) =>
  s.trim().replace(/^@/, "").toLowerCase();

const instagramHandleSchema = z
  .string()
  .transform(stripAt)
  .pipe(
    z
      .string()
      .min(1, "Instagram handle cannot be empty.")
      .max(30, "Instagram handles are at most 30 characters.")
      .regex(
        /^[a-z0-9._]+$/,
        "Instagram handles use letters, numbers, periods, and underscores only.",
      ),
  );

const tiktokHandleSchema = z
  .string()
  .transform(stripAt)
  .pipe(
    z
      .string()
      .min(2, "TikTok handle is at least 2 characters.")
      .max(24, "TikTok handles are at most 24 characters.")
      .regex(
        /^[a-z0-9._]+$/,
        "TikTok handles use letters, numbers, periods, and underscores only.",
      ),
  );

const xHandleSchema = z
  .string()
  .transform(stripAt)
  .pipe(
    z
      .string()
      .min(1, "X handle cannot be empty.")
      .max(15, "X handles are at most 15 characters.")
      .regex(
        /^[a-z0-9_]+$/,
        "X handles use letters, numbers, and underscores only — no periods.",
      ),
  );

const websiteUrlSchema = z
  .string()
  .trim()
  .url("Enter a full URL including https://")
  .max(500);

// Empty string OR explicit null both strip the value (set the column back
// to null on the vendor row). Undefined leaves it unchanged. The frontend
// posts `null` from the settings form when a vendor clears a handle, so
// the schema must accept that without raising "Expected string, received
// null".
const optionalSocial = <T extends z.ZodType<string, z.ZodTypeDef, unknown>>(
  schema: T,
): z.ZodType<string | null | undefined, z.ZodTypeDef, unknown> =>
  z
    .union([z.literal(""), z.null(), schema])
    .optional()
    .transform<string | null | undefined>((v) =>
      v === "" || v === null ? null : v,
    );

export const updateVendorSchema = z.object({
  businessName: z.string().min(2).max(120).optional(),
  instagramHandle: optionalSocial(instagramHandleSchema),
  tiktokHandle: optionalSocial(tiktokHandleSchema),
  xHandle: optionalSocial(xHandleSchema),
  websiteUrl: optionalSocial(websiteUrlSchema),
});
export type UpdateVendorInput = z.infer<typeof updateVendorSchema>;

export const acceptAgreementSchema = z.object({
  version: z.string().min(1),
  /**
   * Vendor's typed-name e-signature. Optional on the wire (sub-user
   * activation flows that don't have a UI yet might post the version
   * alone), but the friendly UI always provides it. We persist it in
   * the audit log alongside the actor + timestamp for legal traceability.
   */
  signatureName: z.string().trim().min(2).max(120).optional(),
});
export type AcceptAgreementInput = z.infer<typeof acceptAgreementSchema>;

// ---------------------------------------------------------------------------
// Submit KYC v2
//
// The multi-step wizard saves each step on "Next" so the server accepts
// partial submissions. Every field is optional at the schema level. The
// FINAL submit is signalled by `submitForReview: true` being present — at
// that moment the entire dataset MUST be filled in, which we enforce via
// `.superRefine` below. (Sections 7 — Payment & Wallet — and 8 — Compliance
// signature — from the source spec were deliberately omitted in KYC v2 P1.)
//
// All enums duplicate the Prisma enum values verbatim. If you add a member
// here, mirror it in prisma/schema.prisma and add a migration that ALTER
// TYPEs the underlying Postgres enum — Prisma doesn't auto-migrate enums.
// ---------------------------------------------------------------------------

const businessTypeEnum = z.enum([
  "SOLE_PROPRIETORSHIP",
  "REGISTERED_BUSINESS",
  "LLC",
  "CORPORATION",
  "PARTNERSHIP",
  "OTHER",
]);

const industryEnum = z.enum([
  "FASHION_APPAREL",
  "BEAUTY_COSMETICS",
  "HAIR_WIGS",
  "ELECTRONICS",
  "ACCESSORIES",
  "HOME_GOODS",
  "OTHER",
]);

const idTypeEnum = z.enum(["PASSPORT", "NATIONAL_ID", "DRIVERS_LICENSE"]);

const inventoryVolumeEnum = z.enum([
  "SMALL_1_10",
  "MEDIUM_11_30",
  "LARGE_31_100",
  "XLARGE_100_PLUS",
  "BULK_PALLET",
]);

const orderVolumeEnum = z.enum(["V_1_20", "V_21_100", "V_101_500", "V_500_PLUS"]);

const serviceIntentEnum = z.enum(["FULFILLMENT_ONLY", "PERSONAL_SHOPPER", "BOTH"]);

const hazardEnum = z.enum([
  "BATTERIES",
  "LIQUIDS",
  "FRAGILE",
  "HAZARDOUS",
  "NONE",
]);

// ISO 3166-1 alpha-2 — exactly two ASCII letters. We uppercase server-side so
// "us" and "US" both end up as "US".
const iso2 = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/, "Use a 2-letter ISO country code (e.g. US, GB).")
  .transform((s) => s.toUpperCase());

// Phone — permissive on format because we get vendors from many jurisdictions.
// Strip leading/trailing whitespace, demand 6+ characters of digits, +, space,
// hyphen, parentheses. Enforces nothing more than "looks like a phone number".
const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9 \-()]{6,}$/, "Enter a phone number with country code.");

// ISO date (YYYY-MM-DD). We refuse anything in the past so an expired ID isn't
// accepted at submission time — the reviewer would just reject it anyway.
const isoFutureDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return false;
    // Compare to UTC start-of-today so a same-day expiry counts as "expired" —
    // an ID that expires today can't be relied upon for verification tomorrow.
    const now = new Date();
    const utcToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return d.getTime() > utcToday;
  }, "ID is expired or expires today. Provide a still-valid document.");

export const submitKycV2Schema = z
  .object({
    // Section 1 — Business
    businessType: businessTypeEnum.optional(),
    businessTypeOther: z.string().trim().min(1).max(120).optional(),
    businessRegistrationNumber: z.string().trim().min(1).max(120).optional(),
    businessRegistrationCountry: iso2.optional(),
    businessIndustry: industryEnum.optional(),
    businessIndustryOther: z.string().trim().min(1).max(120).optional(),

    // Section 2 — Contact
    contactFullName: z.string().trim().min(2).max(160).optional(),
    contactPosition: z.string().trim().min(1).max(120).optional(),
    contactPhone: phoneSchema.optional(),
    contactAddressLine1: z.string().trim().min(2).max(200).optional(),
    contactAddressLine2: z.string().trim().max(200).optional(),
    contactCountry: iso2.optional(),

    // Section 3 — Identity (structured only; uploads come later)
    idType: idTypeEnum.optional(),
    idNumber: z.string().trim().min(2).max(60).optional(),
    idExpirationDate: isoFutureDate.optional(),

    // Section 5 — Inventory
    productsStoredDescription: z.string().trim().min(2).max(1000).optional(),
    monthlyInventoryVolume: inventoryVolumeEnum.optional(),
    monthlyOrderVolume: orderVolumeEnum.optional(),
    serviceIntent: serviceIntentEnum.optional(),

    // Section 6 — Shipping & ops
    primaryShippingCountries: z.string().trim().min(2).max(400).optional(),
    requiresReturnsHandling: z.boolean().optional(),
    productHazards: z.array(hazardEnum).max(5).optional(),

    // Final-submit flag. Sections 7 (Payment & Wallet) and 8 (Compliance
    // signature) from the source spec were dropped — the wire-level signal
    // that "this submission is complete; queue it for admin review" is now
    // an explicit boolean rather than the presence of a typed signature.
    // The server stamps `kycSubmittedAt` itself; never trust a client clock.
    submitForReview: z.literal(true).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    // Final submission: every required input must be present. Optional-only
    // fields are the "OTHER" free-text discriminators + address line 2.
    if (!data.submitForReview) return;

    const requiredKeys: Array<keyof typeof data> = [
      "businessType",
      "businessRegistrationCountry",
      "businessIndustry",
      "contactFullName",
      "contactPosition",
      "contactPhone",
      "contactAddressLine1",
      "contactCountry",
      "idType",
      "idNumber",
      "idExpirationDate",
      "productsStoredDescription",
      "monthlyInventoryVolume",
      "monthlyOrderVolume",
      "serviceIntent",
      "primaryShippingCountries",
      "requiresReturnsHandling",
      "productHazards",
    ];
    for (const key of requiredKeys) {
      const v = data[key];
      const missing =
        v === undefined ||
        v === null ||
        (typeof v === "string" && v.length === 0) ||
        (Array.isArray(v) && v.length === 0);
      if (missing) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key as string],
          message: "Required to submit for review.",
        });
      }
    }

    // OTHER discriminators — if the vendor picked OTHER they must fill in
    // the free-text twin. We only enforce this on final submit so the
    // step-by-step wizard can persist the OTHER pick before the text input
    // has been typed.
    if (data.businessType === "OTHER" && !data.businessTypeOther) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["businessTypeOther"],
        message: "Describe the business type.",
      });
    }
    if (data.businessIndustry === "OTHER" && !data.businessIndustryOther) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["businessIndustryOther"],
        message: "Describe the industry.",
      });
    }
  });

export type SubmitKycV2Input = z.infer<typeof submitKycV2Schema>;
