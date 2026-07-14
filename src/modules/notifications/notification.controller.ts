/**
 * Notification controller — read + ack for every authenticated user.
 *
 *   GET  /v1/notifications                 — list + unread count
 *   GET  /v1/notifications/unread-counts   — bucketed unread counts
 *   POST /v1/notifications/:id/read        — mark one read
 *   POST /v1/notifications/read-all        — mark all read
 *
 * Scoping: vendor users (VENDOR, VENDOR_SUB_USER) see notifications for
 * their whole vendor org via `vendorId`; admin users see their personal
 * notifications via `userId`. The two scopes are disjoint at the data
 * layer so neither role can ever observe the other's rows.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UnauthorizedException,
} from "@nestjs/common";
import { Role } from "@prisma/client";
import { z } from "zod";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";

import { NotificationService } from "./notification.service";

const listNotificationsSchema = z.object({
  unreadOnly: z.coerce.boolean().default(false),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
});
type ListInput = z.infer<typeof listNotificationsSchema>;

// Category names are the leading segment of `type` — see
// NotificationService.categoryFromType. We restrict to the known set so
// a buggy client can't dump random strings into `type LIKE`.
const readCategorySchema = z.object({
  category: z.enum([
    "psn",
    "order",
    "return",
    "wallet",
    "shopper",
    "kyc",
    "verification",
    "vendor",
  ]),
});
type ReadCategoryInput = z.infer<typeof readCategorySchema>;

@Controller({ path: "notifications", version: "1" })
// Migration 0039 — ADMIN added. NotificationService scopes by
// recipient (userId/vendorId), so the endpoint cannot leak someone
// else's notifications regardless of role. No @RequiresPage needed
// — every authenticated user sees their own inbox. The sidebar's
// "Notifications" item visibility is gated separately on the
// admin.notifications.read page key.
@Roles(
  Role.VENDOR,
  Role.VENDOR_SUB_USER,
  Role.WAREHOUSE_OPERATOR,
  Role.FINANCE_ADMIN,
  Role.SUPER_ADMIN,
  "ADMIN" as Role,
)
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(listNotificationsSchema)) q: ListInput,
  ) {
    return this.notifications.listForRecipient(this.scopeFor(user), q);
  }

  @Get("unread-counts")
  unreadCounts(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.unreadCountsForRecipient(this.scopeFor(user));
  }

  @Post(":id/read")
  @HttpCode(HttpStatus.NO_CONTENT)
  async markRead(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.notifications.markReadForRecipient(this.scopeFor(user), id);
  }

  @Post("read-all")
  @HttpCode(HttpStatus.OK)
  markAllRead(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.markAllReadForRecipient(this.scopeFor(user));
  }

  /**
   * POST /v1/notifications/read-category
   *
   * Mark every unread notification whose `type` starts with `<category>.`
   * as read. The sidebar fires this on nav-item click so the badge
   * drops to 0 as soon as the user is looking at the matching page.
   */
  @Post("read-category")
  @HttpCode(HttpStatus.OK)
  markCategoryRead(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(readCategorySchema)) body: ReadCategoryInput,
  ) {
    return this.notifications.markCategoryReadForRecipient(
      this.scopeFor(user),
      body.category,
    );
  }

  /**
   * Build the recipient scope from the authenticated user. Vendor users
   * use vendorId; admins use userId. Throwing on the no-match case is a
   * defence in depth — `@Roles` already filters before we get here, so
   * this branch should be unreachable.
   */
  private scopeFor(user: AuthenticatedUser): { vendorId?: string; userId?: string } {
    if (user.role === Role.VENDOR || user.role === Role.VENDOR_SUB_USER) {
      if (!user.vendorId) {
        throw new UnauthorizedException({
          message: "Vendor user is missing a vendor binding.",
          code: "notif_missing_vendor",
        });
      }
      return { vendorId: user.vendorId };
    }
    return { userId: user.sub };
  }
}
