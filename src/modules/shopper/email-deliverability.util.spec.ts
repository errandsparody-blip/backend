import { BadRequestException } from "@nestjs/common";

jest.mock("node:dns", () => ({
  promises: { resolveMx: jest.fn(), resolve: jest.fn() },
}));

import { promises as dns } from "node:dns";

import { assertEmailDeliverable } from "./email-deliverability.util";

const resolveMx = dns.resolveMx as unknown as jest.Mock;
const resolve = dns.resolve as unknown as jest.Mock;

function dnsError(code: string): NodeJS.ErrnoException {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe("assertEmailDeliverable", () => {
  beforeEach(() => {
    resolveMx.mockReset();
    resolve.mockReset();
  });

  it("accepts a domain with MX records", async () => {
    resolveMx.mockResolvedValue([{ exchange: "mx.gmail.com", priority: 10 }]);
    await expect(assertEmailDeliverable("a@gmail.com")).resolves.toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("accepts a domain with no MX but an A record (implicit MX)", async () => {
    resolveMx.mockRejectedValue(dnsError("ENODATA"));
    resolve.mockResolvedValue(["93.184.216.34"]);
    await expect(assertEmailDeliverable("a@example.com")).resolves.toBeUndefined();
  });

  it("rejects a domain that does not exist (no MX, no A)", async () => {
    resolveMx.mockRejectedValue(dnsError("ENOTFOUND"));
    resolve.mockRejectedValue(dnsError("ENOTFOUND"));
    await expect(
      assertEmailDeliverable("sean13@live.com.com.au"),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("fails OPEN on a transient DNS error (never blocks a real buyer)", async () => {
    resolveMx.mockRejectedValue(dnsError("ESERVFAIL"));
    await expect(assertEmailDeliverable("a@flaky.com")).resolves.toBeUndefined();
    // Should not even reach the A-record fallback on a transient MX error.
    expect(resolve).not.toHaveBeenCalled();
  });

  it("rejects an address with no domain", async () => {
    await expect(assertEmailDeliverable("not-an-email")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
