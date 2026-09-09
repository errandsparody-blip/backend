import { NotFoundException } from "@nestjs/common";

import { StorefrontPublicService } from "./storefront-public.service";

function makeService(rows: unknown[]) {
  const prisma = { $queryRaw: jest.fn().mockResolvedValue(rows) };
  return new StorefrontPublicService(prisma as never);
}

describe("StorefrontPublicService.resolveBySlug", () => {
  it("returns the storefront header for a live store", async () => {
    const svc = makeService([
      {
        vendor_id: "v1",
        slug: "acme",
        business_name: "Acme LLC",
        display_name: "Acme Store",
        logo_url: null,
        banner_url: null,
        accent_color: "#0F172A",
        about: "We sell things",
        currency: "USD",
      },
    ]);
    const res = await svc.resolveBySlug("ACME");
    expect(res.vendorId).toBe("v1");
    expect(res.displayName).toBe("Acme Store");
    expect(res.currency).toBe("USD");
  });

  it("falls back to business name when no display name is set", async () => {
    const svc = makeService([
      {
        vendor_id: "v1",
        slug: "acme",
        business_name: "Acme LLC",
        display_name: null,
        logo_url: null,
        banner_url: null,
        accent_color: null,
        about: null,
        currency: null,
      },
    ]);
    const res = await svc.resolveBySlug("acme");
    expect(res.displayName).toBe("Acme LLC");
    expect(res.currency).toBe("USD");
  });

  it("404s an unknown or disabled store", async () => {
    const svc = makeService([]);
    await expect(svc.resolveBySlug("nope")).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("StorefrontPublicService.listMarketplaceProducts", () => {
  it("maps rows including vendor slug + store name for the feed", async () => {
    const svc = makeService([
      {
        id: "p1",
        name: "Ankara Dress",
        category: "Clothing",
        tags: ["ankara"],
        retail_price_cents: 4999,
        image_url: null,
        available: 5,
        vendor_slug: "acme",
        store_name: "Acme Store",
      },
    ]);
    const res = await svc.listMarketplaceProducts({});
    expect(res[0]).toEqual(
      expect.objectContaining({
        id: "p1",
        retailPriceCents: 4999,
        vendorSlug: "acme",
        storeName: "Acme Store",
        available: 5,
      }),
    );
  });
});
