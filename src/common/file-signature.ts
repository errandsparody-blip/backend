/**
 * Magic-byte file signature validator.
 *
 * Security audit L-2 — close the polyglot / MIME-confusion risk where a
 * client uploads a file whose declared Content-Type doesn't match the
 * actual file contents. Presigned R2 uploads pin Content-Type into the
 * signature (so a client can't swap it after the URL is issued), but
 * nothing currently verifies the bytes match the claimed type.
 *
 * Usage:
 *   const ok = await verifyFileSignature(url, ["image/jpeg", "image/png", "application/pdf"]);
 *   if (!ok) throw new BadRequestException({ code: "file_type_mismatch" });
 *
 * Implementation:
 *   - Fetches only the first 32 bytes via HTTP Range header (no
 *     bandwidth waste, works for any cloud storage that honors Range).
 *   - Matches against a small whitelist of known-good magic numbers.
 *   - Returns `true` only on a positive match against an expected MIME.
 *
 * This is NOT a replacement for AV scanning. It catches the common
 * polyglot / wrong-extension cases. For higher-assurance environments,
 * pair this with ClamAV or a SaaS scanner on the upload path.
 */

const RANGE_BYTES = 32; // First 32 bytes is enough for every signature in the table.

/**
 * Map of MIME type → list of magic-byte prefixes (as hex strings,
 * leading byte first). Multiple prefixes allowed when a format has
 * variants (e.g., JPEG with different application markers).
 */
const SIGNATURES: Record<string, string[]> = {
  "image/jpeg": ["ffd8ff"],
  "image/png": ["89504e470d0a1a0a"],
  "image/gif": ["474946383761", "474946383961"],
  "image/webp": ["52494646"], // "RIFF" — followed by ...WEBP at offset 8
  "image/heic": ["00000018667479706865696300", "0000001c66747970"],
  "application/pdf": ["255044462d"], // "%PDF-"
};

export interface VerifyOptions {
  /** Override the timeout for the Range fetch. Default 5s. */
  timeoutMs?: number;
  /**
   * For dev/test paths we sometimes want to skip the network call.
   * Pass an already-fetched Buffer to verify directly.
   */
  preFetchedBytes?: Buffer;
}

/**
 * Fetch the first N bytes of a URL via HTTP Range request and verify
 * they match one of the allowed MIME signatures. Returns true on
 * match, false on miss or any network error. Never throws — callers
 * decide how to surface a `false` result.
 */
export async function verifyFileSignature(
  url: string,
  allowedMimes: ReadonlyArray<string>,
  opts: VerifyOptions = {},
): Promise<boolean> {
  if (!url) return false;
  if (allowedMimes.length === 0) return false;

  let bytes: Buffer | null = null;
  if (opts.preFetchedBytes) {
    bytes = opts.preFetchedBytes;
  } else {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { Range: `bytes=0-${RANGE_BYTES - 1}` },
        signal: controller.signal,
      });
      if (!res.ok && res.status !== 206) return false;
      const buf = Buffer.from(await res.arrayBuffer());
      bytes = buf.subarray(0, RANGE_BYTES);
    } catch {
      // Network failure / abort / DNS — fail closed: signature unverifiable.
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  if (!bytes || bytes.length === 0) return false;
  const head = bytes.toString("hex").toLowerCase();

  for (const mime of allowedMimes) {
    const prefixes = SIGNATURES[mime];
    if (!prefixes) continue;
    if (prefixes.some((p) => head.startsWith(p.toLowerCase()))) {
      // image/webp needs an extra check: "RIFF....WEBP" — the WEBP
      // marker is at offset 8. Without this a generic RIFF (e.g. WAV)
      // would slip through.
      if (mime === "image/webp") {
        const off8 = bytes.subarray(8, 12).toString("ascii");
        if (off8 !== "WEBP") continue;
      }
      return true;
    }
  }
  return false;
}

/**
 * Convenience preset for image-only uploads (product photos, ID
 * documents, return evidence). Includes the common formats consumers
 * shoot on phones (JPEG, PNG, HEIC, WebP).
 */
export const IMAGE_MIMES: ReadonlyArray<string> = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
];

/**
 * Convenience preset for image-or-PDF uploads (wire-transfer proof,
 * shipping labels, business registration documents).
 */
export const IMAGE_OR_PDF_MIMES: ReadonlyArray<string> = [
  ...IMAGE_MIMES,
  "application/pdf",
];
