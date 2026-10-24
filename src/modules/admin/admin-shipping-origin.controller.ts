/**
 * Shipping origin (sender "ship from") diagnostics.
 *
 *   GET /v1/admin/shipping/origin
 *
 * Read-only. Surfaces the EXACT sender address — including the phone and
 * email — that the platform sends to Shippo on every shipment as
 * `address_from`. Shippo prints the label's sender/return phone from this
 * payload, NOT from the saved address in the Shippo dashboard, so this is
 * the authoritative place to confirm what will appear on labels.
 *
 * The values are environment-derived configuration (the `WAREHOUSE_FROM_*`
 * variables). To change the number on labels, update `WAREHOUSE_FROM_PHONE`
 * in the deployment environment and redeploy — then void/recreate any
 * unused labels bought before the change. None of these fields are secret
 * (no API keys are exposed here).
 *
 * Available to ADMIN and SUPER_ADMIN so operators can verify the live
 * value without deployment access.
 */

import { Controller, Get } from "@nestjs/common";
import { Role } from "@prisma/client";

import { Roles } from "../../common/decorators/roles.decorator";
import { ShippoService } from "../integrations/shippo/shippo.service";

@Controller({ path: "admin/shipping", version: "1" })
@Roles(Role.SUPER_ADMIN, Role.ADMIN)
export class AdminShippingOriginController {
  constructor(private readonly shippo: ShippoService) {}

  @Get("origin")
  getOrigin() {
    const address = this.shippo.getShipFromAddress();
    return {
      // The exact `address_from` block sent to Shippo on every shipment.
      // Shippo reuses it as the return address too (we send no separate
      // address_return), so this phone is both the sender and return phone.
      address,
      // Whether a live Shippo API key is configured. When false the system
      // is in stub mode and no real labels are produced.
      shippoConfigured: this.shippo.isLive(),
      // Operator-facing guidance mirrored from the controller docblock so
      // the UI can render it without hardcoding copy.
      note:
        "This is the sender/return address sent to Shippo on every label. " +
        "The phone prints from this value (WAREHOUSE_FROM_PHONE), not from " +
        "the Shippo dashboard. To change it, update WAREHOUSE_FROM_PHONE in " +
        "the deployment environment and redeploy, then void and recreate any " +
        "unused labels bought before the change.",
      // The environment variable names behind each field, so an operator can
      // tell their deployer exactly what to change.
      sources: {
        name: "WAREHOUSE_FROM_NAME",
        street1: "WAREHOUSE_FROM_STREET1",
        street2: "WAREHOUSE_FROM_STREET2",
        city: "WAREHOUSE_FROM_CITY",
        state: "WAREHOUSE_FROM_STATE",
        zip: "WAREHOUSE_FROM_ZIP",
        phone: "WAREHOUSE_FROM_PHONE",
        email: "WAREHOUSE_FROM_EMAIL",
      },
    };
  }
}
