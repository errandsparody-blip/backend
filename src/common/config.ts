/**
 * Centralised, Zod-validated runtime configuration. Imported via NestJS
 * ConfigModule.forRoot({ load: [appConfig], validate }). Missing or malformed
 * env vars halt the boot — no silent defaults.
 *
 * Implementation Plan §4.8.
 */

import { z } from "zod";

const base64Min = (minBytes: number) =>
  z
    .string()
    .min(1, "Required")
    .refine(
      (v) => {
        try {
          return Buffer.from(v, "base64").length >= minBytes;
        } catch {
          return false;
        }
      },
      { message: `Must decode to at least ${minBytes} bytes from base64.` },
    );

const base64Exact = (bytes: number) =>
  z
    .string()
    .min(1, "Required")
    .refine(
      (v) => {
        try {
          return Buffer.from(v, "base64").length === bytes;
        } catch {
          return false;
        }
      },
      { message: `Must decode to exactly ${bytes} bytes from base64.` },
    );

const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "staging", "production"]),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  // Server
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_PUBLIC_URL: z.string().url(),
  /// Canonical web origin — used in email templates and as the *primary*
  /// CORS allow-list entry. Must be a single URL.
  WEB_PUBLIC_URL: z.string().url(),
  /// Optional comma-separated list of additional origins to allow via CORS.
  /// Useful for serving both apex + www, preview deployments, or staging
  /// reviewers. Each value must be a full origin (https://example.com), no
  /// trailing slash. Empty / unset = only WEB_PUBLIC_URL is allowed.
  WEB_ALLOWED_ORIGINS: z
    .string()
    .optional()
    .transform((s) =>
      (s ?? "")
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v.length > 0),
    ),

  // Database / Redis
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  // JWT
  JWT_ACCESS_SECRET: base64Min(32),
  JWT_REFRESH_SECRET: base64Min(32),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(2592000),
  STEP_UP_THRESHOLD_CENTS: z.coerce.number().int().nonnegative().default(50000),

  // Encryption
  ENCRYPTION_MASTER_KEY: base64Exact(32),

  // Cookies
  COOKIE_DOMAIN: z.string().min(1),
  COOKIE_SECURE: z.coerce.boolean().default(false),
  COOKIE_REFRESH_NAME: z.string().min(1).default("ue_rt"),

  // Rate limiting
  RATE_LIMIT_AUTH_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_DEFAULT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_DEFAULT_MAX: z.coerce.number().int().positive().default(120),

  // Observability
  SENTRY_DSN: z.string().optional(),
  SENTRY_ENV: z.string().default("development"),

  // EasyPost — P3.9 + P5.5. When set, the EasyPost tracking webhook
  // verifies HMAC against this secret. Optional in dev/test; required in
  // production (enforced via the superRefine below).
  EASYPOST_WEBHOOK_SECRET: z.string().optional(),

  // Email — Implementation Plan §6.8.
  // EMAIL_PROVIDER:
  //   "resend"  — uses RESEND_API_KEY, sends real email
  //   "console" — logs the message to the pino logger; the dev/test default
  EMAIL_PROVIDER: z.enum(["resend", "console"]).default("console"),
  RESEND_API_KEY: z.string().optional(),
  // From line. RFC 5322 "display-name <local@domain>" is allowed; the regex
  // below is intentionally lenient to permit display names.
  EMAIL_FROM: z
    .string()
    .min(5)
    .regex(/^.+@.+\..+$/, "Must be a valid email or 'Name <email>' header.")
    .default("USA Errands <noreply@usa-errands.com>"),
  EMAIL_REPLY_TO: z.string().email().default("support@usa-errands.com"),
})
  .superRefine((cfg, ctx) => {
    if (cfg.EMAIL_PROVIDER === "resend" && !cfg.RESEND_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["RESEND_API_KEY"],
        message: "Required when EMAIL_PROVIDER=resend.",
      });
    }
    if (cfg.NODE_ENV === "production" && !cfg.EASYPOST_WEBHOOK_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["EASYPOST_WEBHOOK_SECRET"],
        message: "Required in production.",
      });
    }
  });

export type AppConfig = z.infer<typeof ConfigSchema>;

let cached: AppConfig | undefined;

/**
 * Validate environment at boot. Throws with a readable message listing every
 * missing/invalid variable. Cached on success so subsequent calls are cheap.
 */
export function loadConfig(): AppConfig {
  if (cached) return cached;
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid configuration. Check your .env file:\n${issues}\n` +
        `Refer to .env.example for the full list of required variables.`,
    );
  }
  cached = parsed.data;
  return cached;
}

/** Production-safety check. Use in places where `if (env.isProd)` reads better. */
export function isProduction(cfg: AppConfig): boolean {
  return cfg.NODE_ENV === "production";
}
