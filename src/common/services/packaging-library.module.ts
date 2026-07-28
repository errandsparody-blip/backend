/**
 * PackagingLibraryModule — @Global() wrapper for PackagingLibraryService
 * and the Phase N2 CarrierPackagingRegistryService.
 *
 * Both are pure services with no per-request state; a single instance
 * across the process keeps cache hit-rate high on the library and
 * avoids re-allocating the (static) carrier registry list. Same
 * pattern as PagePermissionModule and ShippingPointModule.
 */

import { Global, Module } from "@nestjs/common";

import { CarrierPackagingRegistryService } from "./carrier-packaging-registry";
import { PackagingLibraryService } from "./packaging-library.service";

@Global()
@Module({
  providers: [PackagingLibraryService, CarrierPackagingRegistryService],
  exports: [PackagingLibraryService, CarrierPackagingRegistryService],
})
export class PackagingLibraryModule {}
