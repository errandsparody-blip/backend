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

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true,
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

  // CORS — explicit allowlist with credentials so cookies flow.
  app.enableCors({
    origin: [cfg.WEB_PUBLIC_URL],
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "X-Correlation-Id", "Idempotency-Key"],
    exposedHeaders: ["X-Correlation-Id"],
    maxAge: 600,
  });

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
