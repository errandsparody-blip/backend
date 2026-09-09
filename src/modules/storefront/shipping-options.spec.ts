import type { ShippingRate } from "../integrations/shippo/shippo.service";

import { bucketRates } from "./shipping-options";

function rate(p: Partial<ShippingRate>): ShippingRate {
  return {
    rateId: "r",
    shipmentId: "s",
    carrier: "USPS",
    service: "svc",
    estimatedDeliveryDays: 4,
    costCents: 800,
    ...p,
  };
}

describe("bucketRates", () => {
  it("returns nothing when there are no rates", () => {
    expect(bucketRates([])).toEqual([]);
  });

  it("exposes only speed/window/price — never carrier", () => {
    const opts = bucketRates([rate({ service: "Ground", costCents: 800, estimatedDeliveryDays: 4 })]);
    expect(opts).toHaveLength(1);
    const o = opts[0]!;
    expect(o.speed).toBe("STANDARD");
    expect(o.deliveryWindow).toBe("3–5 business days");
    expect(o).not.toHaveProperty("carrier");
  });

  it("adds Express only when a strictly-faster rate exists", () => {
    const opts = bucketRates([
      rate({ service: "Ground", costCents: 800, estimatedDeliveryDays: 5 }),
      rate({ service: "Express", costCents: 2200, estimatedDeliveryDays: 2 }),
    ]);
    expect(opts.map((o) => o.speed)).toEqual(["STANDARD", "EXPRESS"]);
    expect(opts[0]!.costCents).toBe(800); // cheapest = standard
    expect(opts[1]!.costCents).toBe(2200); // fastest = express
    expect(opts[1]!.deliveryWindow).toBe("1–3 business days");
  });

  it("shows a single Standard option when the cheapest is also the fastest", () => {
    const opts = bucketRates([
      rate({ service: "Ground", costCents: 800, estimatedDeliveryDays: 2 }),
      rate({ service: "Pricey", costCents: 3000, estimatedDeliveryDays: 4 }),
    ]);
    expect(opts).toHaveLength(1);
    expect(opts[0]!.speed).toBe("STANDARD");
  });

  it("never returns more than two options", () => {
    const opts = bucketRates([
      rate({ service: "A", costCents: 700, estimatedDeliveryDays: 6 }),
      rate({ service: "B", costCents: 1200, estimatedDeliveryDays: 4 }),
      rate({ service: "C", costCents: 2500, estimatedDeliveryDays: 1 }),
    ]);
    expect(opts.length).toBeLessThanOrEqual(2);
  });
});
