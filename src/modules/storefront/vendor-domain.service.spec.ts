import { BadRequestException } from "@nestjs/common";

jest.mock("node:dns", () => ({ promises: { resolveTxt: jest.fn() } }));

import { promises as dns } from "node:dns";

import { VendorDomainService } from "./vendor-domain.service";

const resolveTxt = dns.resolveTxt as unknown as jest.Mock;
const VENDOR = "11111111-1111-1111-1111-111111111111";

function makeService(row?: Record<string, unknown>) {
  const prisma = {
    $queryRaw: jest.fn(async () =>
      row
        ? [row]
        : [{ id: "d1", host: "shop.brand.com", status: "PENDING", verification_token: "tok123", verified_at: null }],
    ),
    $executeRaw: jest.fn(async () => 1),
  };
  return { service: new VendorDomainService(prisma as never), prisma };
}

describe("VendorDomainService.addDomain", () => {
  it("rejects an invalid host", async () => {
    const { service } = makeService();
    await expect(service.addDomain(VENDOR, "not a domain")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects our own root domain / subdomains", async () => {
    const { service } = makeService();
    await expect(service.addDomain(VENDOR, "acme.myusaerrands.com")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("registers a valid host and returns the TXT record to set", async () => {
    const { service } = makeService();
    const res = await service.addDomain(VENDOR, "Shop.Brand.com");
    expect(res.host).toBe("shop.brand.com");
    expect(res.txtName).toBe("_usaerrands-verify.shop.brand.com");
    expect(res.txtValue).toBe(`usaerrands-verify=${res.verificationToken}`);
  });
});

describe("VendorDomainService.verify", () => {
  const domainRow = {
    id: "d1",
    host: "shop.brand.com",
    status: "PENDING",
    verification_token: "tok123",
    verified_at: null,
  };

  it("verifies when the TXT record matches", async () => {
    resolveTxt.mockResolvedValueOnce([["usaerrands-verify=tok123"]]);
    const { service } = makeService(domainRow);
    const res = await service.verify(VENDOR, "d1");
    expect(res.status).toBe("VERIFIED");
  });

  it("fails when the TXT record is missing", async () => {
    resolveTxt.mockResolvedValueOnce([["something-else"]]);
    const { service } = makeService(domainRow);
    await expect(service.verify(VENDOR, "d1")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("fails gracefully when DNS lookup throws", async () => {
    resolveTxt.mockRejectedValueOnce(new Error("ENOTFOUND"));
    const { service } = makeService(domainRow);
    await expect(service.verify(VENDOR, "d1")).rejects.toBeInstanceOf(BadRequestException);
  });
});
