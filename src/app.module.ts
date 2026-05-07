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
import { JwtAuthGuard } from "./common/guards/jwt-auth.guard";
import { RolesGuard } from "./common/guards/roles.guard";
import { PrismaModule } from "./common/prisma.module";
import { AdminModule } from "./modules/admin/admin.module";
import { AuditModule } from "./modules/audit/audit.module";
import { AuthModule } from "./modules/auth/auth.module";
import { EmailModule } from "./modules/email/email.module";
import { ExportModule } from "./modules/exports/export.module";
import { HealthModule } from "./modules/health/health.module";
import { KycModule } from "./modules/integrations/kyc/kyc.module";
import { StripeModule } from "./modules/integrations/stripe/stripe.module";
import { JobsModule } from "./modules/jobs/jobs.module";
import { NotificationModule } from "./modules/notifications/notification.module";
import { OrderModule } from "./modules/orders/order.module";
import { ProductModule } from "./modules/products/product.module";
import { PsnModule } from "./modules/psn/psn.module";
import { ReturnModule } from "./modules/returns/return.module";
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
    ReturnModule,
    ExportModule,
    TeamModule,
    TrackingModule,
    KycModule,
    StripeModule,
    JobsModule,
    AdminModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
