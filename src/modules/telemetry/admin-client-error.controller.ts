/**
 * Admin read side of client-error telemetry. SUPER_ADMIN only — lets the
 * operator see exactly what errors vendors are hitting in the browser without
 * logging into their accounts.
 *
 *   GET /v1/admin/client-errors?vendorId=&kind=&before=&limit=
 */

import { Controller, Get, Query } from "@nestjs/common";
import { Role } from "@prisma/client";
import { z } from "zod";

import { Roles } from "../../common/decorators/roles.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ClientErrorService } from "./client-error.service";

const listSchema = z.object({
  vendorId: z.string().uuid().optional(),
  kind: z
    .enum([
      "api_error",
      "blocked_action",
      "render_error",
      "window_error",
      "unhandled_rejection",
    ])
    .optional(),
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
});
type ListInput = z.infer<typeof listSchema>;

@Controller({ path: "admin/client-errors", version: "1" })
@Roles(Role.SUPER_ADMIN)
export class AdminClientErrorController {
  constructor(private readonly errors: ClientErrorService) {}

  @Get()
  async list(@Query(new ZodValidationPipe(listSchema)) q: ListInput) {
    const { items, nextBefore } = await this.errors.list({
      ...(q.vendorId ? { vendorId: q.vendorId } : {}),
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.before ? { before: q.before } : {}),
      limit: q.limit,
    });
    return {
      items: items.map((r) => ({
        id: r.id,
        userId: r.user_id,
        vendorId: r.vendor_id,
        vendorName: r.vendor_name,
        userEmail: r.user_email,
        role: r.role,
        kind: r.kind,
        message: r.message,
        code: r.code,
        statusCode: r.status_code,
        path: r.path,
        userAgent: r.user_agent,
        createdAt: r.created_at.toISOString(),
      })),
      nextBefore,
    };
  }
}
