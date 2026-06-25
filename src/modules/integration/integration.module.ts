/**
 * IntegrationModule (Migration 0038) — storefront order ingestion.
 *
 * Wires the public API-key-authed ingestion endpoint, the portal-side key /
 * settings management, and the ingestion service that reuses the wallet /
 * shipping / address primitives. Exports IntegrationOrderService so the wallet
 * deposit hook and the held-order cron sweep can trigger auto-release.
 *
 * CryptoService (key hashing) comes from the @Global CryptoModule, so it isn't
 * imported here. PrismaService is global likewise.
 */

import { Module } from "@nestjs/common";

import { IdempotencyModule } from "../../common/idempotency.module";
import { AuditModule } from "../audit/audit.module";
import { ShippoModule } from "../integrations/shippo/shippo.module";
import { SmartyModule } from "../integrations/smarty/smarty.module";
import { NotificationModule } from "../notifications/notification.module";
import { WalletModule } from "../wallet/wallet.module";

import { ApiKeyGuard } from "../../common/guards/api-key.guard";

import { IntegrationController } from "./integration.controller";
import { IntegrationOrderService } from "./integration-order.service";
import { VendorApiKeyService } from "./vendor-api-key.service";
import { VendorIntegrationController } from "./vendor-integration.controller";

@Module({
  imports: [
    AuditModule,
    WalletModule,
    SmartyModule,
    ShippoModule,
    IdempotencyModule,
    NotificationModule,
  ],
  controllers: [IntegrationController, VendorIntegrationController],
  providers: [IntegrationOrderService, VendorApiKeyService, ApiKeyGuard],
  exports: [IntegrationOrderService],
})
export class IntegrationModule {}
