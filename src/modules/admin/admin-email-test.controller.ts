/**
 * Admin email diagnostics — send a one-off test email.
 *
 *   POST /v1/admin/email-test   { to: string }
 *
 * SUPER_ADMIN only. Dispatches a single plain test message through the
 * real EmailService (same path every transactional email uses), so a
 * success here proves the whole chain end-to-end: EMAIL_PROVIDER,
 * RESEND_API_KEY, and crucially the EMAIL_FROM domain's verification
 * status at the provider.
 *
 * The provider's own result is returned verbatim ({ ok, providerId,
 * error }) so the admin UI can surface the exact failure code — e.g.
 * `resend_403` when the sending domain is not verified — instead of a
 * generic "something went wrong". This is deliberately the fastest way
 * to confirm deliverability after a DNS / domain change without placing
 * a real order.
 *
 * Every send is audit-logged by EmailService itself (email.delivered /
 * email.failed), so this endpoint needs no extra audit call.
 */

import { Body, Controller, Post } from "@nestjs/common";
import { Role } from "@prisma/client";
import { z } from "zod";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { EmailService } from "../email/email.service";

const sendSchema = z.object({
  to: z.string().trim().email("A valid recipient email is required"),
});
type SendInput = z.infer<typeof sendSchema>;

@Controller({ path: "admin/email-test", version: "1" })
@Roles(Role.SUPER_ADMIN)
export class AdminEmailTestController {
  constructor(private readonly email: EmailService) {}

  @Post()
  async send(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(sendSchema)) body: SendInput,
  ) {
    const stamp = new Date().toISOString();
    const result = await this.email.send({
      to: body.to,
      type: "admin.email_test",
      userId: user.sub,
      subject: "USA Errands — test email",
      text:
        `This is a test email from the USA Errands admin console.\n\n` +
        `If you are reading this, outbound email delivery is working.\n` +
        `Sent at ${stamp}.`,
      html:
        `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
        `<title>USA Errands test email</title></head>` +
        `<body style="margin:0;padding:24px;background:#f1efe9;` +
        `font-family:Helvetica,Arial,sans-serif;color:#0a0a0a;">` +
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">` +
        `<tr><td align="center">` +
        `<table role="presentation" width="560" cellpadding="0" cellspacing="0" ` +
        `style="background:#fff;border:1px solid #e2dfd7;">` +
        `<tr><td style="padding:24px 32px;border-bottom:1px solid #e2dfd7;` +
        `font-size:11px;letter-spacing:1.6px;text-transform:uppercase;color:#777270;">` +
        `USA Errands</td></tr>` +
        `<tr><td style="padding:28px 32px;">` +
        `<h1 style="margin:0 0 12px;font-size:22px;font-weight:600;">Test email</h1>` +
        `<p style="margin:0 0 10px;font-size:15px;line-height:1.6;color:#3a3a3a;">` +
        `This is a test email from the USA Errands admin console. If you are ` +
        `reading this, outbound email delivery is working.</p>` +
        `<p style="margin:0;font-size:13px;color:#9c9892;">Sent at ${stamp}.</p>` +
        `</td></tr></table></td></tr></table></body></html>`,
    });

    // Surface the provider result verbatim so the UI can show the exact
    // failure code (e.g. resend_403 = sending domain not verified).
    return {
      ok: result.ok,
      to: body.to,
      providerId: result.providerId ?? null,
      error: result.error ?? null,
      sentAt: stamp,
    };
  }
}
