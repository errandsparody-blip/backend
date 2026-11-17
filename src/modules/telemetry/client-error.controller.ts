/**
 * Client-error ingest. The web app posts here whenever a signed-in user hits
 * an error in the browser. Authenticated (global JwtAuthGuard), so we attach
 * the real user/vendor/role from the token rather than trusting the body.
 * Throttled — a crash loop must not flood the table.
 */

import { Body, Controller, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ClientErrorService } from "./client-error.service";

const clientErrorSchema = z.object({
  kind: z.enum([
    "api_error",
    "blocked_action",
    "render_error",
    "window_error",
    "unhandled_rejection",
  ]),
  message: z.string().trim().min(1).max(2000),
  code: z.string().trim().max(200).optional(),
  statusCode: z.coerce.number().int().min(100).max(599).optional(),
  // Pathname only — the client strips query strings before sending.
  path: z.string().trim().max(512).optional(),
  stack: z.string().max(8000).optional(),
  // Small structured blob; anything larger is dropped client-side.
  context: z.record(z.unknown()).optional(),
});
type ClientErrorInput = z.infer<typeof clientErrorSchema>;

@Controller({ path: "telemetry", version: "1" })
export class ClientErrorController {
  constructor(private readonly errors: ClientErrorService) {}

  @Post("client-error")
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async ingest(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(clientErrorSchema)) body: ClientErrorInput,
  ): Promise<void> {
    await this.errors.record({
      userId: user.sub,
      vendorId: user.vendorId,
      role: user.role,
      kind: body.kind,
      message: body.message,
      code: body.code ?? null,
      statusCode: body.statusCode ?? null,
      path: body.path ?? null,
      stack: body.stack ?? null,
      context: body.context ?? null,
      userAgent: body.context && typeof (body.context as { userAgent?: unknown }).userAgent === "string"
        ? ((body.context as { userAgent?: string }).userAgent ?? null)
        : null,
    });
  }
}
