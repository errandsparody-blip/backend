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

  // Shippo — fulfillment carrier integration. Replaces the earlier EasyPost
  // integration; chosen for the simpler test-token flow that doesn't gate
  // sandbox use behind business verification.
  //
  // SHIPPO_API_KEY accepts two forms:
  //   shippo_test_… — sandbox, no real postage, free
  //   shippo_live_… — production, real labels, debits the Shippo wallet
  // When unset, ShippoService runs in stub mode (synthetic rates + fake
  // tracking numbers) so local dev works without an account.
  SHIPPO_API_KEY: z
    .string()
    .regex(/^shippo_(live|test)_[A-Za-z0-9]{20,}$/, "Must be a valid Shippo API key (shippo_live_… or shippo_test_…).")
    .optional(),
  // Path-secret used as first-pass defense on the webhook endpoint. Shippo
  // does not offer HMAC signing on webhooks (their model is "URL is the
  // secret"), so we put the secret on the URL query string and additionally
  // re-fetch the tracker from Shippo's API on every event to verify state
  // independently of the payload.
  SHIPPO_WEBHOOK_SECRET: z.string().optional(),
  // Outbound HTTP timeout for Shippo REST calls. 8s default — Shippo's rate
  // endpoint can take 3–5s while it polls carriers, but anything over 10s
  // indicates a real problem.
  SHIPPO_TIMEOUT_MS: z.coerce.number().int().positive().max(30_000).default(8_000),
  // Warehouse origin address used as the "from" for outbound shipments. Hard-
  // coded for v1 because we only operate one US warehouse; promote to a per-
  // warehouse row when we add a second. State + postal code are required for
  // rate calculation; the rest is only used on actual label purchase.
  WAREHOUSE_FROM_NAME: z.string().min(1).default("USA Errands"),
  WAREHOUSE_FROM_STREET1: z.string().min(1).default("1 Warehouse Way"),
  WAREHOUSE_FROM_STREET2: z.string().optional(),
  WAREHOUSE_FROM_CITY: z.string().min(1).default("Miami"),
  WAREHOUSE_FROM_STATE: z
    .string()
    .regex(/^[A-Z]{2}$/, "Two-letter US state code.")
    .default("FL"),
  WAREHOUSE_FROM_ZIP: z
    .string()
    .regex(/^\d{5}(-\d{4})?$/, "US ZIP (5 or 9 digit).")
    .default("33101"),
  WAREHOUSE_FROM_PHONE: z.string().min(7).default("+13055551212"),
  // USPS requires the sender's email on every shipment record (used for
  // delivery exception notifications + return-to-sender alerts). Without
  // it, Shippo's `POST /transactions/` 503s with "address_from.email
  // must not be empty." Default to the platform's noreply alias which
  // is operationally monitored.
  WAREHOUSE_FROM_EMAIL: z
    .string()
    .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, "Must be a plain email address.")
    .default("hello@myusaerrands.com"),

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
    .default("USA Errands <noreply@myusaerrands.com>"),
  // Reply-to address surfaced in transactional templates ("Reply to
  // hello@…" footer). Separate from EMAIL_FROM so the From line can
  // be a noreply alias while replies still land in the team inbox.
  EMAIL_REPLY_TO: z
    .string()
    .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, "Must be a plain email address.")
    .default("hello@myusaerrands.com"),
  // Comma-separated list of operations email addresses that receive admin
  // alerts (new PSN submitted, new shopper request, KYC submitted, buyer
  // message in shopper thread). Empty list = no admin emails (in-app
  // notifications still fire). Useful in dev so test traffic doesn't spam ops.
  OPS_ALERT_EMAILS: z
    .string()
    .optional()
    .transform((s) =>
      (s ?? "")
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v.length > 0 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)),
    ),

  // Cloudflare R2 — Personal Shopper attachment uploads (P6).
  // R2 is S3-compatible; we presign PUTs with AWS SigV4 against the
  // account-scoped S3 endpoint. All four values are required to enable
  // uploads; with any missing the upload endpoints return a structured 503.
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  // The bucket holding shopper-attachment objects.
  R2_BUCKET: z.string().optional(),
  // Public read URL prefix (CDN-fronted Cloudflare worker, custom domain,
  // or `https://pub-<hash>.r2.dev/<bucket>/`). The presign endpoint composes
  // the final URL by appending the object key. No trailing slash.
  R2_PUBLIC_BASE_URL: z
    .string()
    .url("Must be a full URL like https://attachments.myusaerrands.com")
    .optional(),
})
  .superRefine((cfg, ctx) => {
    if (cfg.EMAIL_PROVIDER === "resend" && !cfg.RESEND_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["RESEND_API_KEY"],
        message: "Required when EMAIL_PROVIDER=resend.",
      });
    }
    if (cfg.NODE_ENV === "production" && !cfg.SHIPPO_WEBHOOK_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SHIPPO_WEBHOOK_SECRET"],
        message: "Required in production.",
      });
    }
    if (cfg.NODE_ENV === "production" && !cfg.SHIPPO_API_KEY) {
      // Shippo stub mode in production would mean we'd synthesize fake
      // tracking numbers — which would silently break customer order flow
      // (no real label, no shipment) without anyone noticing. Hard-fail at
      // boot instead.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SHIPPO_API_KEY"],
        message: "Required in production.",
      });
    }
    // R2 is all-or-nothing — partial settings would fail at runtime in
    // a confusing way. Validate the group atomically.
    const r2Set = [
      cfg.R2_ACCOUNT_ID,
      cfg.R2_ACCESS_KEY_ID,
      cfg.R2_SECRET_ACCESS_KEY,
      cfg.R2_BUCKET,
      cfg.R2_PUBLIC_BASE_URL,
    ].filter((v) => v && v.length > 0).length;
    if (r2Set !== 0 && r2Set !== 5) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["R2_BUCKET"],
        message:
          "Set ALL of R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE_URL — or none.",
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
