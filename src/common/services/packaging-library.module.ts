/**
 * PackagingLibraryModule — @Global() wrapper for PackagingLibraryService.
 *
 * The service holds an in-process 5 s cache; a single instance across
 * the process keeps cache hit-rate high. Same pattern as
 * PagePermissionModule and ShippingPointModule.
 */

import { Global, Module } from "@nestjs/common";

import { PackagingLibraryService } from "./packaging-library.service";

@Global()
@Module({
  providers: [PackagingLibraryService],
  exports: [PackagingLibraryService],
})
export class PackagingLibraryModule {}
