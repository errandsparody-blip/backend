/**
 * ShopperReceiptService — orchestrates receipt generation + storage.
 *
 *   1. Pulls the latest request + lines from the request service.
 *   2. Builds the breakdown via the pure receipt builder.
 *   3. Renders SVG, uploads to R2 under `shopper/{requestId}/receipts/`.
 *   4. Returns the public URL + the rendered HTML/text fragments so
 *      callers can embed them in chat messages and emails.
 *
 * Best-effort by design: if R2 is unconfigured (local dev), or the PUT
 * fails for transient reasons, we still return the rendered fragments
 * with `imageUrl: null`. Callers decide whether to abort their flow or
 * post the email-only version. Money-affecting actions (Stripe Checkout
 * creation, refunds) MUST NOT depend on the receipt succeeding.
 */

import { Injectable, Logger } from "@nestjs/common";

import { R2Service } from "../integrations/r2/r2.service";

import {
  buildReceiptBreakdown,
  buildReceiptHtmlBlock,
  buildReceiptSvg,
  buildReceiptText,
  type ReceiptBreakdown,
} from "./shopper-receipt.builder";
import { ShopperRequestService, type LineRow, type RequestRow } from "./shopper-request.service";

export interface RenderedReceipt {
  /** R2 public URL of the SVG image. Null if R2 unavailable. */
  imageUrl: string | null;
  /** HTML block for embedding inside an email body. */
  html: string;
  /** Plaintext breakdown for the email's text twin. */
  text: string;
  /** Raw breakdown — exposed for callers that want to render their own thing. */
  breakdown: ReceiptBreakdown;
}

@Injectable()
export class ShopperReceiptService {
  private readonly logger = new Logger(ShopperReceiptService.name);

  constructor(
    private readonly r2: R2Service,
    private readonly requests: ShopperRequestService,
  ) {}

  /**
   * Generate a fresh receipt, upload the SVG, and return all formats.
   *
   * @param requestId — the request to render
   * @param parentReference — pre-resolved (controller already looked it up)
   */
  async generate(
    requestId: string,
    parentReference: string | null = null,
  ): Promise<RenderedReceipt> {
    const reqWithLines = await this.requests.getById(requestId);
    return this.renderFromRow(reqWithLines, reqWithLines.lines, parentReference);
  }

  /**
   * Render variant when the caller already has the row + lines loaded —
   * avoids a redundant DB round-trip in `setShipping` / `sendFollowup`,
   * where we just performed updates and have the fresh state in hand.
   */
  async renderFromRow(
    request: RequestRow,
    lines: LineRow[],
    parentReference: string | null = null,
  ): Promise<RenderedReceipt> {
    const breakdown = buildReceiptBreakdown(request, lines, parentReference);
    const svg = buildReceiptSvg(breakdown);
    const html = buildReceiptHtmlBlock(breakdown);
    const text = buildReceiptText(breakdown);

    let imageUrl: string | null = null;
    if (this.r2.isConfigured()) {
      try {
        // Stable-ish key per generation. Including a millisecond timestamp
        // means each save creates a fresh file (so chat attachments don't
        // collapse to the same image), while the prefix keeps cleanup easy.
        const key = `shopper/${request.id}/receipts/receipt-${Date.now()}.svg`;
        const result = await this.r2.putObject({
          key,
          contentType: "image/svg+xml",
          body: svg,
          // SVG content is content-addressed via timestamp; a 1-day cache
          // is more than enough since callers won't re-fetch identical URLs.
          cacheControl: "public, max-age=86400",
        });
        imageUrl = result.publicUrl;
      } catch (err) {
        // Best-effort: log and fall through with imageUrl=null. Email
        // still has the inline HTML breakdown; chat will simply lack a
        // visual receipt this round.
        this.logger.warn(
          { err, requestId: request.id },
          "shopper.receipt.upload_failed",
        );
      }
    } else {
      this.logger.debug({ requestId: request.id }, "shopper.receipt.r2_not_configured");
    }

    return { imageUrl, html, text, breakdown };
  }
}
