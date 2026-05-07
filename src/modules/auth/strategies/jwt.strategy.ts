/**
 * Passport JWT strategy. Validates the access token (HS256, signed with
 * JWT_ACCESS_SECRET). The decoded payload is attached to req.user.
 */

import { Injectable } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";

import { loadConfig } from "../../../common/config";
import type { AuthenticatedUser } from "../../../common/guards/jwt-auth.guard";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, "jwt") {
  constructor() {
    const cfg = loadConfig();
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: Buffer.from(cfg.JWT_ACCESS_SECRET, "base64"),
      algorithms: ["HS256"],
    });
  }

  validate(payload: AuthenticatedUser): AuthenticatedUser {
    // Passport calls this when the signature is valid and not expired.
    // Additional checks (e.g., session revocation) happen in services.
    return payload;
  }
}
