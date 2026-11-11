/**
 * Country-aware recipient address validation (migration 0055 / Canada).
 *
 * Covers the superRefine on recipientAddressSchema: US and CA each have
 * their own valid state/province set and postal-code format, cross-country
 * combinations must fail, and unsupported countries are rejected outright.
 * Also verifies the label add-on flags default to false on createOrderSchema.
 */

import { createOrderSchema, recipientAddressSchema } from "./order.schema";

const baseAddress = {
  recipientName: "Jane Buyer",
  // Required — carriers refuse a shipment with no recipient phone.
  recipientPhone: "5125550142",
  shipAddressLine1: "123 Market St",
  shipCity: "Austin",
};

describe("recipientAddressSchema — country-aware validation", () => {
  it("accepts a valid US address", () => {
    const r = recipientAddressSchema.safeParse({
      ...baseAddress,
      shipState: "TX",
      shipPostalCode: "78701",
      shipCountry: "US",
    });
    expect(r.success).toBe(true);
  });

  it("accepts a valid Canadian address (province + A1A 1A1 postal)", () => {
    const r = recipientAddressSchema.safeParse({
      ...baseAddress,
      shipCity: "Toronto",
      shipState: "ON",
      shipPostalCode: "M5V 2T6",
      shipCountry: "CA",
    });
    expect(r.success).toBe(true);
  });

  it("accepts a Canadian postal without the interior space", () => {
    const r = recipientAddressSchema.safeParse({
      ...baseAddress,
      shipCity: "Toronto",
      shipState: "ON",
      shipPostalCode: "M5V2T6",
      shipCountry: "CA",
    });
    expect(r.success).toBe(true);
  });

  it("rejects a US ZIP on a Canadian address", () => {
    const r = recipientAddressSchema.safeParse({
      ...baseAddress,
      shipCity: "Toronto",
      shipState: "ON",
      shipPostalCode: "78701",
      shipCountry: "CA",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes("shipPostalCode"))).toBe(true);
    }
  });

  it("rejects a US state code on a Canadian address", () => {
    const r = recipientAddressSchema.safeParse({
      ...baseAddress,
      shipCity: "Toronto",
      shipState: "TX",
      shipPostalCode: "M5V 2T6",
      shipCountry: "CA",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes("shipState"))).toBe(true);
    }
  });

  it("rejects a Canadian postal on a US address", () => {
    const r = recipientAddressSchema.safeParse({
      ...baseAddress,
      shipState: "TX",
      shipPostalCode: "M5V 2T6",
      shipCountry: "US",
    });
    expect(r.success).toBe(false);
  });

  it("rejects an unsupported country", () => {
    const r = recipientAddressSchema.safeParse({
      ...baseAddress,
      shipState: "TX",
      shipPostalCode: "78701",
      shipCountry: "GB",
    });
    expect(r.success).toBe(false);
  });

  it("defaults country to US", () => {
    const r = recipientAddressSchema.safeParse({
      ...baseAddress,
      shipState: "TX",
      shipPostalCode: "78701",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.shipCountry).toBe("US");
  });

  it("requires a recipient phone", () => {
    const r = recipientAddressSchema.safeParse({
      recipientName: baseAddress.recipientName,
      shipAddressLine1: baseAddress.shipAddressLine1,
      shipCity: baseAddress.shipCity,
      shipState: "TX",
      shipPostalCode: "78701",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes("recipientPhone"))).toBe(true);
    }
  });

  it("rejects a placeholder phone", () => {
    const r = recipientAddressSchema.safeParse({
      ...baseAddress,
      recipientPhone: "1111111111",
      shipState: "TX",
      shipPostalCode: "78701",
    });
    expect(r.success).toBe(false);
  });

  it("normalises a formatted phone to digits", () => {
    const r = recipientAddressSchema.safeParse({
      ...baseAddress,
      recipientPhone: "(512) 555-0142",
      shipState: "TX",
      shipPostalCode: "78701",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.recipientPhone).toBe("5125550142");
  });
});

describe("createOrderSchema — label add-on defaults", () => {
  const validOrder = {
    recipient: {
      ...baseAddress,
      shipState: "TX",
      shipPostalCode: "78701",
      shipCountry: "US",
    },
    lines: [{ skuId: "UER-ABC-STD", quantity: 1 }],
  };

  it("defaults all add-on flags to false when omitted", () => {
    const r = createOrderSchema.safeParse(validOrder);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.insuranceRequested).toBe(false);
      expect(r.data.signatureRequired).toBe(false);
      expect(r.data.adultSignatureRequired).toBe(false);
      expect(r.data.fulfillmentMode).toBe("PLATFORM_SHIP");
    }
  });

  it("carries the requested add-on flags through", () => {
    const r = createOrderSchema.safeParse({
      ...validOrder,
      insuranceRequested: true,
      signatureRequired: true,
      adultSignatureRequired: true,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.insuranceRequested).toBe(true);
      expect(r.data.adultSignatureRequired).toBe(true);
    }
  });
});

describe("createOrderSchema — recipient requirements per fulfillment mode", () => {
  const lines = [{ skuId: "UER-ABC-STD", quantity: 1 }];

  it("PLATFORM_SHIP requires a full, valid address", () => {
    const r = createOrderSchema.safeParse({
      recipient: { recipientName: "Jane Buyer" }, // no address
      lines,
      fulfillmentMode: "PLATFORM_SHIP",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      // The strict re-validation surfaces issues under the recipient.* path.
      expect(
        r.error.issues.some((i) => i.path[0] === "recipient"),
      ).toBe(true);
    }
  });

  it("VENDOR_CARRIER accepts a name-only recipient when a label is supplied", () => {
    const r = createOrderSchema.safeParse({
      recipient: { recipientName: "Jane Buyer" }, // no shipping address
      lines,
      fulfillmentMode: "VENDOR_CARRIER",
      vendorCarrier: { vendorLabelUrl: "https://example.com/label.pdf" },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.recipient.recipientName).toBe("Jane Buyer");
      expect(r.data.recipient.shipAddressLine1).toBeUndefined();
    }
  });

  it("VENDOR_CARRIER still needs a label OR carrier+tracking", () => {
    const r = createOrderSchema.safeParse({
      recipient: { recipientName: "Jane Buyer" },
      lines,
      fulfillmentMode: "VENDOR_CARRIER",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes("vendorCarrier"))).toBe(true);
    }
  });

  it("VENDOR_CARRIER still requires at least a recipient name", () => {
    const r = createOrderSchema.safeParse({
      recipient: { recipientName: "" },
      lines,
      fulfillmentMode: "VENDOR_CARRIER",
      vendorCarrier: { vendorLabelUrl: "https://example.com/label.pdf" },
    });
    expect(r.success).toBe(false);
  });
});
