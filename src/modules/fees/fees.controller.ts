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

import { Controller, Get } from "@nestjs/common";

import { loadFeeSchedule } from "../../common/fees";
import { PrismaService } from "../../common/prisma.service";

@Controller({ path: "fees", version: "1" })
export class FeesController {
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
}
