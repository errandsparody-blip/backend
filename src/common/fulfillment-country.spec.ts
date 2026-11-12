import {
  fulfillmentCountryForShipTo,
  toFulfillmentCountry,
} from "./fulfillment-country";

describe("fulfillment-country helpers (migration 0077)", () => {
  it("maps a Canada destination to CA stock", () => {
    expect(fulfillmentCountryForShipTo("CA")).toBe("CA");
    expect(fulfillmentCountryForShipTo("ca")).toBe("CA");
  });

  it("maps the US (and anything else) to US stock", () => {
    expect(fulfillmentCountryForShipTo("US")).toBe("US");
    expect(fulfillmentCountryForShipTo("GB")).toBe("US");
  });

  it("defaults a missing destination to US", () => {
    expect(fulfillmentCountryForShipTo(null)).toBe("US");
    expect(fulfillmentCountryForShipTo(undefined)).toBe("US");
    expect(toFulfillmentCountry("")).toBe("US");
  });
});
