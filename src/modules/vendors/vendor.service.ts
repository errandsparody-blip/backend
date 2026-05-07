/**
 * VendorService — vendor self-management. Strict tenant isolation: every
 * method takes vendorId as the first parameter. Admin operations live on a
 * separate AdminVendorService (P1+) that goes through the assume-vendor flow.
 *
 * Implementation Plan §4.3, §6.1.
 */

import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { KycStatus, VendorStatus } from "@prisma/client";

import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../audit/audit.service";

export interface VendorProfile {
  id: string;
  businessName: string;
  country: string;
  kycStatus: KycStatus;
  agreementAcceptedAt: Date | null;
  agreementVersion: string | null;
  status: VendorStatus;
  createdAt: Date;

  // Public social presence — surfaced so the vendor can see what they've set
  // and the admin reviewer can verify it. All optional.
  instagramHandle: string | null;
  tiktokHandle: string | null;
  xHandle: string | null;
  websiteUrl: string | null;
  socialVerifiedAt: Date | null;
}

@Injectable()
export class VendorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async getProfile(vendorId: string): Promise<VendorProfile> {
    const vendor = await this.prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor) throw new NotFoundException();
    return {
      id: vendor.id,
      businessName: vendor.businessName,
      country: vendor.country,
      kycStatus: vendor.kycStatus,
      agreementAcceptedAt: vendor.agreementAcceptedAt,
      agreementVersion: vendor.agreementVersion,
      status: vendor.status,
      createdAt: vendor.createdAt,
      instagramHandle: vendor.instagramHandle,
      tiktokHandle: vendor.tiktokHandle,
      xHandle: vendor.xHandle,
      websiteUrl: vendor.websiteUrl,
      socialVerifiedAt: vendor.socialVerifiedAt,
    };
  }

  /**
   * Update the vendor's editable profile fields.
   *
   * Social-handle changes RESET the social verification stamp — once a vendor
   * edits any handle, the admin's previous "I checked, they look real" call
   * is no longer valid against the new profile. The reviewer queue picks the
   * vendor back up automatically.
   */
  async updateProfile(
    vendorId: string,
    actorId: string,
    patch: {
      businessName?: string;
      instagramHandle?: string | null;
      tiktokHandle?: string | null;
      xHandle?: string | null;
      websiteUrl?: string | null;
    },
  ): Promise<VendorProfile> {
    const before = await this.prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!before) throw new NotFoundException();

    const handleChanged =
      (patch.instagramHandle !== undefined && patch.instagramHandle !== before.instagramHandle) ||
      (patch.tiktokHandle !== undefined && patch.tiktokHandle !== before.tiktokHandle) ||
      (patch.xHandle !== undefined && patch.xHandle !== before.xHandle) ||
      (patch.websiteUrl !== undefined && patch.websiteUrl !== before.websiteUrl);

    const updated = await this.prisma.vendor.update({
      where: { id: vendorId },
      data: {
        ...patch,
        // Re-verification required after any social edit.
        ...(handleChanged
          ? { socialVerifiedAt: null, socialVerifiedBy: null }
          : {}),
      },
    });
    await this.audit.log({
      actorId,
      action: "vendor.profile_updated",
      resourceType: "vendor",
      resourceId: vendorId,
      beforeState: {
        businessName: before.businessName,
        instagramHandle: before.instagramHandle,
        tiktokHandle: before.tiktokHandle,
        xHandle: before.xHandle,
        websiteUrl: before.websiteUrl,
      },
      afterState: {
        businessName: updated.businessName,
        instagramHandle: updated.instagramHandle,
        tiktokHandle: updated.tiktokHandle,
        xHandle: updated.xHandle,
        websiteUrl: updated.websiteUrl,
        socialReverificationRequired: handleChanged,
      },
    });
    return this.getProfile(vendorId);
  }

  /**
   * Accept the vendor agreement. Records timestamp + version. Idempotent: if
   * already accepted, this is a no-op (returns the existing record).
   */
  async acceptAgreement(vendorId: string, actorId: string, version: string): Promise<VendorProfile> {
    const vendor = await this.prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor) throw new NotFoundException();
    if (vendor.agreementAcceptedAt && vendor.agreementVersion === version) {
      return this.getProfile(vendorId);
    }
    await this.prisma.vendor.update({
      where: { id: vendorId },
      data: {
        agreementAcceptedAt: new Date(),
        agreementVersion: version,
        // Once both KYC + agreement clear, the vendor becomes ACTIVE.
        ...(vendor.kycStatus === KycStatus.APPROVED ? { status: VendorStatus.ACTIVE } : {}),
      },
    });
    await this.audit.log({
      actorId,
      action: "vendor.agreement_accepted",
      resourceType: "vendor",
      resourceId: vendorId,
      afterState: { version },
    });
    return this.getProfile(vendorId);
  }

  /**
   * Vendor self-submits their account for KYC review.
   *
   * Pre-conditions:
   *   - Current kycStatus is PENDING or REQUIRES_RESUBMISSION (the only states
   *     from which a vendor can submit for review). APPROVED vendors stay
   *     approved; REJECTED vendors must contact support.
   *   - At least one social handle is provided. Without any web presence the
   *     reviewer has nothing to verify.
   *
   * Result: kycStatus → IN_PROGRESS, kycSubmittedAt set, audit entry written.
   * The admin queue picks it up automatically.
   */
  async submitKyc(vendorId: string, actorId: string): Promise<VendorProfile> {
    const vendor = await this.prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor) throw new NotFoundException();

    if (
      vendor.kycStatus !== KycStatus.PENDING &&
      vendor.kycStatus !== KycStatus.REQUIRES_RESUBMISSION &&
      vendor.kycStatus !== KycStatus.EXPIRED
    ) {
      throw new BadRequestException({
        message: "KYC cannot be submitted in the current state.",
        code: "kyc_not_submittable",
      });
    }

    const hasAnyHandle =
      !!vendor.instagramHandle ||
      !!vendor.tiktokHandle ||
      !!vendor.xHandle ||
      !!vendor.websiteUrl;
    if (!hasAnyHandle) {
      throw new BadRequestException({
        message: "Add at least one social handle or your business website before submitting.",
        code: "kyc_needs_social_handles",
      });
    }

    await this.prisma.vendor.update({
      where: { id: vendorId },
      data: {
        kycStatus: KycStatus.IN_PROGRESS,
        kycSubmittedAt: new Date(),
        // Clearing the previous reviewer note signals to the admin that this
        // is a fresh submission, not a re-review of the same evidence.
        kycRejectionReason: null,
      },
    });

    await this.audit.log({
      actorId,
      action: "vendor.kyc_submitted",
      resourceType: "vendor",
      resourceId: vendorId,
      beforeState: { kycStatus: vendor.kycStatus },
      afterState: { kycStatus: KycStatus.IN_PROGRESS },
    });

    return this.getProfile(vendorId);
  }

  /**
   * Mark the vendor's KYC status. Called by the KYC webhook handler (P1.6).
   * Activates the vendor if the agreement is also signed.
   */
  async setKycStatus(vendorId: string, status: KycStatus, providerId: string | null): Promise<void> {
    const vendor = await this.prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor) throw new NotFoundException();

    const now = new Date();
    const becomingActive =
      status === KycStatus.APPROVED && vendor.agreementAcceptedAt !== null;

    await this.prisma.vendor.update({
      where: { id: vendorId },
      data: {
        kycStatus: status,
        kycProviderId: providerId ?? vendor.kycProviderId,
        kycSubmittedAt: vendor.kycSubmittedAt ?? (status === KycStatus.IN_PROGRESS ? now : null),
        kycApprovedAt: status === KycStatus.APPROVED ? now : vendor.kycApprovedAt,
        ...(becomingActive ? { status: VendorStatus.ACTIVE } : {}),
        ...(status === KycStatus.REJECTED ? { status: VendorStatus.SUSPENDED } : {}),
      },
    });

    await this.audit.log({
      action: "vendor.kyc_status_changed",
      resourceType: "vendor",
      resourceId: vendorId,
      beforeState: { kycStatus: vendor.kycStatus },
      afterState: { kycStatus: status, providerId },
    });
  }
}
