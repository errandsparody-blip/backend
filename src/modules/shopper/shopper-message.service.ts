/**
 * ShopperMessageService — chat thread between buyer and admin on a
 * single ShopperRequest.
 *
 * Both sides post here. Sender and senderUserId are linked via a DB
 * CHECK constraint (ADMIN messages must have a userId; BUYER messages
 * must not). The frontend never gets to choose `sender` directly — the
 * controllers determine it from the request context (token-auth =>
 * BUYER, JWT admin auth => ADMIN).
 *
 * Read receipts are coarse: marking as read sets `readByXAt = now()` for
 * every message older than now from the OTHER side. We don't track
 * per-message reads — overkill for this use case and mostly noise in
 * the audit log.
 */

import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";

import { PrismaService } from "../../common/prisma.service";
import type { ShopperMessageSender } from "../../common/schemas/shopper.schema";

// Cast helpers — see the long-form note in shopper-token.service.ts. The
// Prisma client doesn't know about the new tables until `prisma generate`
// runs on Railway. These narrow type assertions stay safe post-deploy.
type AnyPrismaShopperMessage = {
  create: (args: unknown) => Promise<unknown>;
  findMany: (args: unknown) => Promise<MessageRow[]>;
  updateMany: (args: unknown) => Promise<unknown>;
};
type AnyPrismaShopperRequest = {
  findUnique: (args: unknown) => Promise<{ id: string } | null>;
};

export interface MessageRow {
  id: string;
  requestId: string;
  sender: ShopperMessageSender;
  senderUserId: string | null;
  body: string;
  attachmentUrls: string[];
  readByBuyerAt: Date | null;
  readByAdminAt: Date | null;
  createdAt: Date;
}

export interface PostBuyerMessageInput {
  requestId: string;
  body: string;
  attachmentUrls?: string[];
}

export interface PostAdminMessageInput {
  requestId: string;
  senderUserId: string;
  body: string;
  attachmentUrls?: string[];
}

@Injectable()
export class ShopperMessageService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // Posts — never mix sender data; use the appropriate method.
  // ---------------------------------------------------------------------------

  async postFromBuyer(input: PostBuyerMessageInput): Promise<MessageRow> {
    await this.assertRequestExists(input.requestId);
    const created = (await (
      this.prisma as unknown as { shopperMessage: AnyPrismaShopperMessage }
    ).shopperMessage.create({
      data: {
        requestId: input.requestId,
        sender: "BUYER",
        senderUserId: null,
        body: input.body,
        attachmentUrls: input.attachmentUrls ?? [],
      },
    })) as MessageRow;
    return created;
  }

  async postFromAdmin(input: PostAdminMessageInput): Promise<MessageRow> {
    await this.assertRequestExists(input.requestId);
    if (!input.senderUserId) {
      // Defensive: the controller should always supply this, but a missing
      // value would silently violate the DB CHECK constraint with a
      // confusing Postgres error. Fail loudly here instead.
      throw new ForbiddenException({
        message: "Admin sender id missing on outgoing message.",
        code: "shopper_admin_id_missing",
      });
    }
    const created = (await (
      this.prisma as unknown as { shopperMessage: AnyPrismaShopperMessage }
    ).shopperMessage.create({
      data: {
        requestId: input.requestId,
        sender: "ADMIN",
        senderUserId: input.senderUserId,
        body: input.body,
        attachmentUrls: input.attachmentUrls ?? [],
      },
    })) as MessageRow;
    return created;
  }

  // ---------------------------------------------------------------------------
  // Read.
  // ---------------------------------------------------------------------------

  async listForRequest(requestId: string): Promise<MessageRow[]> {
    return (
      this.prisma as unknown as { shopperMessage: AnyPrismaShopperMessage }
    ).shopperMessage.findMany({
      where: { requestId },
      orderBy: { createdAt: "asc" },
    });
  }

  // ---------------------------------------------------------------------------
  // Read receipts (coarse — bulk-mark every other-sender message before now).
  // ---------------------------------------------------------------------------

  async markReadByBuyer(requestId: string): Promise<void> {
    await (this.prisma as unknown as { shopperMessage: AnyPrismaShopperMessage })
      .shopperMessage.updateMany({
        where: { requestId, sender: "ADMIN", readByBuyerAt: null },
        data: { readByBuyerAt: new Date() },
      });
  }

  async markReadByAdmin(requestId: string): Promise<void> {
    await (this.prisma as unknown as { shopperMessage: AnyPrismaShopperMessage })
      .shopperMessage.updateMany({
        where: { requestId, sender: "BUYER", readByAdminAt: null },
        data: { readByAdminAt: new Date() },
      });
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async assertRequestExists(requestId: string): Promise<void> {
    const row = await (
      this.prisma as unknown as { shopperRequest: AnyPrismaShopperRequest }
    ).shopperRequest.findUnique({
      where: { id: requestId },
      select: { id: true },
    });
    if (!row) {
      throw new NotFoundException({
        message: "Shopper request not found.",
        code: "shopper_request_not_found",
      });
    }
  }
}
