import { Global, Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";

import { EmailService } from "./email.service";

@Global()
@Module({
  imports: [AuditModule],
  providers: [EmailService],
  exports: [EmailService],
})
export class EmailModule {}
