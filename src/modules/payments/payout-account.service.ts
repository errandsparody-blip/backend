/**
 * PayoutAccountService — connects + tracks vendor payout destinations
 * (vendor_payout_accounts, Migration 0059). Secrets never touch this table;
 * we store only the external account/subaccount id and a mirrored status.
 *
 * Raw SQL throughout so it works before the Prisma client is regenerated.
 */
import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { PrismaService } from "../../common/prisma.service";

import type { ProcessorKey } from "./payment-processor.interface";
import { PaymentProcessorRegistry } from "./payment-processor.registry";
import { PaystackProcessor } from "./paystack.processor";
import { StripeConnectProcessor } from "./stripe-connect.processor";

export interface PayoutAccountRow {
  processor: ProcessorKey;
  externalAccountId: string | null;
  status: string;
  detailsSubmitted: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
}

@Injectable()
export class PayoutAccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: PaymentProcessorRegistry,
    private readonly stripe: StripeConnectProcessor,
    private readonly paystack: PaystackProcessor,
  ) {}

  /** Paystack settlement banks for the connect form's dropdown. */
  async listPaystackBanks(): Promise<Array<{ name: string; code: string }>> {
    if (!this.paystack.isConfigured()) return [];
    return this.paystack.listBanks();
  }

  async list(vendorId: string): Promise<PayoutAccountRow[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        processor: string;
        external_account_id: string | null;
        status: string;
        details_submitted: boolean;
        charges_enabled: boolean;
        payouts_enabled: boolean;
      }>
    >(Prisma.sql`
      SELECT processor, external_account_id, status, details_submitted,
             charges_enabled, payouts_enabled
      FROM vendor_payout_accounts WHERE vendor_id = ${vendorId}::uuid
      ORDER BY processor
    `);
    return rows.map((r) => ({
      processor: r.processor as ProcessorKey,
      externalAccountId: r.external_account_id,
      status: r.status,
      detailsSubmitted: r.details_submitted,
      chargesEnabled: r.charges_enabled,
      payoutsEnabled: r.payouts_enabled,
    }));
  }

  /** Start (or resume) Stripe Express onboarding; returns the hosted link. */
  async connectStripe(
    vendorId: string,
    args: { email?: string; country?: string; returnUrl: string; refreshUrl: string },
  ): Promise<{ url: string }> {
    const existing = await this.findRow(vendorId, "STRIPE");
    const { url, externalAccountId } = await this.stripe.createAccountLink({
      externalAccountId: existing?.external_account_id ?? null,
      email: args.email,
      country: args.country,
      returnUrl: args.returnUrl,
      refreshUrl: args.refreshUrl,
    });
    await this.upsert(vendorId, "STRIPE", {
      externalAccountId,
      status: "PENDING",
      detailsSubmitted: false,
      chargesEnabled: false,
      payoutsEnabled: false,
    });
    return { url };
  }

  /** Create a Paystack subaccount from the vendor's bank details. */
  async connectPaystack(
    vendorId: string,
    args: { businessName: string; settlementBank: string; accountNumber: string },
  ): Promise<PayoutAccountRow> {
    const { externalAccountId } = await this.paystack.createSubaccount(args);
    const snap = await this.paystack.getAccountStatus(externalAccountId);
    await this.upsert(vendorId, "PAYSTACK", {
      externalAccountId: snap.externalAccountId,
      status: snap.status,
      detailsSubmitted: snap.detailsSubmitted,
      chargesEnabled: snap.chargesEnabled,
      payoutsEnabled: snap.payoutsEnabled,
    });
    return {
      processor: "PAYSTACK",
      externalAccountId: snap.externalAccountId,
      status: snap.status,
      detailsSubmitted: snap.detailsSubmitted,
      chargesEnabled: snap.chargesEnabled,
      payoutsEnabled: snap.payoutsEnabled,
    };
  }

  /** Pull fresh status from the processor and mirror it locally. */
  async refresh(vendorId: string, processor: ProcessorKey): Promise<PayoutAccountRow> {
    const row = await this.findRow(vendorId, processor);
    if (!row?.external_account_id) {
      throw new NotFoundException({
        message: "No connected account for that processor.",
        code: "payout_account_not_found",
      });
    }
    const snap = await this.registry.get(processor).getAccountStatus(row.external_account_id);
    await this.upsert(vendorId, processor, {
      externalAccountId: snap.externalAccountId,
      status: snap.status,
      detailsSubmitted: snap.detailsSubmitted,
      chargesEnabled: snap.chargesEnabled,
      payoutsEnabled: snap.payoutsEnabled,
    });
    return {
      processor,
      externalAccountId: snap.externalAccountId,
      status: snap.status,
      detailsSubmitted: snap.detailsSubmitted,
      chargesEnabled: snap.chargesEnabled,
      payoutsEnabled: snap.payoutsEnabled,
    };
  }

  // ---------------------------------------------------------------------------

  private async findRow(
    vendorId: string,
    processor: ProcessorKey,
  ): Promise<{ external_account_id: string | null } | null> {
    const rows = await this.prisma.$queryRaw<Array<{ external_account_id: string | null }>>(
      Prisma.sql`
        SELECT external_account_id FROM vendor_payout_accounts
        WHERE vendor_id = ${vendorId}::uuid AND processor = ${processor}
        LIMIT 1
      `,
    );
    return rows[0] ?? null;
  }

  private async upsert(
    vendorId: string,
    processor: ProcessorKey,
    snap: {
      externalAccountId: string | null;
      status: string;
      detailsSubmitted: boolean;
      chargesEnabled: boolean;
      payoutsEnabled: boolean;
    },
  ): Promise<void> {
    await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO vendor_payout_accounts
        (vendor_id, processor, external_account_id, status, details_submitted,
         charges_enabled, payouts_enabled, created_at, updated_at)
      VALUES
        (${vendorId}::uuid, ${processor}, ${snap.externalAccountId}, ${snap.status},
         ${snap.detailsSubmitted}, ${snap.chargesEnabled}, ${snap.payoutsEnabled}, now(), now())
      ON CONFLICT (vendor_id, processor) DO UPDATE SET
        external_account_id = EXCLUDED.external_account_id,
        status              = EXCLUDED.status,
        details_submitted   = EXCLUDED.details_submitted,
        charges_enabled     = EXCLUDED.charges_enabled,
        payouts_enabled     = EXCLUDED.payouts_enabled,
        updated_at          = now()
    `);
  }
}
