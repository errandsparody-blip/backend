import { Module } from "@nestjs/common";

import { EmailModule } from "../email/email.module";

import { StorefrontShipmentSyncService } from "./storefront-shipment-sync.service";

// Deliberately tiny: the order-pack pipeline imports THIS (not the whole
// StorefrontModule) to propagate a shipped label back to the storefront order
// + email the buyer, avoiding a heavy/circular module dependency.
@Module({
  imports: [EmailModule],
  providers: [StorefrontShipmentSyncService],
  exports: [StorefrontShipmentSyncService],
})
export class StorefrontShipmentModule {}
