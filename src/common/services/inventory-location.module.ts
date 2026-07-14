/**
 * InventoryLocationModule — @Global() wrapper for the inventory-location
 * service. Same pattern as PackagingLibraryModule; a single instance
 * keeps the 5 s cache warm across every consumer.
 */

import { Global, Module } from "@nestjs/common";

import { InventoryLocationService } from "./inventory-location.service";

@Global()
@Module({
  providers: [InventoryLocationService],
  exports: [InventoryLocationService],
})
export class InventoryLocationModule {}
