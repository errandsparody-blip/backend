import { Global, Module } from "@nestjs/common";

import { R2Service } from "./r2.service";

/**
 * R2Module — global so any controller can inject R2Service without re-declaring
 * the import. The service itself is a thin presigner with no other dependencies,
 * so making it global is harmless.
 */
@Global()
@Module({
  providers: [R2Service],
  exports: [R2Service],
})
export class R2Module {}
