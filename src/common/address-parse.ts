/**
 * address-parse.ts — deterministic free-text US address parser.
 *
 * Powers the "Paste a full address → Fill fields" shortcut on the new-
 * order form. Splits a single pasted string into structured fields.
 *
 * Why local (not Shippo)
 * ----------------------
 * Shippo has no reliable free-text parse endpoint, so the previous
 * implementation either called a non-existent path (live) or used a
 * naive comma-split stub that only handled "line1, city, state, zip"
 * — i.e. it failed on the *standard* format where the state and ZIP
 * share a comma segment ("San Francisco, CA 94103"). This parser
 * handles the common US layouts deterministically, with no network
 * dependency.
 *
 * Handled inputs (all case-insensitive; trailing "USA"/"US" tolerated):
 *   731 Market St #200, San Francisco, CA 94103
 *   731 Market St, Apt 4, San Francisco, CA 94103
 *   123 Main St, Raleigh, North Carolina 27601
 *   123 Main St, Raleigh, NC, 27601        (legacy each-field-own-part)
 *   500 Pine Ave, Seattle WA 98101         (city+state+zip in one part)
 *
 * Anything it can't confidently extract is left blank so the caller can
 * fill what it got and let the user complete the rest — never throws on
 * a merely messy address.
 */

export interface ParsedAddressParts {
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone: string | null;
}

const STATE_ABBRS = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID",
  "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS",
  "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK",
  "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV",
  "WI", "WY", "DC", "PR", "VI", "GU", "AS", "MP",
]);

const STATE_NAME_TO_ABBR: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR",
  california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE",
  florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL",
  indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI",
  minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT",
  nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC",
  "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
  vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV",
  wisconsin: "WI", wyoming: "WY", "district of columbia": "DC",
  "puerto rico": "PR",
};

const COUNTRY_TOKENS = new Set([
  "us", "usa", "united states", "united states of america",
]);

/** Returns the 2-letter state code for a token, or null if not a state. */
function toStateAbbr(token: string): string | null {
  const t = token.trim();
  if (!t) return null;
  const upper = t.toUpperCase();
  if (STATE_ABBRS.has(upper)) return upper;
  const name = t.toLowerCase();
  return STATE_NAME_TO_ABBR[name] ?? null;
}

/**
 * Parse a free-text US address into structured parts. Never throws;
 * returns blanks for anything not confidently extracted.
 */
export function parseUsAddress(raw: string): ParsedAddressParts {
  const country = "US";
  const empty: ParsedAddressParts = {
    line1: "",
    line2: null,
    city: "",
    state: "",
    postalCode: "",
    country,
    phone: null,
  };

  const trimmed = raw.trim();
  if (!trimmed) return empty;

  let parts = trimmed
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return empty;

  // Drop a trailing country token ("USA", "United States", …).
  {
    const last = parts[parts.length - 1]!.toLowerCase().replace(/\./g, "");
    if (COUNTRY_TOKENS.has(last)) parts = parts.slice(0, -1);
  }

  let postalCode = "";
  let state = "";

  // 1) Pull the ZIP off the end (5 digits or ZIP+4), searching the last part.
  if (parts.length > 0) {
    const last = parts[parts.length - 1]!;
    const zip = last.match(/(\d{5}(?:-\d{4})?)\s*$/);
    if (zip) {
      postalCode = zip[1]!;
      const remainder = last.slice(0, zip.index).trim();
      if (remainder) {
        parts[parts.length - 1] = remainder;
      } else {
        parts = parts.slice(0, -1); // ZIP occupied its own comma segment
      }
    }
  }

  // 2) Pull the STATE off the end. Try the whole trailing part first
  //    ("CA" / "California"), then the trailing 1–2 words of that part
  //    ("San Francisco CA", "Raleigh North Carolina").
  if (parts.length > 0) {
    const last = parts[parts.length - 1]!;
    const whole = toStateAbbr(last);
    if (whole) {
      state = whole;
      parts = parts.slice(0, -1);
    } else {
      const words = last.split(/\s+/);
      const two = words.length >= 2 ? toStateAbbr(words.slice(-2).join(" ")) : null;
      const one = toStateAbbr(words[words.length - 1]!);
      if (two) {
        state = two;
        const rest = words.slice(0, -2).join(" ").trim();
        if (rest) parts[parts.length - 1] = rest;
        else parts = parts.slice(0, -1);
      } else if (one) {
        state = one;
        const rest = words.slice(0, -1).join(" ").trim();
        if (rest) parts[parts.length - 1] = rest;
        else parts = parts.slice(0, -1);
      }
    }
  }

  // 3) City is the next trailing part.
  let city = "";
  if (parts.length > 0) {
    city = parts[parts.length - 1]!;
    parts = parts.slice(0, -1);
  }

  // 4) Whatever remains is line1 (+ line2 for the rest).
  let line1 = "";
  let line2: string | null = null;
  if (parts.length === 1) {
    line1 = parts[0]!;
  } else if (parts.length >= 2) {
    line1 = parts[0]!;
    line2 = parts.slice(1).join(", ");
  }

  // Graceful degrade: a bare string with no recognisable state/zip
  // (e.g. "731 Market St") lands entirely in `city` above — move it to
  // line1 so the most useful field gets populated.
  if (!line1 && !line2 && city && !state && !postalCode) {
    line1 = city;
    city = "";
  }

  return { line1, line2, city, state, postalCode, country, phone: null };
}
