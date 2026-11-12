import { Role } from "@prisma/client";

import { AdminScopeService } from "./admin-scope.service";

// Role.ADMIN may be absent from the generated enum in some build envs
// (migration 0039). Reference it as a string constant, as the app does.
const ROLE_ADMIN = "ADMIN" as Role;

function makeService(opts: {
  adminCountry?: string | null;
  vendorIds?: string[];
}) {
  const queue: unknown[] = [];
  // resolve() for an ADMIN issues two raw queries in order:
  //   1. SELECT admin_country ...
  //   2. SELECT vendor_id FROM vendor_admin_assignments ...
  queue.push([{ admin_country: opts.adminCountry ?? null }]);
  queue.push((opts.vendorIds ?? []).map((v) => ({ vendor_id: v })));
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue({ id: "u1" }) },
    $queryRaw: jest.fn().mockImplementation(() => Promise.resolve(queue.shift())),
  };
  return new AdminScopeService(prisma as never);
}

describe("AdminScopeService.resolve", () => {
  it("leaves SUPER_ADMIN unrestricted", async () => {
    const svc = makeService({});
    const scope = await svc.resolve({ sub: "u1", role: Role.SUPER_ADMIN });
    expect(scope.restricted).toBe(false);
    expect(scope.vendorIds).toBeNull();
    expect(scope.country).toBeNull();
  });

  it("leaves legacy admin roles unrestricted", async () => {
    const svc = makeService({});
    const scope = await svc.resolve({ sub: "u1", role: Role.WAREHOUSE_OPERATOR });
    expect(scope.restricted).toBe(false);
  });

  it("restricts an ADMIN to their country and assigned vendors", async () => {
    const svc = makeService({ adminCountry: "CA", vendorIds: ["v1", "v2"] });
    const scope = await svc.resolve({ sub: "u1", role: ROLE_ADMIN });
    expect(scope.restricted).toBe(true);
    expect(scope.country).toBe("CA");
    expect(scope.vendorIds).toEqual(["v1", "v2"]);
  });

  it("denies an ADMIN with no country (empty vendor set, not a leak)", async () => {
    const svc = makeService({ adminCountry: null });
    const scope = await svc.resolve({ sub: "u1", role: ROLE_ADMIN });
    expect(scope.restricted).toBe(true);
    expect(scope.country).toBeNull();
    expect(scope.vendorIds).toEqual([]);
  });

  it("vendorWhere yields an impossible filter for an unassigned admin", async () => {
    const svc = makeService({ adminCountry: "US", vendorIds: [] });
    const where = await svc.vendorWhere({ sub: "u1", role: ROLE_ADMIN });
    expect(where).toEqual({ vendorId: { in: [] } });
  });
});
