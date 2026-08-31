import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";

import { HibpService } from "../../common/hibp.service";
import { AuditModule } from "../audit/audit.module";
import { ReferralModule } from "../referral/referral.module";
import { AgreementService } from "../vendors/agreement.service";

import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { MfaService } from "./mfa.service";
import { JwtStrategy } from "./strategies/jwt.strategy";
import { TokenService } from "./token.service";

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: "jwt", session: false }),
    JwtModule.register({}),
    AuditModule,
    ReferralModule,
  ],
  controllers: [AuthController],
  // AgreementService is listed directly (rather than importing VendorModule)
  // to avoid pulling VendorModule's controllers + transitively the
  // AgreementVersionGuard wiring into AuthModule. The service is stateless
  // and PrismaService is global, so a second provider instance behaves
  // identically to the one VendorModule exposes — both read the same row.
  providers: [
    AuthService,
    TokenService,
    MfaService,
    JwtStrategy,
    HibpService,
    AgreementService,
  ],
  exports: [AuthService, TokenService],
})
export class AuthModule {}
