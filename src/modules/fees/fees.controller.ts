/**
 * Fees — vendor-readable endpoints exposing the live published fee
 * schedule. Right now there's just one endpoint (`onboarding`); when we
 * need monthly storage / fulfillment / returns rates client-side we'll
 * add siblings here rather than spreading them across modules.
 *
 * Why a dedicated controller instead of putting the rates on
 * `/admin/config/fee_schedule`: the admin endpoint is gated to
 * SUPER_ADMIN, but the vendor's PSN form needs these numbers to render a
 * live preview. Same data, different surface area, same source of truth
 * (`loadFeeSchedule()` reads the configuration row).
 *
 * No cache here — the call happens once per /psn/new page render. If
 * volume grows we can wrap the read in a small TTL cache like
 * AgreementService.
 */

import { Controller, Get, Logger } from "@nestjs/common";

import { loadFeeSchedule } from "../../common/fees";
import { PrismaService } from "../../common/prisma.service";

@Controller({ path: "fees", version: "1" })
export class FeesController {
  private readonly logger = new Logger(FeesController.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /v1/fees/onboarding — returns the per-tier onboarding fee map.
   *
   * Response shape mirrors the storage of the `fee_schedule` config row's
   * `onboarding` slice so the frontend can use the same vocabulary it
   * sees in the friendly editor: each entry is either
   *   { stockingCents, firstMonthStorageCents, totalCents, negotiated?: false }
   * or
   *   { negotiated: true }
   *
   * Throws InternalServerErrorException with code `fee_schedule_missing`
   * when the row is absent — the AllExceptionsFilter renders that into a
   * structured RFC 7807 body, the frontend's error catalog already has a
   * matching entry, and the form gracefully degrades to "live preview
   * unavailable".
   */
  @Get("onboarding")
  async getOnboarding() {
    const schedule = await loadFeeSchedule(this.prisma);
    return { onboarding: schedule.onboarding };
  }

  /**
   * GET /v1/fees/storage-tiers — everything the vendor PSN pages need to
   * render the inline "Pricing by tier" cards.
   *
   * Combines three concerns in one round-trip:
   *
   *   1. `onboarding[TIER]` — per-tier stocking + first-month storage fees
   *      (or `{ negotiated: true }`). Same shape as /onboarding above.
   *   2. `monthlyStorage[TIER]` — the recurring monthly storage rate in
   *      cents (or null when the tier is negotiated).
   *   3. `dimensions[TIER]` — physical box dimensions in inches + max
   *      weight in ounces, from the `tier_dimensions` config row. Used by
   *      the frontend to compute and display cubic inches / cubic feet on
   *      the cards (Length × Width × Height ÷ 1728).
   *
   * Why one endpoint instead of three: the cards render all three slices
   * together on every PSN page load — bundling them avoids a render-time
   * waterfall and keeps the React Query cache key simple.
   *
   * Both config rows are SUPER_ADMIN-write-only via /admin/config/*; this
   * endpoint is the read-only vendor-side projection. Missing rows produce
   * a `null` slice so the frontend can render a graceful fallback rather
   * than a hard error (the underlying `fee_schedule` row is still required
   * — without it the page is broken regardless).
   */
  @Get("storage-tiers")
  async getStorageTiers() {
    const schedule = await loadFeeSchedule(this.prisma);

    // Tier dimensions are optional — they don't gate the wallet debit, so
    // a missing row degrades cleanly to "no cubic info shown" rather than
    // breaking the whole panel.
    type DimsRow = { lengthIn: number; widthIn: number; heightIn: number; maxWeightOz: number };
    let dimensions: Record<string, DimsRow> | null = null;
    try {
      const row = await this.prisma.configuration.findUnique({
        where: { key: "tier_dimensions" },
      });
      if (row && row.value && typeof row.value === "object" && !Array.isArray(row.value)) {
        // Light validation — keep entries whose four numeric fields are
        // sane, drop everything else. We don't trust raw JSON.
        const out: Record<string, DimsRow> = {};
        for (const [tier, v] of Object.entries(row.value as Record<string, unknown>)) {
          if (!v || typeof v !== "object") continue;
          const r = v as Record<string, unknown>;
          const lengthIn = Number(r.lengthIn);
          const widthIn = Number(r.widthIn);
          const heightIn = Number(r.heightIn);
          const maxWeightOz = Number(r.maxWeightOz);
          if (
            Number.isFinite(lengthIn) &&
            lengthIn > 0 &&
            Number.isFinite(widthIn) &&
            widthIn > 0 &&
            Number.isFinite(heightIn) &&
            heightIn > 0 &&
            Number.isFinite(maxWeightOz) &&
            maxWeightOz > 0
          ) {
            out[tier] = { lengthIn, widthIn, heightIn, maxWeightOz };
          }
        }
        dimensions = Object.keys(out).length > 0 ? out : null;
      }
    } catch (err) {
      // Logging — don't fail the whole panel just because dimensions are
      // unreadable. The cards still render with the fee data we DO have.
      this.logger.warn(
        { err: (err as Error).message },
        "fees.storage_tiers.dimensions_load_failed",
      );
    }

    return {
      onboarding: schedule.onboarding,
      monthlyStorage: schedule.monthlyStorage,
      dimensions,
    };
  }
}
