/**
 * integrationRecipientSchema — GB (UK) address support, plus a guard that US
 * behaviour is unchanged (2-letter state still required).
 */

import { integrationRecipientSchema } from "./integration.schema";

const base = {
  name: "Jane Doe",
  line1: "10 Downing Street",
  city: "London",
};

describe("integrationRecipientSchema — GB support", () => {
  it("accepts a GB address with no county and a valid UK postcode", () => {
    const r = integrationRecipientSchema.safeParse({
      ...base,
      postalCode: "sw1a 1aa",
      country: "gb",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.country).toBe("GB");
      expect(r.data.state).toBe(""); // county omitted → normalised to ""
      expect(r.data.postalCode).toBe("SW1A 1AA");
    }
  });

  it("rejects a GB address with a malformed postcode", () => {
    const r = integrationRecipientSchema.safeParse({
      ...base,
      postalCode: "12345",
      country: "GB",
    });
    expect(r.success).toBe(false);
  });

  it("still requires a 2-letter state for US (unchanged)", () => {
    const missing = integrationRecipientSchema.safeParse({
      ...base,
      city: "Austin",
      postalCode: "78701",
      country: "US",
    });
    expect(missing.success).toBe(false);

    const ok = integrationRecipientSchema.safeParse({
      ...base,
      city: "Austin",
      state: "TX",
      postalCode: "78701",
      country: "US",
    });
    expect(ok.success).toBe(true);
  });
});
