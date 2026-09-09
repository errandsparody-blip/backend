/**
 * VendorDomainService — vendor custom domains (Migration 0062, Phase 3).
 *
 * Flow: vendor adds a host → we issue a verification token → they add a DNS TXT
 * record (`_usaerrands-verify.<host>` = `usaerrands-verify=<token>`) → we verify
 * by DNS lookup → status VERIFIED. The storefront resolver then maps that host
 * to the vendor. Actual traffic routing + per-domain SSL is provisioned in infra
 * (a wildcard/managed cert); this is the app-side registry + ownership proof.
 */
import { BadRequestException, ConflictException, Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomBytes } from "crypto";
import { promises as dns } from "node:dns";

import { PrismaService } from "../../common/prisma.service";

const HOST_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
const ROOT_DOMAIN = (process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "myusaerrands.com").toLowerCase();
export const TXT_PREFIX = "usaerrands-verify=";

export interface VendorDomainView {
  id: string;
  host: string;
  status: string;
  verificationToken: string;
  /** The DNS record the vendor must create. */
  txtName: string;
  txtValue: string;
  verifiedAt: Date | null;
}

@Injectable()
export class VendorDomainService {
  private readonly logger = new Logger(VendorDomainService.name);

  constructor(private readonly prisma: PrismaService) {}

  private view(row: {
    id: string;
    host: string;
    status: string;
    verification_token: string;
    verified_at: Date | null;
  }): VendorDomainView {
    return {
      id: row.id,
      host: row.host,
      status: row.status,
      verificationToken: row.verification_token,
      txtName: `_usaerrands-verify.${row.host}`,
      txtValue: `${TXT_PREFIX}${row.verification_token}`,
      verifiedAt: row.verified_at,
    };
  }

  async addDomain(vendorId: string, hostRaw: string): Promise<VendorDomainView> {
    const host = hostRaw.trim().toLowerCase().replace(/\.$/, "");
    if (!HOST_RE.test(host)) {
      throw new BadRequestException({ message: "Enter a valid domain, e.g. shop.yourbrand.com.", code: "invalid_host" });
    }
    if (host === ROOT_DOMAIN || host.endsWith(`.${ROOT_DOMAIN}`)) {
      throw new BadRequestException({
        message: "Use your storefront subdomain for that — custom domains are for your own domain.",
        code: "host_reserved",
      });
    }
    const token = randomBytes(16).toString("hex");
    try {
      const rows = await this.prisma.$queryRaw<
        Array<{ id: string; host: string; status: string; verification_token: string; verified_at: Date | null }>
      >(Prisma.sql`
        INSERT INTO vendor_domains (vendor_id, host, status, verification_token, created_at, updated_at)
        VALUES (${vendorId}::uuid, ${host}, 'PENDING', ${token}, now(), now())
        RETURNING id, host, status, verification_token, verified_at
      `);
      return this.view(rows[0]!);
    } catch (err) {
      if (`${err}`.includes("vendor_domains_host_key") || `${err}`.includes("unique")) {
        throw new ConflictException({ message: "That domain is already registered.", code: "host_taken" });
      }
      throw err;
    }
  }

  async listDomains(vendorId: string): Promise<VendorDomainView[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; host: string; status: string; verification_token: string; verified_at: Date | null }>
    >(Prisma.sql`
      SELECT id, host, status, verification_token, verified_at
      FROM vendor_domains WHERE vendor_id = ${vendorId}::uuid
      ORDER BY created_at DESC
    `);
    return rows.map((r) => this.view(r));
  }

  async removeDomain(vendorId: string, id: string): Promise<void> {
    await this.prisma.$executeRaw(Prisma.sql`
      DELETE FROM vendor_domains WHERE id = ${id}::uuid AND vendor_id = ${vendorId}::uuid
    `);
  }

  /** Verify ownership by looking up the DNS TXT record. */
  async verify(vendorId: string, id: string): Promise<VendorDomainView> {
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; host: string; status: string; verification_token: string; verified_at: Date | null }>
    >(Prisma.sql`
      SELECT id, host, status, verification_token, verified_at
      FROM vendor_domains WHERE id = ${id}::uuid AND vendor_id = ${vendorId}::uuid
      LIMIT 1
    `);
    const d = rows[0];
    if (!d) throw new BadRequestException({ message: "Domain not found.", code: "domain_not_found" });

    const expected = `${TXT_PREFIX}${d.verification_token}`;
    let found = false;
    try {
      const records = await dns.resolveTxt(`_usaerrands-verify.${d.host}`);
      found = records.some((chunks) => chunks.join("").trim() === expected);
    } catch (err) {
      this.logger.warn({ host: d.host, err: `${err}` }, "vendor_domain.txt_lookup_failed");
    }
    if (!found) {
      throw new BadRequestException({
        message: "We couldn't find the verification record yet. DNS can take a little while — try again shortly.",
        code: "domain_txt_not_found",
      });
    }
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE vendor_domains SET status = 'VERIFIED', verified_at = now(), updated_at = now()
      WHERE id = ${id}::uuid
    `);
    return this.view({ ...d, status: "VERIFIED", verified_at: new Date() });
  }
}
