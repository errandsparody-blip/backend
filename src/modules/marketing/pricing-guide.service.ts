/**
 * PricingGuideService — handles "Get our full price guide" lead capture
 * on the public /pricing page.
 *
 * Flow:
 *   1. Validate input (Zod, upstream in the controller).
 *   2. Persist a row in `pricing_guide_leads` so sales has a record.
 *   3. Send the PDF (attached) to the visitor's email.
 *   4. Stamp `email_sent_at` on the row on successful send.
 *
 * The PDF lives at `assets/pricing-guide-2026.pdf` inside the repo. We
 * read it ONCE at boot (lazy) and keep the Buffer in memory — the file
 * is <500 KB and the read is hot-path-friendly. Replacing the PDF
 * requires a redeploy; that's fine for an asset that changes annually.
 *
 * Anti-spam: rate-limited at the controller (3/hour per IP) and we
 * additionally bail out silently when the same email submits more than
 * once within 24 hours — keeps the inbox calm AND keeps us from
 * burning Resend quota on a bot replaying the form.
 */

import { Injectable, Logger } from "@nestjs/common";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { PrismaService } from "../../common/prisma.service";
import { EmailService } from "../email/email.service";
import { pricingGuideTemplate } from "../email/email-templates";

const PDF_FILENAME = "USA Errands — Pricing Guide.pdf";
// Resolved relative to the repo root. NestJS runs from `dist/` at runtime
// but the assets folder sits at the project root, so we walk up from the
// CWD. The fallback `process.cwd()` works for both local dev and the
// Railway container (which sets cwd to the project root).
const PDF_DISK_PATH = join(process.cwd(), "assets", "pricing-guide-2026.pdf");

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
  /** Cached PDF bytes — read once, reused on every send. */
  private pdfBytes: Buffer | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  /**
   * Lazy-load the PDF the first time someone requests it. Subsequent
   * calls return the cached Buffer. If the file is missing at runtime
   * we surface a structured error so the operator can fix the
   * deployment — better than silently sending an email without the
   * promised attachment.
   */
  private async loadPdfBytes(): Promise<Buffer> {
    if (this.pdfBytes) return this.pdfBytes;
    try {
      const buf = await readFile(PDF_DISK_PATH);
      this.pdfBytes = buf;
      return buf;
    } catch (err) {
      this.logger.error(
        { err: (err as Error).message, path: PDF_DISK_PATH },
        "pricing_guide.pdf_missing",
      );
      throw new Error(
        `Pricing-guide PDF is not deployed at ${PDF_DISK_PATH} — check that the assets/ folder is included in the build.`,
      );
    }
  }

  async requestGuide(args: RequestArgs): Promise<{ delivered: boolean; deduped?: boolean }> {
    // Persist the lead first so sales sees the prospect even if the
    // email send fails. Cast through unknown until prisma generate runs
    // and the new model lands on the typed client.
    const lead = await (
      this.prisma as unknown as {
        pricingGuideLead: {
          create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>;
          findFirst: (args: {
            where: Record<string, unknown>;
            orderBy: Record<string, unknown>;
          }) => Promise<{ emailSentAt: Date | null; createdAt: Date } | null>;
          update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
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

    // Load PDF (cached after first read).
    const pdfBytes = await this.loadPdfBytes();

    const tpl = pricingGuideTemplate({ businessName: args.businessName });
    const result = await this.email.send({
      to: args.email,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      // Idempotency key per lead so a Resend retry doesn't double-send.
      idempotencyKey: `pricing_guide:${lead.id}`,
      type: "marketing.pricing_guide",
      attachments: [
        {
          filename: PDF_FILENAME,
          content: pdfBytes,
          contentType: "application/pdf",
        },
      ],
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
