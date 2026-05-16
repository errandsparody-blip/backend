/**
 * Auth Zod schemas. Mirror file in usa-errands-web/src/lib/schemas/auth.ts.
 * Keep them in sync — both frontend and backend validate against this shape.
 *
 * Implementation Plan §4.1, §11.
 */

import { z } from "zod";

// =============================================================================
// Password policy — Implementation Plan §4.1.
// NIST 800-63B aligned. HIBP banned-password check happens server-side.
// =============================================================================
export const passwordSchema = z
  .string()
  .min(12, "Password must be at least 12 characters.")
  .max(256, "Password must be at most 256 characters.");

export const emailSchema = z
  .string()
  .min(3)
  .max(254)
  .email("Enter a valid email address.")
  .transform((s) => s.trim().toLowerCase());

export const totpCodeSchema = z
  .string()
  .regex(/^\d{6}$/, "Enter the six-digit code from your authenticator app.");

export const recoveryCodeFormatSchema = z
  .string()
  .regex(
    /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i,
    "Enter a valid recovery code.",
  );

// =============================================================================
// Endpoint payloads
// =============================================================================
export const signupSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  businessName: z.string().min(2).max(120),
  country: z.string().length(2).toUpperCase(),
  // Vendor must positively tick the agreement checkbox above the "Create
  // account" button. `z.literal(true)` rejects anything that isn't true.
  // AuthService writes `agreementAcceptedAt = now()` + the current version
  // onto the new Vendor row so the post-login AgreementVersionGuard sees
  // the vendor as up-to-date and never redirects them to
  // /legal/vendor-agreement?reaccept=1.
  agreementAccepted: z.literal(true, {
    errorMap: () => ({
      message: "You must accept the Vendor Agreement to continue.",
    }),
  }),
});
export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Password is required."),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const verifyMfaSchema = z.object({
  challengeToken: z.string().min(20),
  code: totpCodeSchema,
});
export type VerifyMfaInput = z.infer<typeof verifyMfaSchema>;

export const recoveryMfaSchema = z.object({
  challengeToken: z.string().min(20),
  recoveryCode: recoveryCodeFormatSchema,
});
export type RecoveryMfaInput = z.infer<typeof recoveryMfaSchema>;

export const enrollMfaConfirmSchema = z.object({
  code: totpCodeSchema,
});
export type EnrollMfaConfirmInput = z.infer<typeof enrollMfaConfirmSchema>;

export const forgotPasswordSchema = z.object({
  email: emailSchema,
});
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({
  token: z.string().min(20),
  newPassword: passwordSchema,
  // Accept both `undefined` (key omitted) and "" (front-end serialised empty
  // input) as "no MFA code supplied". Without the literal-empty coercion,
  // a stray "" submission would 400 with a misleading "must be 6 digits"
  // message even when the account has no MFA enrolled.
  mfaCode: totpCodeSchema
    .optional()
    .or(z.literal("").transform(() => undefined)),
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

// Email verification — numeric code typed into the form, not a click-through
// link. Code is delivered via email; the form posts (email, code) back here.
//
// The TokenService defaults to 8 digits as of the M-4 hardening (100M search
// space, well past what an opportunistic attacker can brute-force against the
// /auth/verify-email rate limit). We accept the 6–8 digit range so any
// legacy 6-digit codes that were already in flight when the change rolled out
// still verify cleanly; once those expire (≤ 15 min after the deploy that
// flipped the default) this can be tightened to `^\d{8}$`.
export const verifyEmailCodeSchema = z
  .string()
  .regex(/^\d{6,8}$/, "Enter the code from your email.");

export const verifyEmailSchema = z.object({
  email: emailSchema,
  code: verifyEmailCodeSchema,
});
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;

export const resendVerifyEmailSchema = z.object({
  email: emailSchema,
});
export type ResendVerifyEmailInput = z.infer<typeof resendVerifyEmailSchema>;
