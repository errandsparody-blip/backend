import { Module } from "@nestjs/common";

import { HibpService } from "../../common/hibp.service";
import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";

import { TeamPublicController } from "./team-public.controller";
import { TeamController } from "./team.controller";
import { TeamService } from "./team.service";

@Module({
  imports: [AuditModule, AuthModule],
  controllers: [TeamController, TeamPublicController],
  providers: [TeamService, HibpService],
})
export class TeamModule {}
