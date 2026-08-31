/**
 * ReferralService — vendor-to-vendor referrals + event campaign capture.
 *
 * Model (migration 0056):
 *   - Each vendor has a unique `referral_code` they share.
 *   - Campaigns represent events (a code/QR at a booth).
 *   - `referrals` holds one row per referred vendor, attributed at signup.
 *   - When the referred vendor's FIRST inbound PSN is received, both the
 *     referrer and the referred vendor are credited reward_cents ($50 each
 *     by default) — exactly once (rewarded_at + row lock guard it).
 *
 * All referral persistence goes through raw SQL so the module works even
 * before the local Prisma client is regenerated with the new tables/enum
 * value (Railway regenerates on deploy).
 */

import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomBytes } from "crypto";

import { PrismaService } from "../../common/prisma.service";
import { NotificationService } from "../notifications/notification.service";
import { WalletService } from "../wallet/wallet.service";

/** Default reward per side, in cents ($50). Campaigns may override. */
const DEFAULT_REWARD_CENTS = 5000;

interface ResolvedRef {
  referrerVendorId: string | null;
  campaignId: string | null;
  rewardCents: number;
  code: string;
}

@Injectable()
export class ReferralService {
  private readonly logger = new Logger(ReferralService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly notifications: NotificationService,
  ) {}

  // ---------------------------------------------------------------------------
  // Vendor code
  // ---------------------------------------------------------------------------

  /** Return the vendor's referral code, generating + persisting one if absent. */
  async ensureVendorCode(vendorId: string): Promise<string> {
    const existing = await this.prisma.$queryRaw<Array<{ referral_code: string | null; business_name: string }>>(
      Prisma.sql`SELECT referral_code, business_name FROM vendors WHERE id = ${vendorId}::uuid`,
    );
    const row = existing[0];
    if (!row) throw new Error("Vendor not found");
    if (row.referral_code) return row.referral_code;

    // Build a readable base from the business name, then append entropy.
    const base = (row.business_name || "VENDOR")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 10) || "VENDOR";

    for (let attempt = 0; attempt < 6; attempt++) {
      const code = `${base}-${this.randomSuffix(4)}`;
      try {
        await this.prisma.$executeRaw(
          Prisma.sql`UPDATE vendors SET referral_code = ${code} WHERE id = ${vendorId}::uuid AND referral_code IS NULL`,
        );
        const check = await this.prisma.$queryRaw<Array<{ referral_code: string | null }>>(
          Prisma.sql`SELECT referral_code FROM vendors WHERE id = ${vendorId}::uuid`,
        );
        if (check[0]?.referral_code) return check[0].referral_code;
      } catch {
        // Unique collision — try another suffix.
      }
    }
    throw new Error("Could not generate a unique referral code");
  }

  private randomSuffix(len: number): string {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
    const bytes = randomBytes(len);
    let out = "";
    for (let i = 0; i < len; i++) out += alphabet[bytes[i]! % alphabet.length];
    return out;
  }

  // ---------------------------------------------------------------------------
  // Resolution + attribution
  // ---------------------------------------------------------------------------

  /** Resolve a raw ref code to a vendor referrer or an active campaign. */
  async resolveRefCode(codeRaw: string): Promise<ResolvedRef | null> {
    const code = codeRaw.trim();
    if (!code) return null;

    const vendorRows = await this.prisma.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT id FROM vendors WHERE referral_code = ${code} LIMIT 1`,
    );
    if (vendorRows[0]) {
      return { referrerVendorId: vendorRows[0].id, campaignId: null, rewardCents: DEFAULT_REWARD_CENTS, code };
    }

    const campRows = await this.prisma.$queryRaw<Array<{ id: string; reward_cents: number }>>(
      Prisma.sql`SELECT id, reward_cents FROM referral_campaigns WHERE code = ${code} AND active = true LIMIT 1`,
    );
    if (campRows[0]) {
      return { referrerVendorId: null, campaignId: campRows[0].id, rewardCents: campRows[0].reward_cents, code };
    }
    return null;
  }

  /**
   * Record an attribution for a newly-created vendor. Best-effort: never
   * throws (a referral hiccup must not break signup). Idempotent via the
   * unique referred_vendor_id index. Self-referral is ignored.
   */
  async recordAttribution(referredVendorId: string, codeRaw: string | null | undefined): Promise<void> {
    try {
      if (!codeRaw) return;
      const resolved = await this.resolveRefCode(codeRaw);
      if (!resolved) return; // unknown code — silently ignore
      if (resolved.referrerVendorId && resolved.referrerVendorId === referredVendorId) return; // self-referral

      await this.prisma.$executeRaw(Prisma.sql`
        INSERT INTO referrals (referred_vendor_id, referrer_vendor_id, campaign_id, ref_code_used, status, reward_cents)
        VALUES (
          ${referredVendorId}::uuid,
          ${resolved.referrerVendorId ? Prisma.sql`${resolved.referrerVendorId}::uuid` : Prisma.sql`NULL`},
          ${resolved.campaignId ? Prisma.sql`${resolved.campaignId}::uuid` : Prisma.sql`NULL`},
          ${resolved.code},
          'REGISTERED',
          ${resolved.rewardCents}
        )
        ON CONFLICT (referred_vendor_id) DO NOTHING
      `);

      // Notify the referrer that someone signed up with their link (email trail).
      if (resolved.referrerVendorId) {
        const referee = await this.vendorName(referredVendorId);
        await this.notifyVendor(resolved.referrerVendorId, {
          type: "referral.registered",
          title: "Your referral just signed up",
          body: `${referee} joined USA Errands with your referral link. You'll both earn $50 once they send and we receive their first shipment (PSN).`,
          subject: "Your referral just signed up",
        });
      }
    } catch (err) {
      this.logger.warn({ msg: "recordAttribution failed (non-fatal)", referredVendorId, err: `${err}` });
    }
  }

  // ---------------------------------------------------------------------------
  // Reward on first PSN received
  // ---------------------------------------------------------------------------

  /**
   * Fire the referral reward when a referred vendor's first inbound PSN is
   * received. Credits $50 to the referrer AND $50 to the referred vendor,
   * once. Safe to call on every PSN receipt — the row lock + rewarded_at
   * guard make it idempotent. Pure event/campaign signups (no referrer)
   * are marked QUALIFIED with no payout. Best-effort: never throws.
   */
  async rewardOnFirstPsn(referredVendorId: string): Promise<void> {
    let rewarded: { referrerVendorId: string; rewardCents: number } | null = null;
    try {
      rewarded = await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<
          Array<{
            id: string;
            referrer_vendor_id: string | null;
            status: string;
            reward_cents: number;
            rewarded_at: Date | null;
          }>
        >(Prisma.sql`
          SELECT id, referrer_vendor_id, status, reward_cents, rewarded_at
          FROM referrals WHERE referred_vendor_id = ${referredVendorId}::uuid
          FOR UPDATE
        `);
        const ref = rows[0];
        if (!ref) return null; // not a referred vendor
        if (ref.rewarded_at || ref.status !== "REGISTERED") return null; // already handled

        const now = new Date();

        // No referrer (event/campaign signup) → qualify, no payout.
        if (!ref.referrer_vendor_id) {
          await tx.$executeRaw(Prisma.sql`
            UPDATE referrals SET status = 'QUALIFIED', first_psn_received_at = ${now}, updated_at = now()
            WHERE id = ${ref.id}::uuid
          `);
          return null;
        }

        const reward = ref.reward_cents || DEFAULT_REWARD_CENTS;
        const referrerEntry = await this.wallet.credit(
          {
            vendorId: ref.referrer_vendor_id,
            amountCents: reward,
            type: "REFERRAL_BONUS",
            description: "Referral bonus — your referred vendor's first PSN was received",
            referenceType: "referral",
            referenceId: ref.id,
            idempotencyKey: `referral-${ref.id}-referrer`,
          },
          tx,
        );
        const refereeEntry = await this.wallet.credit(
          {
            vendorId: referredVendorId,
            amountCents: reward,
            type: "REFERRAL_BONUS",
            description: "Welcome referral bonus — your first PSN was received",
            referenceType: "referral",
            referenceId: ref.id,
            idempotencyKey: `referral-${ref.id}-referee`,
          },
          tx,
        );
        await tx.$executeRaw(Prisma.sql`
          UPDATE referrals SET
            status = 'REWARDED',
            first_psn_received_at = ${now},
            rewarded_at = ${now},
            referrer_reward_entry_id = ${referrerEntry.entry.id}::uuid,
            referee_reward_entry_id = ${refereeEntry.entry.id}::uuid,
            updated_at = now()
          WHERE id = ${ref.id}::uuid
        `);
        return { referrerVendorId: ref.referrer_vendor_id, rewardCents: reward };
      });
    } catch (err) {
      this.logger.error({ msg: "rewardOnFirstPsn failed", referredVendorId, err: `${err}` });
      return;
    }

    // After commit — notify both sides (in-app + email). Best-effort.
    if (rewarded) {
      const dollars = `$${(rewarded.rewardCents / 100).toFixed(2)}`;
      const referee = await this.vendorName(referredVendorId);
      const referrer = await this.vendorName(rewarded.referrerVendorId);
      await this.notifyVendor(rewarded.referrerVendorId, {
        type: "referral.rewarded",
        title: `You earned ${dollars}`,
        body: `${referee}, who you referred, just had their first shipment received. ${dollars} has been credited to your wallet. Thank you for spreading the word!`,
        subject: `You earned ${dollars} in referral rewards`,
      });
      await this.notifyVendor(referredVendorId, {
        type: "referral.rewarded",
        title: `You earned ${dollars}`,
        body: `Welcome bonus! Your first shipment was received, so ${dollars} has been credited to your wallet — courtesy of ${referrer}'s referral.`,
        subject: `You earned a ${dollars} welcome bonus`,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Reads (vendor + admin)
  // ---------------------------------------------------------------------------

  /** Referral summary for the vendor's own referral page. */
  async vendorSummary(vendorId: string): Promise<{
    code: string;
    referredCount: number;
    rewardedCount: number;
    earnedCents: number;
  }> {
    const code = await this.ensureVendorCode(vendorId);
    const stats = await this.prisma.$queryRaw<
      Array<{ referred: number; rewarded: number; earned: number }>
    >(Prisma.sql`
      SELECT
        COUNT(*)::int AS referred,
        COUNT(*) FILTER (WHERE status = 'REWARDED')::int AS rewarded,
        COALESCE(SUM(reward_cents) FILTER (WHERE status = 'REWARDED'), 0)::int AS earned
      FROM referrals WHERE referrer_vendor_id = ${vendorId}::uuid
    `);
    const s = stats[0] ?? { referred: 0, rewarded: 0, earned: 0 };
    return { code, referredCount: s.referred, rewardedCount: s.rewarded, earnedCents: s.earned };
  }

  /** Admin list of referrals, optionally filtered by campaign code. */
  async adminList(campaignCode?: string): Promise<
    Array<{
      id: string;
      referredVendor: string;
      referrerVendor: string | null;
      campaign: string | null;
      refCode: string | null;
      status: string;
      rewardCents: number;
      createdAt: Date;
      rewardedAt: Date | null;
    }>
  > {
    const filter = campaignCode
      ? Prisma.sql`WHERE c.code = ${campaignCode.trim()}`
      : Prisma.sql``;
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        referred_vendor: string;
        referrer_vendor: string | null;
        campaign: string | null;
        ref_code_used: string | null;
        status: string;
        reward_cents: number;
        created_at: Date;
        rewarded_at: Date | null;
      }>
    >(Prisma.sql`
      SELECT r.id,
             rv.business_name AS referred_vendor,
             rf.business_name AS referrer_vendor,
             c.name AS campaign,
             r.ref_code_used,
             r.status,
             r.reward_cents,
             r.created_at,
             r.rewarded_at
      FROM referrals r
      JOIN vendors rv ON rv.id = r.referred_vendor_id
      LEFT JOIN vendors rf ON rf.id = r.referrer_vendor_id
      LEFT JOIN referral_campaigns c ON c.id = r.campaign_id
      ${filter}
      ORDER BY r.created_at DESC
      LIMIT 500
    `);
    return rows.map((r) => ({
      id: r.id,
      referredVendor: r.referred_vendor,
      referrerVendor: r.referrer_vendor,
      campaign: r.campaign,
      refCode: r.ref_code_used,
      status: r.status,
      rewardCents: r.reward_cents,
      createdAt: r.created_at,
      rewardedAt: r.rewarded_at,
    }));
  }

  async listCampaigns(): Promise<
    Array<{ id: string; code: string; name: string; rewardCents: number; active: boolean; signups: number }>
  > {
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; code: string; name: string; reward_cents: number; active: boolean; signups: number }>
    >(Prisma.sql`
      SELECT c.id, c.code, c.name, c.reward_cents, c.active,
             (SELECT COUNT(*)::int FROM referrals r WHERE r.campaign_id = c.id) AS signups
      FROM referral_campaigns c ORDER BY c.created_at DESC
    `);
    return rows.map((c) => ({
      id: c.id,
      code: c.code,
      name: c.name,
      rewardCents: c.reward_cents,
      active: c.active,
      signups: c.signups,
    }));
  }

  async createCampaign(input: { code: string; name: string; rewardCents?: number }): Promise<{ id: string }> {
    const code = input.code.trim().toUpperCase();
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      INSERT INTO referral_campaigns (code, name, reward_cents)
      VALUES (${code}, ${input.name.trim()}, ${input.rewardCents ?? DEFAULT_REWARD_CENTS})
      RETURNING id
    `);
    return { id: rows[0]!.id };
  }

  async setCampaignActive(id: string, active: boolean): Promise<void> {
    await this.prisma.$executeRaw(
      Prisma.sql`UPDATE referral_campaigns SET active = ${active} WHERE id = ${id}::uuid`,
    );
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async vendorName(vendorId: string): Promise<string> {
    const rows = await this.prisma.$queryRaw<Array<{ business_name: string }>>(
      Prisma.sql`SELECT business_name FROM vendors WHERE id = ${vendorId}::uuid`,
    );
    return rows[0]?.business_name ?? "A vendor";
  }

  private async vendorEmail(vendorId: string): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<Array<{ email: string }>>(Prisma.sql`
      SELECT email FROM users WHERE vendor_id = ${vendorId}::uuid AND status = 'ACTIVE'
      ORDER BY created_at ASC LIMIT 1
    `);
    return rows[0]?.email ?? null;
  }

  private async notifyVendor(
    vendorId: string,
    args: { type: string; title: string; body: string; subject: string },
  ): Promise<void> {
    try {
      const email = await this.vendorEmail(vendorId);
      await this.notifications.emit({
        vendorId,
        type: args.type,
        title: args.title,
        body: args.body,
        href: "/referrals",
        email: email
          ? {
              to: email,
              subject: args.subject,
              html: `<p>${args.body}</p><p><a href="https://usaerrands.com/referrals">View your referrals</a></p>`,
              text: `${args.body}\n\nView your referrals: https://usaerrands.com/referrals`,
            }
          : undefined,
      });
    } catch (err) {
      this.logger.warn({ msg: "notifyVendor failed (non-fatal)", vendorId, err: `${err}` });
    }
  }
}
