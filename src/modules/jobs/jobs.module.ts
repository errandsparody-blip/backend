import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";

import { AuditModule } from "../audit/audit.module";
import { WalletModule } from "../wallet/wallet.module";

import { ReassessmentJob } from "./reassessment.job";
import { LedgerReconciliationJob } from "./reconcile.job";
import { StorageBillingJob } from "./storage-billing.job";

@Module({
  imports: [ScheduleModule.forRoot(), AuditModule, WalletModule],
  providers: [LedgerReconciliationJob, StorageBillingJob, ReassessmentJob],
})
export class JobsModule {}
