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
