/**
 * PricingGuideService — handles "Get our full price guide" lead capture
 * on the public /pricing page.
 *
 * Flow:
 *   1. Validate input (Zod, upstream in the controller).
 *   2. Persist a row in `pricing_guide_leads` so sales has a record.
 *   3. Send an email with a download link to the public PDF (served
 *      by the marketing web app at `${WEB_PUBLIC_URL}/pricing-guide-2026.pdf`).
 *   4. Stamp `email_sent_at` on the row on successful send.
 *
 * Originally the service shipped the PDF as a Resend attachment loaded
 * from disk. We switched to a public-URL link because the file already
 * lives in the Next.js `public/` folder (served by Vercel's CDN), so:
 *   - the backend no longer needs to bundle the PDF
 *   - email size stays small (just a link, not a 460 KB attachment)
 *   - Gmail / Outlook clients open the PDF inline via their own preview
 *
 * Anti-spam: rate-limited at the controller (3/hour per IP). We also
 * dedupe re-sends from the same email inside 24h to keep the inbox
 * calm and conserve Resend quota.
 */

import { Injectable, Logger } from "@nestjs/common";

import { loadConfig } from "../../common/config";
import { PrismaService } from "../../common/prisma.service";
import { EmailService } from "../email/email.service";
import { pricingGuideTemplate } from "../email/email-templates";

// Public path served by the Next.js web app — must match the filename
// committed at `usa-errands-web/public/pricing-guide-2026.pdf`.
const PDF_PUBLIC_PATH = "/pricing-guide-2026.pdf";

// Throttle window for "same email submits repeatedly" defence. Resends
// within this window silently no-op (the lead row is still recorded for
// sales triage; we just don't re-send the email).
const DUPLICATE_SUPPRESSION_MS = 24 * 60 * 60 * 1000;

interface RequestArgs {
  businessName: string;
  email: string;
  country: string;
  sourceIp: string | null;
  userAgent: string | null;
}

@Injectable()
export class PricingGuideService {
  private readonly logger = new Logger(PricingGuideService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  async requestGuide(args: RequestArgs): Promise<{ delivered: boolean; deduped?: boolean }> {
    // Persist the lead first so sales sees the prospect even if the
    // email send fails. Cast through unknown until prisma generate runs
    // and the new model lands on the typed client.
    const lead = await (
      this.prisma as unknown as {
        pricingGuideLead: {
          create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>;
        };
      }
    ).pricingGuideLead.create({
      data: {
        businessName: args.businessName,
        email: args.email,
        country: args.country,
        sourceIp: args.sourceIp,
        userAgent: args.userAgent,
      },
    });

    // Duplicate-suppression: check if this email has been sent within the
    // window. Look at the lead we JUST created's siblings, not itself.
    const recentSend = await (
      this.prisma as unknown as {
        pricingGuideLead: {
          findFirst: (args: {
            where: Record<string, unknown>;
            orderBy: Record<string, unknown>;
          }) => Promise<{ emailSentAt: Date | null; createdAt: Date } | null>;
        };
      }
    ).pricingGuideLead.findFirst({
      where: {
        email: args.email,
        emailSentAt: { not: null, gte: new Date(Date.now() - DUPLICATE_SUPPRESSION_MS) },
        NOT: { id: lead.id },
      },
      orderBy: { createdAt: "desc" },
    });

    if (recentSend) {
      this.logger.log(
        { email: this.redact(args.email) },
        "pricing_guide.duplicate_suppressed",
      );
      return { delivered: true, deduped: true };
    }

    const cfg = loadConfig();
    const downloadUrl = `${cfg.WEB_PUBLIC_URL.replace(/\/$/, "")}${PDF_PUBLIC_PATH}`;
    const tpl = pricingGuideTemplate({
      businessName: args.businessName,
      downloadUrl,
    });
    const result = await this.email.send({
      to: args.email,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      // Idempotency key per lead so a Resend retry doesn't double-send.
      idempotencyKey: `pricing_guide:${lead.id}`,
      type: "marketing.pricing_guide",
    });

    if (result.ok) {
      await (
        this.prisma as unknown as {
          pricingGuideLead: {
            update: (args: {
              where: { id: string };
              data: Record<string, unknown>;
            }) => Promise<unknown>;
          };
        }
      ).pricingGuideLead.update({
        where: { id: lead.id },
        data: { emailSentAt: new Date() },
      });
      return { delivered: true };
    }

    this.logger.warn(
      { email: this.redact(args.email), error: result.error },
      "pricing_guide.email_send_failed",
    );
    return { delivered: false };
  }

  /** Same redaction pattern as EmailService — keeps audit logs PII-clean. */
  private redact(email: string): string {
    const at = email.indexOf("@");
    if (at < 1) return "***";
    const [user, domain] = [email.slice(0, at), email.slice(at + 1)];
    const userMask = user.length <= 2 ? "**" : `${user[0]}***${user[user.length - 1]}`;
    return `${userMask}@${domain}`;
  }
}
