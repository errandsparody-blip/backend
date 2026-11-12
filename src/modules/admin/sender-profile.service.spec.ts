import { SenderProfileService } from "./sender-profile.service";

function profileRow(key: string, name: string) {
  return {
    key, label: key, name, phone: "+15555550100", email: "s@x.com",
    line1: "1 A St", line2: null, city: "Miami", state: "FL", postal_code: "33101", country: "US",
  };
}

function makeService(opts: { processingUserId?: string | null; profiles?: Record<string, unknown>[] }) {
  const queue: unknown[] = [
    [{ processing_user_id: opts.processingUserId ?? null }],
    opts.profiles ?? [],
  ];
  const prisma = {
    $queryRaw: jest.fn().mockImplementation(() => Promise.resolve(queue.shift() ?? [])),
  };
  return new SenderProfileService(prisma as never, { log: jest.fn() } as never);
}

describe("SenderProfileService.resolveForOrder (migration 0082)", () => {
  it("prefers the processing admin's profile over DEFAULT", async () => {
    const svc = makeService({
      processingUserId: "admin-1",
      profiles: [profileRow("admin-1", "Admin One"), profileRow("DEFAULT", "Default Sender")],
    });
    const r = await svc.resolveForOrder("00000000-0000-0000-0000-000000000001");
    expect(r?.name).toBe("Admin One");
    expect(r?.street1).toBe("1 A St");
  });

  it("falls back to DEFAULT when the admin has no profile", async () => {
    const svc = makeService({
      processingUserId: "admin-9",
      profiles: [profileRow("DEFAULT", "Default Sender")],
    });
    const r = await svc.resolveForOrder("00000000-0000-0000-0000-000000000001");
    expect(r?.name).toBe("Default Sender");
  });

  it("returns undefined (use env warehouse) when no profiles exist", async () => {
    const svc = makeService({ processingUserId: null, profiles: [] });
    const r = await svc.resolveForOrder("00000000-0000-0000-0000-000000000001");
    expect(r).toBeUndefined();
  });
});
