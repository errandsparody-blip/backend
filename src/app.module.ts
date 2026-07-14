/**
 * Root application module. Wires global guards, throttler, logger, and feature
 * modules. JwtAuthGuard is global by default — opt out with @Public().
 *
 * Implementation Plan §3, §4.5 (rate limiting).
 */

import { randomUUID } from "node:crypto";

import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { LoggerModule } from "nestjs-pino";

import { loadConfig } from "./common/config";
import { CryptoModule } from "./common/crypto.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { IdempotencyModule } from "./common/idempotency.module";
import { AgreementVersionGuard } from "./common/guards/agreement-version.guard";
import { JwtAuthGuard } from "./common/guards/jwt-auth.guard";
import { PagePermissionGuard } from "./common/guards/page-permission.guard";
import { RolesGuard } from "./common/guards/roles.guard";
import { InventoryLocationModule } from "./common/services/inventory-location.module";
import { PackagingLibraryModule } from "./common/services/packaging-library.module";
import { PagePermissionModule } from "./common/services/page-permission.module";
import { ShippingPointModule } from "./common/services/shipping-point.module";
import { PrismaModule } from "./common/prisma.module";
import { AdminModule } from "./modules/admin/admin.module";
import { AuditModule } from "./modules/audit/audit.module";
import { AuthModule } from "./modules/auth/auth.module";
import { EmailModule } from "./modules/email/email.module";
import { ExportModule } from "./modules/exports/export.module";
import { FeesModule } from "./modules/fees/fees.module";
import { HealthModule } from "./modules/health/health.module";
import { IntegrationModule } from "./modules/integration/integration.module";
import { KycModule } from "./modules/integrations/kyc/kyc.module";
import { R2Module } from "./modules/integrations/r2/r2.module";
import { StripeModule } from "./modules/integrations/stripe/stripe.module";
import { JobsModule } from "./modules/jobs/jobs.module";
import { MarketingModule } from "./modules/marketing/marketing.module";
import { NotificationModule } from "./modules/notifications/notification.module";
import { OrderModule } from "./modules/orders/order.module";
import { ProductModule } from "./modules/products/product.module";
import { PsnModule } from "./modules/psn/psn.module";
import { ReturnModule } from "./modules/returns/return.module";
import { ShopperModule } from "./modules/shopper/shopper.module";
import { SkuModule } from "./modules/sku/sku.module";
import { TeamModule } from "./modules/team/team.module";
import { TrackingModule } from "./modules/tracking/tracking.module";
import { VendorModule } from "./modules/vendors/vendor.module";
import { WalletModule } from "./modules/wallet/wallet.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: () => loadConfig(),
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: loadConfig().LOG_LEVEL,
        autoLogging: true,
        // Generate / propagate a correlation id per request.
        genReqId: (req) => {
          const incoming = (req.headers["x-correlation-id"] as string | undefined) ?? "";
          const id = incoming || randomUUID();
          // Make it visible to handlers via req.correlationId.
          (req as unknown as { correlationId?: string }).correlationId = id;
          return id;
        },
        customProps: () => ({ service: "usa-errands-api" }),
        // Redaction — never log auth/PII fields.
        redact: {
          paths: [
            "req.headers.authorization",
            "req.headers.cookie",
            "req.body.password",
            "req.body.newPassword",
            "req.body.code",
            "req.body.recoveryCode",
            "req.body.pendingSecret",
          ],
          censor: "[redacted]",
        },
        transport:
          loadConfig().NODE_ENV === "development"
            ? { target: "pino-pretty", options: { translateTime: "SYS:standard", singleLine: true } }
            : undefined,
      },
    }),
    ThrottlerModule.forRoot([
      {
        name: "default",
        ttl: loadConfig().RATE_LIMIT_DEFAULT_WINDOW_SECONDS * 1000,
        limit: loadConfig().RATE_LIMIT_DEFAULT_MAX,
      },
    ]),
    PrismaModule,
    CryptoModule,
    IdempotencyModule,
    // Migration 0039 — PagePermissionService needs to be a process-
    // wide singleton (cache lives inside it). The @Global() module
    // exposes it to both the app-level guard and any feature-module
    // controller in one wiring.
    PagePermissionModule,
    // Migration 0040 — same reasoning: ShippingPointService caches
    // the range-table config, so it must be a process-wide
    // singleton. @Global() wrapper keeps every future consumer
    // (order create in Phase B, wizard preview, wallet validator)
    // one injection away.
    ShippingPointModule,
    // Migration 0043 — Packaging library. Global cache means every
    // pack-modal read (per-operator, per-order) hits the same 5 s
    // memoised list.
    PackagingLibraryModule,
    // Migration 0045 — Warehouse inventory locations. Also global
    // (5 s cache) — the pack modal and PSN receive UI both read
    // via SKU → location lookup.
    InventoryLocationModule,
    AuditModule,
    EmailModule,
    NotificationModule,
    AuthModule,
    HealthModule,
    VendorModule,
    ProductModule,
    SkuModule,
    PsnModule,
    WalletModule,
    OrderModule,
    IntegrationModule,
    ReturnModule,
    ShopperModule,
    ExportModule,
    FeesModule,
    TeamModule,
    TrackingModule,
    KycModule,
    R2Module,
    StripeModule,
    JobsModule,
    MarketingModule,
    AdminModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    // Migration 0039 — PagePermissionGuard runs AFTER RolesGuard.
    // A route with no @RequiresPage(...) decorator passes through
    // as a no-op, so this is safe to enable globally without
    // touching existing controllers. Ordered here (rather than
    // before RolesGuard) so an unauthorised role short-circuits
    // before we hit the config lookup. PagePermissionService is
    // provided by the @Global()-flagged PagePermissionModule below
    // so both this guard AND feature-module controllers see the
    // same cached singleton.
    { provide: APP_GUARD, useClass: PagePermissionGuard },
    // AgreementVersionGuard runs after JWT + Roles. NestJS executes APP_GUARDs
    // in order, so a JWT failure short-circuits before we hit the agreement
    // check (we never need to query Postgres for an unauth'd request).
    { provide: APP_GUARD, useClass: AgreementVersionGuard },
  ],
})
export class AppModule {}
