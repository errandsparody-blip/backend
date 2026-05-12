/**
 * R2Service — Cloudflare R2 (S3-compatible) presigned uploads.
 *
 * Used for Personal Shopper attachment uploads. We presign on the server
 * with our long-lived R2 access keys; clients PUT the binary directly to
 * R2, then POST the public URL back to us as part of a chat message. This
 * keeps large file traffic OFF our API process (Railway doesn't love
 * sustained 25 MB uploads through Express).
 *
 * Why hand-roll SigV4 instead of pulling in `@aws-sdk/client-s3`?
 *   - The SDK is ~5 MB of dependencies for a single PUT URL signer.
 *   - SigV4 is a well-defined algorithm; ~100 lines does what we need.
 *   - Fewer deps = smaller attack surface in a security-sensitive module.
 *
 * The signer is implemented per the AWS spec:
 *   https://docs.aws.amazon.com/general/latest/gr/sigv4_signing.html
 *
 * R2 specifics:
 *   - Region is "auto" (case-sensitive in the credential scope).
 *   - Service is "s3".
 *   - Endpoint host is `<accountId>.r2.cloudflarestorage.com`.
 *   - Path-style addressing: `/<bucket>/<key>`.
 *   - Payload signing: "UNSIGNED-PAYLOAD" sentinel for browser PUTs.
 */

import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { createHash, createHmac, randomBytes } from "node:crypto";

import { loadConfig } from "../../../common/config";

const REGION = "auto";
const SERVICE = "s3";
const ALGORITHM = "AWS4-HMAC-SHA256";

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicBaseUrl: string;
}

export interface PresignPutArgs {
  /** Object key (must be URL-safe; service generates one if you don't). */
  key: string;
  /** MIME type the client will PUT with. Becomes a SignedHeader. */
  contentType: string;
  /** Optional cap in bytes — sent as a SignedHeader so the client can't lie. */
  contentLengthBytes?: number;
  /** Seconds until the URL expires. R2 accepts up to 7 days; we cap at 15 min. */
  expiresInSeconds?: number;
}

export interface PresignedUploadResult {
  /** PUT this URL with the binary body. */
  uploadUrl: string;
  /** Public URL to use after the upload completes. */
  publicUrl: string;
  /** Object key chosen / accepted. */
  key: string;
  /** Headers the client MUST include in the PUT (signed headers). */
  requiredHeaders: Record<string, string>;
  /** UNIX-seconds the URL stops being valid. */
  expiresAt: number;
}

export interface PutObjectArgs {
  /** Object key — generate via `generateKey` for hard-to-guess names. */
  key: string;
  /** MIME type. Bound into the signed request; client cannot change it. */
  contentType: string;
  /** Raw bytes to upload. UTF-8 strings are accepted via Buffer.from. */
  body: Buffer | string;
  /** Optional cache header for browsers; defaults to `public,max-age=31536000`. */
  cacheControl?: string;
}

export interface PutObjectResult {
  publicUrl: string;
  key: string;
}

@Injectable()
export class R2Service {
  private readonly logger = new Logger(R2Service.name);
  private readonly cfg: R2Config | null;

  constructor() {
    const c = loadConfig();
    if (
      !c.R2_ACCOUNT_ID ||
      !c.R2_ACCESS_KEY_ID ||
      !c.R2_SECRET_ACCESS_KEY ||
      !c.R2_BUCKET ||
      !c.R2_PUBLIC_BASE_URL
    ) {
      this.cfg = null;
      return;
    }
    this.cfg = {
      accountId: c.R2_ACCOUNT_ID,
      accessKeyId: c.R2_ACCESS_KEY_ID,
      secretAccessKey: c.R2_SECRET_ACCESS_KEY,
      bucket: c.R2_BUCKET,
      // Strip a trailing slash if the operator added one — composing
      // with `/${key}` later would produce //.
      publicBaseUrl: c.R2_PUBLIC_BASE_URL.replace(/\/+$/, ""),
    };
  }

  isConfigured(): boolean {
    return this.cfg !== null;
  }

  /**
   * Generate a fresh, hard-to-guess object key under a controlled prefix.
   * 16 bytes of entropy → ~2^128 keyspace; base64url-encoded for URL
   * safety; suffix preserves the original extension for `Content-Type`
   * sniffing on download.
   */
  generateKey(prefix: string, originalName: string): string {
    const random = randomBytes(16).toString("base64url");
    // Take only the extension; preserves "image/png" inference but doesn't
    // let an attacker influence the key path.
    const extMatch = /\.([a-zA-Z0-9]{1,8})$/.exec(originalName);
    const ext = extMatch ? `.${extMatch[1]!.toLowerCase()}` : "";
    const safePrefix = prefix.replace(/[^a-zA-Z0-9/_-]/g, "").replace(/^\/+|\/+$/g, "");
    return `${safePrefix}/${random}${ext}`;
  }

  /**
   * Direct server-side PUT — used when WE generate the bytes (e.g.,
   * server-rendered receipts) rather than handing a presigned URL to the
   * browser.
   *
   * SigV4 algorithm is identical to `presignPut` except payload signing:
   * we know the body, so we hash it and embed in the canonical request
   * (`x-amz-content-sha256`) instead of using the UNSIGNED-PAYLOAD
   * sentinel. R2 validates this matches.
   *
   * Failures throw `ServiceUnavailableException` with structured codes;
   * callers can choose to swallow them (receipt is best-effort).
   */
  async putObject(args: PutObjectArgs): Promise<PutObjectResult> {
    const cfg = this.requireConfig();

    const bodyBuf = Buffer.isBuffer(args.body) ? args.body : Buffer.from(args.body, "utf8");
    const payloadHash = sha256Hex(bodyBuf);

    const host = `${cfg.accountId}.r2.cloudflarestorage.com`;
    const canonicalPath =
      "/" + cfg.bucket.replace(/^\/+|\/+$/g, "") + "/" + encodePathSegment(args.key);

    const now = new Date();
    const amzDate = isoBasic(now);
    const dateStamp = amzDate.slice(0, 8);
    const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;

    const cacheControl = args.cacheControl ?? "public, max-age=31536000, immutable";

    // Headers we'll send AND sign. R2 requires Host + the content hash in
    // the SignedHeaders list when payload is signed.
    const headers: Record<string, string> = {
      host,
      "content-type": args.contentType,
      "content-length": String(bodyBuf.length),
      "cache-control": cacheControl,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };
    const signedHeaders = Object.keys(headers).sort().join(";");

    const canonicalHeaders =
      Object.keys(headers)
        .sort()
        .map((k) => `${k}:${headers[k]!.trim()}\n`)
        .join("");

    const canonicalRequest = [
      "PUT",
      canonicalPath,
      "", // no query string for direct PUT
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");

    const stringToSign = [
      ALGORITHM,
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join("\n");

    const signingKey = deriveSigningKey(cfg.secretAccessKey, dateStamp, REGION, SERVICE);
    const signature = hmacHex(signingKey, stringToSign);

    const authorization =
      `${ALGORITHM} Credential=${cfg.accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const url = `https://${host}${canonicalPath}`;

    // Use the global fetch (Node 20+ has it). No third-party HTTP client
    // needed; we keep R2 dependency surface to the standard library.
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": args.contentType,
        "Content-Length": String(bodyBuf.length),
        "Cache-Control": cacheControl,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
        Authorization: authorization,
      },
      body: bodyBuf,
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      this.logger.error(
        { status: res.status, errBody: errBody.slice(0, 500), key: args.key },
        "r2.putObject_failed",
      );
      throw new ServiceUnavailableException({
        message: "Couldn't store the file. Try again in a moment.",
        code: "r2_put_failed",
        status: res.status,
      });
    }

    return {
      publicUrl: `${cfg.publicBaseUrl}/${args.key}`,
      key: args.key,
    };
  }

  /**
   * Presign a single PUT for the given object key. Returns the URL, the
   * required headers (Content-Type + optional Content-Length), the public
   * URL the upload will live at, and the expiry.
   *
   * Throws ServiceUnavailableException with code `r2_not_configured` if
   * R2 isn't configured for this environment — controllers can surface
   * the structured error to the frontend.
   */
  presignPut(args: PresignPutArgs): PresignedUploadResult {
    const cfg = this.requireConfig();
    const expiresIn = Math.min(Math.max(args.expiresInSeconds ?? 600, 60), 900);

    const host = `${cfg.accountId}.r2.cloudflarestorage.com`;
    // R2 path-style addressing.
    const canonicalPath =
      "/" + cfg.bucket.replace(/^\/+|\/+$/g, "") + "/" + encodePathSegment(args.key);

    // Date format: ISO 8601 basic — YYYYMMDDTHHMMSSZ
    const now = new Date();
    const amzDate = isoBasic(now);
    const dateStamp = amzDate.slice(0, 8);
    const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;

    // Headers we sign. R2 (and S3) require Host. Content-Type binds the
    // upload's MIME so a malicious client can't swap to text/html and
    // serve XSS off our domain.
    const headers: Record<string, string> = {
      host,
      "content-type": args.contentType,
    };
    if (args.contentLengthBytes != null) {
      headers["content-length"] = String(args.contentLengthBytes);
    }
    const signedHeaders = Object.keys(headers).sort().join(";");

    // Query parameters in the presigned URL form.
    const queryParams: Array<[string, string]> = [
      ["X-Amz-Algorithm", ALGORITHM],
      ["X-Amz-Credential", `${cfg.accessKeyId}/${credentialScope}`],
      ["X-Amz-Date", amzDate],
      ["X-Amz-Expires", String(expiresIn)],
      ["X-Amz-SignedHeaders", signedHeaders],
    ];
    queryParams.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const canonicalQuery = queryParams
      .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)
      .join("&");

    const canonicalHeaders =
      Object.keys(headers)
        .sort()
        .map((k) => `${k}:${headers[k]!.trim()}\n`)
        .join("");

    const canonicalRequest = [
      "PUT",
      canonicalPath,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      "UNSIGNED-PAYLOAD",
    ].join("\n");

    const stringToSign = [
      ALGORITHM,
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join("\n");

    const signingKey = deriveSigningKey(cfg.secretAccessKey, dateStamp, REGION, SERVICE);
    const signature = hmacHex(signingKey, stringToSign);

    const uploadUrl =
      `https://${host}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;

    return {
      uploadUrl,
      publicUrl: `${cfg.publicBaseUrl}/${args.key}`,
      key: args.key,
      requiredHeaders: {
        "Content-Type": args.contentType,
        ...(args.contentLengthBytes != null
          ? { "Content-Length": String(args.contentLengthBytes) }
          : {}),
      },
      expiresAt: Math.floor(now.getTime() / 1000) + expiresIn,
    };
  }

  /**
   * Apply a CORS policy to the bucket. Browser PUTs from
   * `https://www.myusaerrands.com` (and any other origin the user reaches
   * the buyer thread from) trip a CORS preflight against the R2 host. R2
   * supports the S3-compatible `PUT /<bucket>?cors` API; this method sends
   * the XML payload signed with SigV4.
   *
   * Idempotent — re-running with the same origins is a no-op from the
   * bucket's perspective. Safe to wire into a deploy hook.
   *
   * @param allowedOrigins  Full origins, no trailing slash. e.g. ["https://myusaerrands.com", "https://www.myusaerrands.com"].
   * @param allowedMethods  Defaults to PUT + GET + HEAD — the only verbs the browser uploader uses.
   */
  async setBucketCors(args: {
    allowedOrigins: string[];
    allowedMethods?: ReadonlyArray<"GET" | "HEAD" | "PUT" | "POST" | "DELETE">;
    /** MaxAge for the preflight cache, in seconds. Default 1 hour. */
    maxAgeSeconds?: number;
  }): Promise<void> {
    const cfg = this.requireConfig();
    if (args.allowedOrigins.length === 0) {
      throw new ServiceUnavailableException({
        message: "At least one allowed origin is required.",
        code: "r2_cors_no_origins",
      });
    }

    const methods = args.allowedMethods ?? (["GET", "HEAD", "PUT"] as const);
    const maxAge = args.maxAgeSeconds ?? 3600;

    // S3 PutBucketCors XML payload. The values are user-controlled but
    // we only ever pass them from server config — still escape defensively
    // so a stray `<` in a host can't corrupt the body.
    const ruleXml = [
      "<CORSConfiguration>",
      "  <CORSRule>",
      ...args.allowedOrigins.map((o) => `    <AllowedOrigin>${xmlEscape(o)}</AllowedOrigin>`),
      ...methods.map((m) => `    <AllowedMethod>${m}</AllowedMethod>`),
      "    <AllowedHeader>*</AllowedHeader>",
      "    <ExposeHeader>ETag</ExposeHeader>",
      `    <MaxAgeSeconds>${maxAge}</MaxAgeSeconds>`,
      "  </CORSRule>",
      "</CORSConfiguration>",
    ].join("\n");

    const bodyBuf = Buffer.from(ruleXml, "utf8");
    // S3 requires `?cors` as the subresource query (no value, just the key).
    // The canonical request must include `cors=` as a query param even
    // though the URL syntax is just `?cors`.
    await this.signedSubresourcePut({
      cfg,
      // PutBucketCors targets the bucket itself, not an object inside it.
      objectPath: "/" + cfg.bucket.replace(/^\/+|\/+$/g, ""),
      subresource: "cors",
      contentType: "application/xml",
      // Cloudflare wants the MD5 of the body for PutBucketCors (it's
      // optional in S3, but R2 has been observed to require it). We send
      // both the SHA-256 (for SigV4) and the MD5 header.
      body: bodyBuf,
    });
  }

  /**
   * Internal helper: sign + execute a PUT against `<host>/<path>?<subresource>`
   * with an XML body. Used by `setBucketCors`; kept separate so future
   * S3-subresource calls (ACL, Lifecycle, etc.) reuse the SigV4 plumbing.
   */
  private async signedSubresourcePut(args: {
    cfg: R2Config;
    objectPath: string;
    subresource: string;
    contentType: string;
    body: Buffer;
  }): Promise<void> {
    const { cfg, objectPath, subresource, contentType, body } = args;

    const payloadHash = sha256Hex(body);
    const contentMd5 = createHash("md5").update(body).digest("base64");

    const host = `${cfg.accountId}.r2.cloudflarestorage.com`;
    const now = new Date();
    const amzDate = isoBasic(now);
    const dateStamp = amzDate.slice(0, 8);
    const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;

    const headers: Record<string, string> = {
      host,
      "content-type": contentType,
      "content-length": String(body.length),
      "content-md5": contentMd5,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };
    const signedHeaders = Object.keys(headers).sort().join(";");

    const canonicalHeaders =
      Object.keys(headers)
        .sort()
        .map((k) => `${k}:${headers[k]!.trim()}\n`)
        .join("");

    // Canonical query string: `cors=` (S3 spec — empty value, encoded `=`).
    const canonicalQuery = `${encodeRfc3986(subresource)}=`;

    const canonicalRequest = [
      "PUT",
      objectPath,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");

    const stringToSign = [
      ALGORITHM,
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join("\n");

    const signingKey = deriveSigningKey(cfg.secretAccessKey, dateStamp, REGION, SERVICE);
    const signature = hmacHex(signingKey, stringToSign);

    const authorization =
      `${ALGORITHM} Credential=${cfg.accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const url = `https://${host}${objectPath}?${subresource}`;

    const res = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(body.length),
        "Content-MD5": contentMd5,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
        Authorization: authorization,
      },
      body,
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      this.logger.error(
        { status: res.status, errBody: errBody.slice(0, 500), subresource },
        "r2.signedSubresourcePut_failed",
      );
      throw new ServiceUnavailableException({
        message: `R2 ${subresource} update failed (${res.status}).`,
        code: "r2_subresource_put_failed",
        status: res.status,
        body: errBody.slice(0, 500),
      });
    }
  }

  private requireConfig(): R2Config {
    if (!this.cfg) {
      throw new ServiceUnavailableException({
        message:
          "Attachment uploads are not configured for this environment. Contact support.",
        code: "r2_not_configured",
      });
    }
    return this.cfg;
  }
}

// ---------------------------------------------------------------------------
// SigV4 primitives — tiny pure helpers (kept out of the class so they can be
// unit-tested without instantiating Nest providers).
// ---------------------------------------------------------------------------

function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function hmacHex(key: Buffer, data: string): string {
  return createHmac("sha256", key).update(data).digest("hex");
}

function deriveSigningKey(secret: string, date: string, region: string, service: string): Buffer {
  const kDate = hmac("AWS4" + secret, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

/**
 * RFC 3986 percent-encoding for query string values. Notably, AWS spec
 * requires '~' to be left unencoded — the default encodeURIComponent
 * already handles this, but the spec is explicit so we re-document.
 */
function encodeRfc3986(s: string): string {
  return encodeURIComponent(s).replace(
    /[!*'()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Path encoding for S3 keys: encode each segment but preserve '/'. The
 * additional '*' encoding matches the AWS reference implementation.
 */
function encodePathSegment(key: string): string {
  return key
    .split("/")
    .map((seg) =>
      encodeURIComponent(seg).replace(
        /[!*'()]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
}

function isoBasic(d: Date): string {
  // YYYYMMDDTHHMMSSZ — matches `new Date().toISOString().replace(/[-:]|\.\d+/g, "")`.
  return d.toISOString().replace(/[-:]|\.\d+/g, "");
}

/**
 * Minimal XML escaper for the values that go into the CORS payload. We
 * never put unsanitised user input here — origins come from env vars —
 * but defensive escaping costs nothing and prevents accidental payload
 * corruption if a config value ever contains an angle bracket.
 */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
