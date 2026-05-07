import { Module } from "@nestjs/common";

import { SmartyService } from "./smarty.service";

@Module({
  providers: [SmartyService],
  exports: [SmartyService],
})
export class SmartyModule {}
