/**
 * Vendor-facing (JWT-authed) management for the storefront integration:
 * API keys + default shipping settings. Rendered by the portal's
 * Settings → Integration page.
 *
 *   GET    /v1/integration/settings        — defaults + existing keys (no secrets)
 *   PATCH  /v1/integration/settings        — update default shipping prefs
 *   POST   /v1/integration/keys            — mint a key (full value returned ONCE)
 *   DELETE /v1/integration/keys/:id        — revoke a key
 *
 * Gated by VENDOR / VENDOR_SUB_USER + TenantGuard like every vendor route.
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { Role } from "@prisma/client";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { TenantGuard } from "../../common/guards/tenant.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  createApiKeySchema,
  updateIntegrationSettingsSchema,
  type CreateApiKeyInput,
  type UpdateIntegrationSettingsInput,
} from "../../common/schemas/integration.schema";

import { VendorApiKeyService } from "./vendor-api-key.service";

@Controller({ path: "integration", version: "1" })
@Roles(Role.VENDOR, Role.VENDOR_SUB_USER)
@UseGuards(TenantGuard)
export class VendorIntegrationController {
  constructor(private readonly keys: VendorApiKeyService) {}

  @Get("settings")
  getSettings(@CurrentUser() user: AuthenticatedUser) {
    return this.keys.getSettings(user.vendorId!);
  }

  @Patch("settings")
  updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(updateIntegrationSettingsSchema))
    body: UpdateIntegrationSettingsInput,
  ) {
    return this.keys.updateSettings(user.vendorId!, user.sub, body);
  }

  @Post("keys")
  @HttpCode(HttpStatus.CREATED)
  createKey(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createApiKeySchema)) body: CreateApiKeyInput,
  ) {
    return this.keys.createKey(user.vendorId!, user.sub, body.name);
  }

  @Delete("keys/:id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeKey(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    await this.keys.revokeKey(user.vendorId!, user.sub, id);
  }
}
