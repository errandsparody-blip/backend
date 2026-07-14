/**
 * PagePermissionModule — @Global() wrapper for PagePermissionService.
 *
 * Introduced by migration 0039. The service is stateful (in-memory
 * cache of the admin overrides config row), so it MUST be a
 * singleton across the whole process — a per-module instance would
 * split the cache and defeat its point. @Global registration is the
 * cleanest way to achieve that in NestJS.
 *
 * Both the app-level PagePermissionGuard AND any feature-module
 * controller (e.g. the admin config endpoints in phase 1d) can then
 * inject the same instance without either side needing to import a
 * feature module.
 */

import { Global, Module } from "@nestjs/common";

import { PagePermissionService } from "./page-permission.service";

@Global()
@Module({
  providers: [PagePermissionService],
  exports: [PagePermissionService],
})
export class PagePermissionModule {}
