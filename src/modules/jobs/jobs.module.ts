import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";

import { AuditModule } from "../audit/audit.module";
import { IntegrationModule } from "../integration/integration.module";
import { StorefrontModule } from "../storefront/storefront.module";
import { WalletModule } from "../wallet/wallet.module";

import { HeldOrderSweepJob } from "./held-order-sweep.job";
import { ReassessmentJob } from "./reassessment.job";
import { LedgerReconciliationJob } from "./reconcile.job";
import { StorageBillingJob } from "./storage-billing.job";
import { StorefrontAbandonedSweepJob } from "./storefront-abandoned-sweep.job";

@Module({
  imports: [
    ScheduleModule.forRoot(),
    AuditModule,
    WalletModule,
    IntegrationModule,
    StorefrontModule,
  ],
  providers: [
    LedgerReconciliationJob,
    StorageBillingJob,
    ReassessmentJob,
    HeldOrderSweepJob,
    StorefrontAbandonedSweepJob,
  ],
})
export class JobsModule {}
