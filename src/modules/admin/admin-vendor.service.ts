/**
 * AdminVendorService — vendor lifecycle operations performed by USA Errands
 * staff (KYC review, manual social verification). Every state-changing method
 * writes an audit entry and emits a notification + email to the vendor.
 *
 * KYC state machine (matches the Prisma KycStatus enum):
 *
 *   PENDING               → IN_PROGRESS / REQUIRES_RESUBMISSION / REJECTED / APPROVED
 *   IN_PROGRESS           → APPROVED / REJECTED / REQUIRES_RESUBMISSION
 *   REQUIRES_RESUBMISSION → APPROVED / REJECTED / REQUIRES_RESUBMISSION
 *   APPROVED              → REJECTED   (only — admin can suspend later)
 *   REJECTED              → APPROVED   (admin re-review only)
 *   EXPIRED               → REQUIRES_RESUBMISSION
 *
 * Vendor.status mirrors the terminal state: APPROVED + agreement-accepted
 * promotes to ACTIVE, REJECTED demotes to SUSPENDED.
 *
 * Two reviewers required for any change to this file (Implementation Plan §17.1).
 */

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { KycStatus, VendorStatus } from "@prisma/client";

import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../audit/audit.service";
import {
  kycApprovedTemplate,
  kycRejectedTemplate,
  kycResubmissionTemplate,
} from "../email/email-templates";
import { NotificationService } from "../notifications/notification.service";

interface ActorContext {
  /** Admin user id performing the action. Required for audit. */
  actorId: string;
  /** Optional admin-only note attached to the audit entry. Never emailed. */
  notes?: string;
}

@Injectable()
export class AdminVendorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  /**
   * Full vendor detail for the admin review screen. Includes the primary
   * owner contact (the first user on the vendor row) so the admin can reach
   * out via email if something is unclear, and the wallet balance for context.
   */
  async getVendorDetail(vendorId: string) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
      include: {
        wallet: true,
        users: {
          // Primary contact = the original signup user. They're always the
          // VENDOR role; sub-users are VENDOR_SUB_USER and added later.
          where: { role: "VENDOR" },
          orderBy: { createdAt: "asc" },
          take: 1,
          select: { id: true, email: true, emailVerified: true, mfaEnrolled: true },
        },
      },
    });
    if (!vendor) throw new NotFoundException();

    const primaryUser = vendor.users[0] ?? null;

    return {
      id: vendor.id,
      businessName: vendor.businessName,
      country: vendor.country,
      kycStatus: vendor.kycStatus,
      kycSubmittedAt: vendor.kycSubmittedAt,
      kycApprovedAt: vendor.kycApprovedAt,
      kycRejectedAt: vendor.kycRejectedAt,
      kycRejectionReason: vendor.kycRejectionReason,
      kycDecidedBy: vendor.kycDecidedBy,
      agreementAcceptedAt: vendor.agreementAcceptedAt,
      agreementVersion: vendor.agreementVersion,
      status: vendor.status,
      instagramHandle: vendor.instagramHandle,
      tiktokHandle: vendor.tiktokHandle,
      xHandle: vendor.xHandle,
      websiteUrl: vendor.websiteUrl,
      socialVerifiedAt: vendor.socialVerifiedAt,
      socialVerifiedBy: vendor.socialVerifiedBy,
      createdAt: vendor.createdAt,
      updatedAt: vendor.updatedAt,
      primaryUser,
      wallet: vendor.wallet
        ? {
            balanceCents: vendor.wallet.balanceCents,
            status: vendor.wallet.status,
            lowBalanceThresholdCents: vendor.wallet.lowBalanceThresholdCents,
          }
        : null,
    };
  }

  // ---------------------------------------------------------------------------
  // KYC decisions
  // ---------------------------------------------------------------------------

  async approveKyc(vendorId: string, ctx: ActorContext) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
      include: {
        users: { where: { role: "VENDOR" }, take: 1, select: { id: true, email: true } },
      },
    });
    if (!vendor) throw new NotFoundException();

    if (vendor.kycStatus === KycStatus.APPROVED) {
      // Idempotent — re-approving an already-approved vendor is a no-op.
      return this.getVendorDetail(vendorId);
    }
    if (vendor.status === VendorStatus.CLOSED) {
      throw new BadRequestException({
        message: "Cannot approve KYC on a closed account.",
        code: "vendor_closed",
      });
    }

    const now = new Date();
    // Promote to ACTIVE only if the agreement is also signed. Otherwise the
    // vendor stays at PENDING_KYC until they accept.
    const becomingActive = vendor.agreementAcceptedAt !== null;

    await this.prisma.vendor.update({
      where: { id: vendorId },
      data: {
        kycStatus: KycStatus.APPROVED,
        kycApprovedAt: now,
        kycRejectedAt: null,
        kycRejectionReason: null,
        kycDecidedBy: ctx.actorId,
        ...(becomingActive ? { status: VendorStatus.ACTIVE } : {}),
      },
    });

    await this.audit.log({
      actorId: ctx.actorId,
      action: "vendor.kyc_approved",
      resourceType: "vendor",
      resourceId: vendorId,
      beforeState: { kycStatus: vendor.kycStatus, status: vendor.status },
      afterState: {
        kycStatus: KycStatus.APPROVED,
        status: becomingActive ? VendorStatus.ACTIVE : vendor.status,
        notes: ctx.notes ?? null,
      },
    });

    await this.notifyVendor({
      vendorId,
      type: "vendor.kyc_approved",
      severity: "INFO",
      title: "KYC approved",
      body: becomingActive
        ? "Your account is fully active. Submit your first PSN to ship inventory in."
        : "KYC is approved. Accept the vendor agreement to activate your account.",
      href: becomingActive ? "/dashboard" : "/settings/agreement",
      email: kycApprovedTemplate({ businessName: vendor.businessName }),
      ownerUserId: vendor.users[0]?.id ?? null,
    });

    return this.getVendorDetail(vendorId);
  }

  async rejectKyc(vendorId: string, reason: string, ctx: ActorContext) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
      include: {
        users: { where: { role: "VENDOR" }, take: 1, select: { id: true, email: true } },
      },
    });
    if (!vendor) throw new NotFoundException();
    if (vendor.kycStatus === KycStatus.REJECTED) {
      // Idempotent: re-rejecting (perhaps with a different reason) updates the
      // reason text but stays in REJECTED.
    }

    const now = new Date();
    await this.prisma.vendor.update({
      where: { id: vendorId },
      data: {
        kycStatus: KycStatus.REJECTED,
        kycRejectedAt: now,
        kycRejectionReason: reason,
        kycDecidedBy: ctx.actorId,
        status: VendorStatus.SUSPENDED,
      },
    });

    await this.audit.log({
      actorId: ctx.actorId,
      action: "vendor.kyc_rejected",
      resourceType: "vendor",
      resourceId: vendorId,
      beforeState: { kycStatus: vendor.kycStatus, status: vendor.status },
      // Reason is part of the audit trail — operationally critical record of
      // why the decision was made. NOT scrubbed even though it's user-facing.
      afterState: {
        kycStatus: KycStatus.REJECTED,
        status: VendorStatus.SUSPENDED,
        reason,
        notes: ctx.notes ?? null,
      },
    });

    await this.notifyVendor({
      vendorId,
      type: "vendor.kyc_rejected",
      severity: "WARNING",
      title: "KYC review outcome",
      body: "We can't proceed with onboarding right now. See your inbox for details.",
      email: kycRejectedTemplate({ businessName: vendor.businessName, reason }),
      ownerUserId: vendor.users[0]?.id ?? null,
    });

    return this.getVendorDetail(vendorId);
  }

  async requestResubmission(vendorId: string, reason: string, ctx: ActorContext) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
      include: {
        users: { where: { role: "VENDOR" }, take: 1, select: { id: true, email: true } },
      },
    });
    if (!vendor) throw new NotFoundException();

    if (vendor.kycStatus === KycStatus.APPROVED) {
      throw new BadRequestException({
        message: "Already approved. Reject first if you need to undo.",
        code: "vendor_already_approved",
      });
    }
    if (vendor.status === VendorStatus.CLOSED) {
      throw new ForbiddenException({
        message: "Account is closed.",
        code: "vendor_closed",
      });
    }

    await this.prisma.vendor.update({
      where: { id: vendorId },
      data: {
        kycStatus: KycStatus.REQUIRES_RESUBMISSION,
        kycRejectionReason: reason, // surface the same field so the vendor sees the latest message
        kycDecidedBy: ctx.actorId,
      },
    });

    await this.audit.log({
      actorId: ctx.actorId,
      action: "vendor.kyc_resubmission_requested",
      resourceType: "vendor",
      resourceId: vendorId,
      beforeState: { kycStatus: vendor.kycStatus },
      afterState: {
        kycStatus: KycStatus.REQUIRES_RESUBMISSION,
        reason,
        notes: ctx.notes ?? null,
      },
    });

    await this.notifyVendor({
      vendorId,
      type: "vendor.kyc_resubmission_requested",
      severity: "WARNING",
      title: "Action needed: KYC resubmission",
      body: "We need a few details corrected. Open settings to fix and we'll re-review.",
      href: "/settings",
      email: kycResubmissionTemplate({ businessName: vendor.businessName, reason }),
      ownerUserId: vendor.users[0]?.id ?? null,
    });

    return this.getVendorDetail(vendorId);
  }

  // ---------------------------------------------------------------------------
  // Social verification
  // ---------------------------------------------------------------------------

  /**
   * Mark the vendor's social presence as reviewed. Internal-only — does not
   * email the vendor (it's a reviewer's checkpoint, not a decision they need
   * to act on).
   *
   * Calling this on a vendor with NO handles set is rejected — you can't
   * verify what isn't there.
   */
  async markSocialVerified(vendorId: string, ctx: ActorContext) {
    const vendor = await this.prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor) throw new NotFoundException();

    const hasAnyHandle =
      !!vendor.instagramHandle || !!vendor.tiktokHandle || !!vendor.xHandle || !!vendor.websiteUrl;
    if (!hasAnyHandle) {
      throw new BadRequestException({
        message: "Vendor has no social handles to verify.",
        code: "vendor_no_social_handles",
      });
    }

    await this.prisma.vendor.update({
      where: { id: vendorId },
      data: {
        socialVerifiedAt: new Date(),
        socialVerifiedBy: ctx.actorId,
      },
    });

    await this.audit.log({
      actorId: ctx.actorId,
      action: "vendor.social_verified",
      resourceType: "vendor",
      resourceId: vendorId,
      afterState: {
        instagramHandle: vendor.instagramHandle,
        tiktokHandle: vendor.tiktokHandle,
        xHandle: vendor.xHandle,
        websiteUrl: vendor.websiteUrl,
        notes: ctx.notes ?? null,
      },
    });

    return this.getVendorDetail(vendorId);
  }

  // ---------------------------------------------------------------------------

  private async notifyVendor(args: {
    vendorId: string;
    type: string;
    severity: "INFO" | "WARNING" | "ERROR";
    title: string;
    body: string;
    href?: string;
    email: { subject: string; html: string; text: string };
    ownerUserId: string | null;
  }) {
    await this.notifications.emit({
      vendorId: args.vendorId,
      type: args.type,
      severity: args.severity,
      title: args.title,
      body: args.body,
      ...(args.href ? { href: args.href } : {}),
      email: { subject: args.email.subject, html: args.email.html, text: args.email.text },
    });
    // EmailService is invoked through NotificationService.emit when an email
    // payload is supplied — sending it here too would double-deliver. Left
    // commented for posterity in case the notifications module changes.
    // if (args.ownerUserId) {
    //   await this.email.send({ to: ..., type: args.type, userId: args.ownerUserId, ... });
    // }
  }
}
