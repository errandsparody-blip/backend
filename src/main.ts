/**
 * Application bootstrap. Sets up:
 *   - Sentry (must be first import so OpenTelemetry can wrap node modules)
 *   - Helmet (security headers)
 *   - CORS (explicit allowlist)
 *   - Cookie parser (for httpOnly refresh-token cookies)
 *   - URI versioning (/v1/...)
 *   - Global validation pipe (whitelist + forbidNonWhitelisted)
 *   - Swagger UI in non-production only
 *
 * Implementation Plan §3.4, §4.5, §9.2 (observability).
 */

// MUST be the very first import — Sentry instruments low-level Node modules
// at require-time and silently misses anything already loaded.
import "./instrument";

import { ValidationPipe, VersioningType } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { Logger } from "nestjs-pino";

import { AppModule } from "./app.module";
import { loadConfig } from "./common/config";
import { Sentry } from "./common/sentry";

async function bootstrap(): Promise<void> {
  // Validate config before instantiating Nest. Halts boot on bad env.
  const cfg = loadConfig();

  // CORS is configured at app construction so the cors middleware is the
  // FIRST thing in the Express stack, ahead of helmet. That way preflights
  // (OPTIONS) are answered cleanly with allow-origin/allow-credentials before
  // any other middleware can interfere with the response.
  //
  // The allow-list is the canonical WEB_PUBLIC_URL plus any extras from
  // WEB_ALLOWED_ORIGINS. Entries can be either:
  //   - An exact origin     (https://myusaerrands.com)
  //   - A glob with `*`     (https://*-blips-projects.vercel.app)
  //
  // Glob support is here because Vercel preview deploys land on a unique
  // hash per build (frontend-<hash>-<project>.vercel.app), making exact
  // enumeration impossible. One glob entry covers the whole project's
  // preview range without re-deploying the API on every PR build.
  //
  // The `*` translates to one-or-more of `[a-zA-Z0-9-]` — broad enough
  // for Vercel hashes (alnum + hyphens) but tight enough to refuse
  // `https://evil.com/.errandsparody-blips-projects.vercel.app` style
  // homograph attempts.
  const rawEntries = Array.from(
    new Set([cfg.WEB_PUBLIC_URL, ...cfg.WEB_ALLOWED_ORIGINS]),
  );
  const exactOrigins = new Set<string>();
  const globPatterns: RegExp[] = [];
  for (const entry of rawEntries) {
    if (entry.includes("*")) {
      // Escape regex metacharacters, then expand `*` → `[a-zA-Z0-9-]+`.
      const escaped = entry
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[a-zA-Z0-9-]+");
      globPatterns.push(new RegExp(`^${escaped}$`));
    } else {
      exactOrigins.add(entry);
    }
  }
  const isOriginAllowed = (origin: string): boolean => {
    if (exactOrigins.has(origin)) return true;
    return globPatterns.some((re) => re.test(origin));
  };

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true,
    cors: {
      // Function form (vs. array of strings) so we can apply both exact
      // and glob matching above. Callback signature comes from the cors
      // npm package; a falsy origin (no Origin header — same-origin or
      // curl-style requests) is always allowed since CORS only gates
      // cross-origin browser fetches.
      origin: (
        origin: string | undefined,
        callback: (err: Error | null, allow?: boolean) => void,
      ) => {
        if (!origin || isOriginAllowed(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error(`Origin ${origin} not allowed by CORS allowlist.`));
      },
      credentials: true,
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Authorization", "Content-Type", "X-Correlation-Id", "Idempotency-Key"],
      exposedHeaders: ["X-Correlation-Id"],
      maxAge: 600,
    },
  });
  app.useLogger(app.get(Logger));

  app.set("trust proxy", 1); // sit behind Cloudflare/Railway

  // Security headers — Implementation Plan §4.5.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"], // tighten when CSS-in-JS lands
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
        },
      },
      // The API is intentionally consumed cross-origin by the web app on a
      // different parent domain (Vercel ↔ Railway). Helmet defaults this to
      // "same-origin" since v6, which combines with COEP to break legitimate
      // cross-origin fetches in some browsers. Explicitly relax to
      // "cross-origin" — CORS itself remains the gate via the allowlist above.
      crossOriginResourcePolicy: { policy: "cross-origin" },
      crossOriginEmbedderPolicy: false, // not needed; we don't embed cross-origin
      hsts: {
        maxAge: 63072000, // 2 years
        includeSubDomains: true,
        preload: true,
      },
      // strict-origin-when-cross-origin: send only the origin (not the path)
      // when navigating cross-origin over HTTPS, and nothing on HTTPS→HTTP.
      // Prevents path-level info (e.g., /admin/finance/credit/<vendorId>) from
      // leaking via Referer to third-party origins.
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    }),
  );

  app.use(cookieParser());

  // URI versioning: /v1/...
  app.enableVersioning({ type: VersioningType.URI });

  // Validation: whitelist + reject extra fields. DTOs use class-validator,
  // most controllers use ZodValidationPipe directly, but this catches anything
  // that goes through class-validator paths (kept for compatibility).
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      transform: true,
    }),
  );

  // Swagger UI only in non-production environments.
  if (cfg.NODE_ENV !== "production") {
    const config = new DocumentBuilder()
      .setTitle("USA Errands API")
      .setDescription("REST API for the USA Errands platform.")
      .setVersion("0.1.0")
      .addBearerAuth()
      .build();
    const doc = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup("v1/docs", app, doc);
  }

  // Sentry's Express error handler. Catches anything that escapes Nest
  // (rare; AllExceptionsFilter handles 99% of paths) and ensures the request
  // context is attached to the captured event. Must be installed AFTER all
  // routes are registered, BEFORE app.listen().
  Sentry.setupExpressErrorHandler(app.getHttpAdapter().getInstance());

  // Cloud platforms (Railway, Heroku, Cloud Run, Fly.io) inject a PORT env
  // var and expect the container to bind to it. We honour PORT when present
  // and fall back to the validated API_PORT for local dev / tests. Bind on
  // 0.0.0.0 explicitly — some Node/Nest combinations bind to ::1 by default
  // inside containers, which the Railway proxy cannot reach.
  const port = Number(process.env.PORT) || cfg.API_PORT;
  await app.listen(port, "0.0.0.0");
  // eslint-disable-next-line no-console
  console.warn(`[usa-errands-api] listening on :${port} (${cfg.NODE_ENV})`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Boot failed:", err);
  process.exit(1);
});
