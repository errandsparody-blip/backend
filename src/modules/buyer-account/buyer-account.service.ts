/**
 * BuyerAccountService — optional, passwordless buyer accounts (Migration 0060).
 *
 * Guests can always check out with just an email. An account additionally saves
 * their default details for faster future checkout and exposes order history.
 * Sign-in is a magic link: we email a one-time token, exchange it for a session
 * token, and only ever store token HASHES. All persistence is raw SQL
 * (stale-client-safe). Order history is matched by the account's email.
 */
import { Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash, randomBytes } from "crypto";

import { PrismaService } from "../../common/prisma.service";
import { EmailService } from "../email/email.service";
import { buyerLoginTemplate } from "../email/email-templates";

const LOGIN_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function sha256(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}
function newToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: sha256(raw) };
}

export interface BuyerProfile {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  defaultShipAddress: unknown;
}

@Injectable()
export class BuyerAccountService {
  private readonly logger = new Logger(BuyerAccountService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  /** Upsert the buyer's own details (no auth — they supplied their email). */
  async save(input: {
    email: string;
    name?: string;
    phone?: string;
    shipAddress?: unknown;
  }): Promise<{ saved: true }> {
    const email = input.email.trim().toLowerCase();
    const addr = input.shipAddress ? JSON.stringify(input.shipAddress) : null;
    await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO buyer_accounts (email, name, phone, default_ship_address, created_at, updated_at)
      VALUES (${email}, ${input.name ?? null}, ${input.phone ?? null}, ${addr}::jsonb, now(), now())
      ON CONFLICT (email) DO UPDATE SET
        name = COALESCE(EXCLUDED.name, buyer_accounts.name),
        phone = COALESCE(EXCLUDED.phone, buyer_accounts.phone),
        default_ship_address = COALESCE(EXCLUDED.default_ship_address, buyer_accounts.default_ship_address),
        updated_at = now()
    `);
    return { saved: true };
  }

  /** Email a magic sign-in link (creating the account if it doesn't exist). */
  async requestLink(email: string, linkBase: string): Promise<{ sent: true }> {
    const normalized = email.trim().toLowerCase();
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      INSERT INTO buyer_accounts (email, created_at, updated_at)
      VALUES (${normalized}, now(), now())
      ON CONFLICT (email) DO UPDATE SET updated_at = now()
      RETURNING id
    `);
    const accountId = rows[0]!.id;
    const { raw, hash } = newToken();
    await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO buyer_login_tokens (buyer_account_id, token_hash, expires_at, created_at)
      VALUES (${accountId}::uuid, ${hash}, ${new Date(Date.now() + LOGIN_TOKEN_TTL_MS)}, now())
    `);
    const link = `${linkBase}${linkBase.includes("?") ? "&" : "?"}token=${encodeURIComponent(raw)}`;
    const tpl = buyerLoginTemplate({ link });
    await this.email.send({
      to: normalized,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      type: "buyer.login_link",
    });
    // Always report success so we don't leak which emails have accounts.
    return { sent: true };
  }

  /** Exchange a magic-link token for a session token + profile. */
  async verify(rawToken: string): Promise<{ sessionToken: string; profile: BuyerProfile }> {
    const hash = sha256(rawToken.trim());
    const rows = await this.prisma.$queryRaw<Array<{ id: string; buyer_account_id: string }>>(
      Prisma.sql`
        SELECT id, buyer_account_id FROM buyer_login_tokens
        WHERE token_hash = ${hash} AND consumed_at IS NULL AND expires_at > now()
        LIMIT 1
      `,
    );
    const tok = rows[0];
    if (!tok) {
      throw new UnauthorizedException({
        message: "This sign-in link is invalid or has expired.",
        code: "buyer_link_invalid",
      });
    }
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE buyer_login_tokens SET consumed_at = now() WHERE id = ${tok.id}::uuid
    `);
    const { raw, hash: sessHash } = newToken();
    await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO buyer_sessions (buyer_account_id, token_hash, expires_at, created_at)
      VALUES (${tok.buyer_account_id}::uuid, ${sessHash}, ${new Date(Date.now() + SESSION_TTL_MS)}, now())
    `);
    const profile = await this.getProfile(tok.buyer_account_id);
    return { sessionToken: raw, profile };
  }

  /** Resolve a session token → account id (or throw 401). */
  async resolveSession(rawToken: string | undefined): Promise<string> {
    if (!rawToken) throw this.unauthorized();
    const rows = await this.prisma.$queryRaw<Array<{ buyer_account_id: string }>>(Prisma.sql`
      SELECT buyer_account_id FROM buyer_sessions
      WHERE token_hash = ${sha256(rawToken.trim())} AND expires_at > now()
      LIMIT 1
    `);
    const r = rows[0];
    if (!r) throw this.unauthorized();
    return r.buyer_account_id;
  }

  async getProfile(accountId: string): Promise<BuyerProfile> {
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; email: string; name: string | null; phone: string | null; default_ship_address: unknown }>
    >(Prisma.sql`
      SELECT id, email, name, phone, default_ship_address
      FROM buyer_accounts WHERE id = ${accountId}::uuid
    `);
    const r = rows[0];
    if (!r) throw this.unauthorized();
    return {
      id: r.id,
      email: r.email,
      name: r.name,
      phone: r.phone,
      defaultShipAddress: r.default_ship_address,
    };
  }

  /** Profile + recent storefront orders (matched by the account's email). */
  async getMe(accountId: string): Promise<{ profile: BuyerProfile; orders: unknown[] }> {
    const profile = await this.getProfile(accountId);
    const orders = await this.prisma.$queryRaw<unknown[]>(Prisma.sql`
      SELECT reference, status, total_cents, shipping_speed, tracking_number, created_at, shipped_at
      FROM storefront_orders
      WHERE lower(buyer_email) = ${profile.email}
      ORDER BY created_at DESC
      LIMIT 50
    `);
    return { profile, orders };
  }

  async updateProfile(
    accountId: string,
    input: { name?: string | null; phone?: string | null; defaultShipAddress?: unknown },
  ): Promise<BuyerProfile> {
    const addr =
      input.defaultShipAddress === undefined
        ? undefined
        : input.defaultShipAddress === null
          ? null
          : JSON.stringify(input.defaultShipAddress);
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE buyer_accounts SET
        name = ${input.name === undefined ? Prisma.sql`name` : Prisma.sql`${input.name}`},
        phone = ${input.phone === undefined ? Prisma.sql`phone` : Prisma.sql`${input.phone}`},
        default_ship_address = ${
          addr === undefined ? Prisma.sql`default_ship_address` : Prisma.sql`${addr}::jsonb`
        },
        updated_at = now()
      WHERE id = ${accountId}::uuid
    `);
    return this.getProfile(accountId);
  }

  private unauthorized(): UnauthorizedException {
    return new UnauthorizedException({ message: "Please sign in.", code: "buyer_unauthorized" });
  }
}
