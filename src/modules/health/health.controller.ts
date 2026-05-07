import { Controller, Get } from "@nestjs/common";

import { Public } from "../../common/decorators/public.decorator";
import { PrismaService } from "../../common/prisma.service";

@Controller({ path: "health", version: "1" })
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get()
  async health(): Promise<{ status: "ok"; deps: { db: "ok" | "error" } }> {
    let db: "ok" | "error" = "ok";
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      db = "error";
    }
    return { status: "ok", deps: { db } };
  }
}
