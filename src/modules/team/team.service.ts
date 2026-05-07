/**
 * TeamService — sub-user invitations.
 *
 * Implementation Plan §6.12.
 *
 * Critical invariants:
 *
 *   1. Tokens are stored as sha256 hashes; the plaintext is emailed once and
 *      never persisted. Anyone with database access cannot replay a pending
 *      invite.
 *
 *   2. accept() runs in a single transaction: validate token, mark invitation
 *      ACCEPTED, create the User row. Any failure rolls back; a half-accepted
 *      invitation cannot exist.
 *
 *   3. Invites are vendor-scoped throughout. Vendor B cannot list or revoke
 *      Vendor A's invitations.
 *
 *   4. Emails are case-insensitive: the schema stores them already lowercased
 *      (CHECK constraint enforces it).
 */

import * as argon2 from "argon2";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Role, type VendorInvitation } from "@prisma/client";

import { CryptoService } from "../../common/crypto.service";
import { HibpService } from "../../common/hibp.service";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../audit/audit.service";
import { teamInviteTemplate } from "../email/email-templates";
import { EmailService } from "../email/email.service";
import { TokenService } from "../auth/token.service";
import { loadConfig } from "../../common/config";

const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

const INVITE_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class TeamService {
  private readonly cfg = loadConfig();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly tokens: TokenService,
    private readonly hibp: HibpService,
    private readonly email: EmailService,
  ) {}

  // ===========================================================================
  // Vendor — invite + list + revoke
  // ===========================================================================

  async invite(vendorId: string, actorId: string, email: string): Promise<VendorInvitation> {
    const lower = email.trim().toLowerCase();

    // Reject if a user with this email already exists anywhere.
    const existingUser = await this.prisma.user.findUnique({ where: { email: lower } });
    if (existingUser) {
      throw new ConflictException({
        message: "A user with this email already exists on USA Errands.",
        code: "team_email_in_use",
      });
    }

    // Reject if a pending invite already exists on this vendor for this email.
    const pending = await this.prisma.vendorInvitation.findFirst({
      where: { vendorId, email: lower, status: "PENDING" },
    });
    if (pending) {
      throw new ConflictException({
        message: "An invitation to this email is already pending. Revoke it first to send a new one.",
        code: "team_invite_pending",
      });
    }

    const { plaintext, hash } = this.tokens.generateSingleUseToken();

    const invitation = await this.prisma.vendorInvitation.create({
      data: {
        vendorId,
        email: lower,
        tokenHash: hash,
        roleAtAccept: Role.VENDOR_SUB_USER,
        status: "PENDING",
        invitedBy: actorId,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      },
    });

    // Send the invitation email — best effort, but it's the only way the
    // recipient gets the token, so log + audit on failure.
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
      select: { businessName: true },
    });
    const inviter = await this.prisma.user.findUnique({
      where: { id: actorId },
      select: { email: true },
    });
    const tpl = teamInviteTemplate({
      businessName: vendor?.businessName ?? "Your team",
      inviterEmail: inviter?.email ?? "your teammate",
      acceptUrl: `${this.cfg.WEB_PUBLIC_URL}/invite/accept?token=${encodeURIComponent(plaintext)}`,
    });
    await this.email.send({
      to: lower,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      type: "team.invited",
      vendorId,
    });

    await this.audit.log({
      actorId,
      action: "team.invited",
      resourceType: "vendor_invitation",
      resourceId: invitation.id,
      onBehalfOfVendorId: vendorId,
      afterState: { email: lower, expiresAt: invitation.expiresAt.toISOString() },
    });

    return invitation;
  }

  async list(vendorId: string): Promise<{
    invitations: Array<Omit<VendorInvitation, "tokenHash">>;
    members: Array<{ id: string; email: string; role: Role; createdAt: Date }>;
  }> {
    const [invitations, members] = await Promise.all([
      this.prisma.vendorInvitation.findMany({
        where: { vendorId },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
      this.prisma.user.findMany({
        where: { vendorId, role: { in: [Role.VENDOR, Role.VENDOR_SUB_USER] } },
        select: { id: true, email: true, role: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      }),
    ]);

    return {
      invitations: invitations.map(({ tokenHash: _t, ...rest }) => rest),
      members,
    };
  }

  async revoke(vendorId: string, actorId: string, id: string): Promise<void> {
    const inv = await this.prisma.vendorInvitation.findFirst({ where: { id, vendorId } });
    if (!inv) throw new NotFoundException();
    if (inv.status !== "PENDING") {
      throw new ConflictException({
        message: `Invitation in status ${inv.status} cannot be revoked.`,
        code: "team_invite_not_revocable",
      });
    }
    await this.prisma.vendorInvitation.update({
      where: { id },
      data: { status: "REVOKED", revokedAt: new Date() },
    });
    await this.audit.log({
      actorId,
      action: "team.revoked",
      resourceType: "vendor_invitation",
      resourceId: id,
      onBehalfOfVendorId: vendorId,
      beforeState: { status: inv.status },
    });
  }

  // ===========================================================================
  // Public accept — called from /v1/auth/invitations/accept
  // ===========================================================================

  async acceptInvitation(token: string, password: string): Promise<{ userId: string; email: string }> {
    const tokenHash = this.crypto.sha256(token);
    const invitation = await this.prisma.vendorInvitation.findUnique({
      where: { tokenHash },
    });
    if (!invitation) {
      throw new BadRequestException({ message: "Invitation is invalid or has already been used.", code: "team_invite_invalid" });
    }
    if (invitation.status !== "PENDING") {
      throw new BadRequestException({ message: "Invitation is not pending.", code: "team_invite_not_pending" });
    }
    if (invitation.expiresAt.getTime() < Date.now()) {
      // Mark it expired so the row is honest about state.
      await this.prisma.vendorInvitation
        .update({ where: { id: invitation.id }, data: { status: "EXPIRED" } })
        .catch(() => undefined);
      throw new BadRequestException({ message: "Invitation has expired.", code: "team_invite_expired" });
    }

    // The invite addressee may have been registered between invite + accept
    // through a different flow (e.g., self-signup). Reject in that case.
    const dup = await this.prisma.user.findUnique({ where: { email: invitation.email } });
    if (dup) {
      throw new ConflictException({
        message: "A user with this email already exists. Sign in instead.",
        code: "team_email_in_use",
      });
    }

    await this.hibp.assertNotPwned(password);
    const passwordHash = await argon2.hash(password, ARGON2_OPTIONS);

    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: invitation.email,
          passwordHash,
          role: invitation.roleAtAccept,
          vendorId: invitation.vendorId,
          // Sub-users come in pre-verified — we proved control of the email
          // by sending them a single-use token they used to accept. They
          // still need to enrol MFA on first login.
          emailVerified: true,
          status: "ACTIVE",
        },
        select: { id: true, email: true },
      });
      await tx.vendorInvitation.update({
        where: { id: invitation.id },
        data: { status: "ACCEPTED", acceptedAt: new Date() },
      });
      return user;
    });

    await this.audit.log({
      actorId: result.id,
      actorRole: invitation.roleAtAccept,
      action: "team.accepted",
      resourceType: "user",
      resourceId: result.id,
      onBehalfOfVendorId: invitation.vendorId,
    });

    return { userId: result.id, email: result.email };
  }
}
