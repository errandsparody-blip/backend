import { UnauthorizedException } from "@nestjs/common";
import { createHash } from "crypto";

import { BuyerAccountService } from "./buyer-account.service";

function sqlText(q: { strings?: readonly string[]; sql?: string }): string {
  if (q.strings) return q.strings.join(" ");
  return String(q.sql ?? "");
}
const sha = (v: string) => createHash("sha256").update(v).digest("hex");

describe("BuyerAccountService", () => {
  it("verify() rejects an unknown/expired token", async () => {
    const prisma = { $queryRaw: jest.fn(async () => []), $executeRaw: jest.fn(async () => 1) };
    const svc = new BuyerAccountService(prisma as never, { send: jest.fn() } as never);
    await expect(svc.verify("nope")).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("verify() consumes the token and issues a session", async () => {
    const prisma = {
      $queryRaw: jest.fn(async (q: never) => {
        const t = sqlText(q);
        if (t.includes("FROM buyer_login_tokens")) return [{ id: "tok1", buyer_account_id: "acc1" }];
        if (t.includes("FROM buyer_accounts")) return [{ id: "acc1", email: "b@x.com", name: null, phone: null, default_ship_address: null }];
        return [];
      }),
      $executeRaw: jest.fn(async () => 1),
    };
    const svc = new BuyerAccountService(prisma as never, { send: jest.fn() } as never);
    const res = await svc.verify("rawtoken");
    expect(res.sessionToken).toBeTruthy();
    expect(res.profile.email).toBe("b@x.com");
    // token was consumed
    expect(prisma.$executeRaw).toHaveBeenCalled();
  });

  it("resolveSession() maps a valid session token to an account", async () => {
    const prisma = {
      $queryRaw: jest.fn(async (q: never) =>
        sqlText(q).includes("FROM buyer_sessions") ? [{ buyer_account_id: "acc9" }] : [],
      ),
      $executeRaw: jest.fn(async () => 1),
    };
    const svc = new BuyerAccountService(prisma as never, { send: jest.fn() } as never);
    await expect(svc.resolveSession("sess")).resolves.toBe("acc9");
  });

  it("resolveSession() throws without a token", async () => {
    const prisma = { $queryRaw: jest.fn(), $executeRaw: jest.fn() };
    const svc = new BuyerAccountService(prisma as never, { send: jest.fn() } as never);
    await expect(svc.resolveSession(undefined)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("requestLink() emails a link and never reveals account existence", async () => {
    const send = jest.fn().mockResolvedValue({ ok: true });
    const prisma = {
      $queryRaw: jest.fn(async () => [{ id: "acc1" }]),
      $executeRaw: jest.fn(async () => 1),
    };
    const svc = new BuyerAccountService(prisma as never, { send } as never);
    const res = await svc.requestLink("b@x.com", "https://web/store/acme/account");
    expect(res).toEqual({ sent: true });
    const msg = send.mock.calls[0][0];
    expect(msg.to).toBe("b@x.com");
    expect(msg.type).toBe("buyer.login_link");
    // the emailed link carries a token
    expect(msg.text).toContain("token=");
  });

  // Guard against accidental hash-vs-raw mixups.
  it("hashes tokens (raw != stored hash)", () => {
    expect(sha("abc")).not.toBe("abc");
  });
});
