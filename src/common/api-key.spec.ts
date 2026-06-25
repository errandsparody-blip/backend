/**
 * Pure-format tests for the storefront API-key codec. The parser is the first
 * gate in ApiKeyGuard, so anything malformed must come back as `null` (an
 * opaque auth failure) rather than a partial parse that could match a row.
 */

import {
  API_KEY_LIVE_PREFIX,
  apiKeyDisplayPrefix,
  formatApiKey,
  parseApiKey,
} from "./api-key";

const KEY_ID = "ab12cd34ef56ab78"; // 16 hex
const SECRET = "f".repeat(64); // 64 hex

describe("api-key format", () => {
  it("round-trips format → parse", () => {
    const raw = formatApiKey(KEY_ID, SECRET);
    expect(raw).toBe(`${API_KEY_LIVE_PREFIX}${KEY_ID}.${SECRET}`);
    expect(parseApiKey(raw)).toEqual({ keyId: KEY_ID, secret: SECRET });
  });

  it("trims surrounding whitespace (copy-paste safety)", () => {
    expect(parseApiKey(`  ${formatApiKey(KEY_ID, SECRET)}\n`)).toEqual({
      keyId: KEY_ID,
      secret: SECRET,
    });
  });

  it("displayPrefix omits the secret half", () => {
    expect(apiKeyDisplayPrefix(KEY_ID)).toBe(`${API_KEY_LIVE_PREFIX}${KEY_ID}`);
    expect(apiKeyDisplayPrefix(KEY_ID)).not.toContain(SECRET);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty", ""],
    ["wrong prefix", `uer_test_${KEY_ID}.${SECRET}`],
    ["no delimiter", `${API_KEY_LIVE_PREFIX}${KEY_ID}${SECRET}`],
    ["empty keyId", `${API_KEY_LIVE_PREFIX}.${SECRET}`],
    ["empty secret", `${API_KEY_LIVE_PREFIX}${KEY_ID}.`],
    ["non-hex keyId", `${API_KEY_LIVE_PREFIX}XYZ.${SECRET}`],
    ["non-hex secret", `${API_KEY_LIVE_PREFIX}${KEY_ID}.not-hex!`],
  ])("rejects %s → null", (_label, input) => {
    expect(parseApiKey(input as string | null | undefined)).toBeNull();
  });
});
