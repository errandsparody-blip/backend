/**
 * ShippingPointModule — @Global() wrapper for ShippingPointService.
 *
 * The service holds a per-process cache of the range-table config
 * row. To keep cache hit-rate high we MUST have a single instance
 * across the process — a per-module instance would split the cache
 * and defeat the point. @Global() is the cleanest way to guarantee
 * that in NestJS.
 *
 * Same pattern as PagePermissionModule; consistent wiring across
 * the codebase for "cached config-backed services."
 */

import { Global, Module } from "@nestjs/common";

import { ShippingPointService } from "./shipping-point.service";

@Global()
@Module({
  providers: [ShippingPointService],
  exports: [ShippingPointService],
})
export class ShippingPointModule {}
