import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";

import { StorefrontService, STOREFRONT_SETUP_FEE_CENTS } from "./storefront.service";

// A Prisma.Sql-like object exposes `.strings` (literal chunks) + `.values`.
// The router matches on the joined literal text so we can return shaped rows.
function sqlText(q: { strings?: readonly string[]; sql?: string }): string {
  if (q.strings) return q.strings.join(" ");
  return String(q.sql ?? "");
}

interface State {
  product: {
    id: string;
    status: string;
    listed: boolean;
    retail_price_cents: number | null;
    category: string | null;
    tags: string[];
  } | null;
  vendor: {
    slug: string | null;
    storefront_enabled: boolean;
    storefront_fee_paid_at: Date | null;
    marketplace_featured: boolean;
  };
  storefront: { display_name: string } | null;
  payoutActive: boolean;
  slugTaken: boolean;
}

function makeService(state: State) {
  const executed: string[] = [];
  const debit = jest.fn().mockResolvedValue({ entry: {}, balanceAfterCents: 0 });

  const prisma = {
    $queryRaw: jest.fn(async (q: { strings?: readonly string[]; sql?: string }) => {
      const t = sqlText(q);
      if (t.includes("FROM products")) return state.product ? [state.product] : [];
      if (t.includes("SELECT id FROM vendors WHERE slug"))
        return state.slugTaken ? [{ id: "other" }] : [];
      if (t.includes("FROM vendors WHERE id")) return [state.vendor];
      if (t.includes("FROM vendor_storefronts")) return state.storefront ? [state.storefront] : [];
      if (t.includes("FROM vendor_payout_accounts"))
        return state.payoutActive ? [{ id: "pa1" }] : [];
      return [];
    }),
    $executeRaw: jest.fn(async (q: { strings?: readonly string[]; sql?: string }) => {
      executed.push(sqlText(q));
      return 1;
    }),
  };

  const service = new StorefrontService(
    prisma as never,
    { debit } as never,
    { list: async () => [], refresh: async () => undefined } as never,
  );
  return { service, executed, debit, prisma };
}

const VENDOR = "11111111-1111-1111-1111-111111111111";
const PRODUCT = "22222222-2222-2222-2222-222222222222";

function baseState(overrides: Partial<State> = {}): State {
  return {
    product: {
      id: PRODUCT,
      status: "ACTIVE",
      listed: false,
      retail_price_cents: null,
      category: null,
      tags: [],
    },
    vendor: {
      slug: "acme",
      storefront_enabled: false,
      storefront_fee_paid_at: null,
      marketplace_featured: false,
    },
    storefront: { display_name: "Acme" },
    payoutActive: true,
    slugTaken: false,
    ...overrides,
  };
}

describe("StorefrontService.setProductListing", () => {
  it("rejects listing a product with no retail price", async () => {
    const { service } = makeService(baseState());
    await expect(
      service.setProductListing(VENDOR, PRODUCT, { listed: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects listing a non-active product", async () => {
    const { service } = makeService(
      baseState({
        product: {
          id: PRODUCT,
          status: "ARCHIVED",
          listed: false,
          retail_price_cents: 2500,
          category: null,
          tags: [],
        },
      }),
    );
    await expect(
      service.setProductListing(VENDOR, PRODUCT, { listed: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("lists a product when a positive retail price is provided", async () => {
    const { service, executed } = makeService(baseState());
    const res = await service.setProductListing(VENDOR, PRODUCT, {
      listed: true,
      retailPriceCents: 4999,
      category: "Clothing",
      tags: ["ankara"],
    });
    expect(res.listed).toBe(true);
    expect(res.retailPriceCents).toBe(4999);
    expect(res.category).toBe("Clothing");
    expect(executed.some((s) => s.includes("UPDATE products"))).toBe(true);
  });

  it("404s an unknown product", async () => {
    const { service } = makeService(baseState({ product: null }));
    await expect(
      service.setProductListing(VENDOR, PRODUCT, { listed: false }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("StorefrontService.setSlug", () => {
  it("rejects a reserved slug", async () => {
    const { service } = makeService(baseState());
    await expect(service.setSlug(VENDOR, "admin")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects a taken slug", async () => {
    const { service } = makeService(baseState({ slugTaken: true }));
    await expect(service.setSlug(VENDOR, "taken")).rejects.toBeInstanceOf(ConflictException);
  });

  it("sets an available slug", async () => {
    const { service, executed } = makeService(baseState());
    await service.setSlug(VENDOR, "acme-shop");
    expect(executed.some((s) => s.includes("UPDATE vendors SET slug"))).toBe(true);
  });
});

describe("StorefrontService.enableStorefront", () => {
  it("blocks going live without an active payout account", async () => {
    const { service, debit } = makeService(baseState({ payoutActive: false }));
    await expect(service.enableStorefront(VENDOR, "actor")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(debit).not.toHaveBeenCalled();
  });

  it("blocks going live without a slug", async () => {
    const { service } = makeService(
      baseState({
        vendor: {
          slug: null,
          storefront_enabled: false,
          storefront_fee_paid_at: null,
          marketplace_featured: false,
        },
      }),
    );
    await expect(service.enableStorefront(VENDOR, "actor")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("charges the $50 fee once and enables the store", async () => {
    const { service, executed, debit } = makeService(baseState());
    await service.enableStorefront(VENDOR, "actor");
    expect(debit).toHaveBeenCalledTimes(1);
    expect(debit).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: STOREFRONT_SETUP_FEE_CENTS,
        type: "STOREFRONT_FEE",
        idempotencyKey: `storefront_fee:${VENDOR}`,
      }),
    );
    expect(executed.some((s) => s.includes("storefront_fee_paid_at = now()"))).toBe(true);
    expect(executed.some((s) => s.includes("storefront_enabled = true"))).toBe(true);
  });

  it("does not re-charge if the fee was already paid", async () => {
    const { service, debit } = makeService(
      baseState({
        vendor: {
          slug: "acme",
          storefront_enabled: false,
          storefront_fee_paid_at: new Date(),
          marketplace_featured: false,
        },
      }),
    );
    await service.enableStorefront(VENDOR, "actor");
    expect(debit).not.toHaveBeenCalled();
  });

  it("is a no-op when already enabled (no charge)", async () => {
    const { service, debit } = makeService(
      baseState({
        vendor: {
          slug: "acme",
          storefront_enabled: true,
          storefront_fee_paid_at: new Date(),
          marketplace_featured: false,
        },
      }),
    );
    await service.enableStorefront(VENDOR, "actor");
    expect(debit).not.toHaveBeenCalled();
  });
});
