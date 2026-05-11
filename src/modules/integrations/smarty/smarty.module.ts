import { Module } from "@nestjs/common";

import { ShippoModule } from "../shippo/shippo.module";

import { SmartyService } from "./smarty.service";

@Module({
  // SmartyService delegates address validation to Shippo's API to avoid
  // running two parallel third-party integrations. Importing ShippoModule
  // here gives DI access to ShippoService without polluting downstream
  // module wiring (OrderModule + ReturnModule keep importing SmartyModule
  // exactly as before).
  imports: [ShippoModule],
  providers: [SmartyService],
  exports: [SmartyService],
})
export class SmartyModule {}
