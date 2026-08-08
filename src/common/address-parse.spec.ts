import { parseUsAddress } from "./address-parse";

describe("parseUsAddress", () => {
  it("parses the standard 'line1, City, ST ZIP' layout (previously broken)", () => {
    expect(parseUsAddress("731 Market St #200, San Francisco, CA 94103")).toEqual({
      line1: "731 Market St #200",
      line2: null,
      city: "San Francisco",
      state: "CA",
      postalCode: "94103",
      country: "US",
      phone: null,
    });
  });

  it("captures a line2 when present", () => {
    expect(
      parseUsAddress("731 Market St, Apt 4, San Francisco, CA 94103"),
    ).toEqual({
      line1: "731 Market St",
      line2: "Apt 4",
      city: "San Francisco",
      state: "CA",
      postalCode: "94103",
      country: "US",
      phone: null,
    });
  });

  it("handles a full state name", () => {
    const r = parseUsAddress("123 Main St, Raleigh, North Carolina 27601");
    expect(r.line1).toBe("123 Main St");
    expect(r.city).toBe("Raleigh");
    expect(r.state).toBe("NC");
    expect(r.postalCode).toBe("27601");
  });

  it("handles the legacy each-field-own-segment layout", () => {
    const r = parseUsAddress("123 Main St, Raleigh, NC, 27601");
    expect(r.line1).toBe("123 Main St");
    expect(r.city).toBe("Raleigh");
    expect(r.state).toBe("NC");
    expect(r.postalCode).toBe("27601");
  });

  it("handles city+state+zip sharing one segment", () => {
    const r = parseUsAddress("500 Pine Ave, Seattle WA 98101");
    expect(r.line1).toBe("500 Pine Ave");
    expect(r.city).toBe("Seattle");
    expect(r.state).toBe("WA");
    expect(r.postalCode).toBe("98101");
  });

  it("tolerates a trailing country token and ZIP+4", () => {
    const r = parseUsAddress("1 Infinite Loop, Cupertino, CA 95014-2083, USA");
    expect(r.line1).toBe("1 Infinite Loop");
    expect(r.city).toBe("Cupertino");
    expect(r.state).toBe("CA");
    expect(r.postalCode).toBe("95014-2083");
    expect(r.country).toBe("US");
  });

  it("degrades gracefully for a bare street with no city/state/zip", () => {
    const r = parseUsAddress("731 Market St");
    expect(r.line1).toBe("731 Market St");
    expect(r.city).toBe("");
    expect(r.state).toBe("");
    expect(r.postalCode).toBe("");
  });

  it("parses a multi-line paste with the state on its own line (reported case)", () => {
    const pasted = "2201 Tucker lane \nApt B8\nGwynn oak \nMaryland \n21207";
    expect(parseUsAddress(pasted)).toEqual({
      line1: "2201 Tucker lane",
      line2: "Apt B8",
      city: "Gwynn oak",
      state: "MD",
      postalCode: "21207",
      country: "US",
      phone: null,
    });
  });

  it("parses a multi-line paste with 'City, ST ZIP' on the last line", () => {
    const r = parseUsAddress("2201 Tucker Lane\nApt B8\nGwynn Oak, MD 21207");
    expect(r.line1).toBe("2201 Tucker Lane");
    expect(r.line2).toBe("Apt B8");
    expect(r.city).toBe("Gwynn Oak");
    expect(r.state).toBe("MD");
    expect(r.postalCode).toBe("21207");
  });

  it("returns all-blank for empty input", () => {
    expect(parseUsAddress("   ")).toEqual({
      line1: "",
      line2: null,
      city: "",
      state: "",
      postalCode: "",
      country: "US",
      phone: null,
    });
  });
});
