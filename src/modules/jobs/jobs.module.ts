import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";

import { AuditModule } from "../audit/audit.module";
import { IntegrationModule } from "../integration/integration.module";
import { WalletModule } from "../wallet/wallet.module";

import { HeldOrderSweepJob } from "./held-order-sweep.job";
import { ReassessmentJob } from "./reassessment.job";
import { LedgerReconciliationJob } from "./reconcile.job";
import { StorageBillingJob } from "./storage-billing.job";

@Module({
  imports: [ScheduleModule.forRoot(), AuditModule, WalletModule, IntegrationModule],
  providers: [LedgerReconciliationJob, StorageBillingJob, ReassessmentJob, HeldOrderSweepJob],
})
export class JobsModule {}
