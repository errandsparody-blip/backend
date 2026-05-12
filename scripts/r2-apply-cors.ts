/**
 * r2-apply-cors.ts — apply the CORS policy to the R2 attachments bucket.
 *
 * Why this script exists.
 * -----------------------
 * Personal Shopper attachment uploads go directly browser → R2 via
 * presigned PUT URLs (see `r2.service.ts`). The browser issues a CORS
 * preflight (OPTIONS) against the bucket host before the PUT, and R2 only
 * answers that preflight if the bucket itself has a CORS policy that
 * names the calling origin. Without it, every upload from production
 * fails with:
 *
 *   Access to fetch at 'https://<accountId>.r2.cloudflarestorage.com/...'
 *   from origin 'https://www.myusaerrands.com' has been blocked by CORS
 *   policy: Response to preflight request doesn't pass access control
 *   check: No 'Access-Control-Allow-Origin' header is present.
 *
 * R2 supports the S3-compatible `PUT /<bucket>?cors` API for this. This
 * script reads the same env vars the API uses, builds the allow-list
 * from `WEB_PUBLIC_URL` + `WEB_ALLOWED_ORIGINS`, and applies the policy.
 *
 * Usage.
 * ------
 *   pnpm ts-node scripts/r2-apply-cors.ts
 *
 * Or override the origin list directly (skips reading env):
 *   pnpm ts-node scripts/r2-apply-cors.ts --origins https://myusaerrands.com,https://www.myusaerrands.com
 *
 * Pass --dry-run to print the XML payload without sending it.
 *
 * Run once on initial setup AND any time the production origin changes
 * (new domain, preview-deploy host, etc.). Idempotent — re-applying with
 * the same origin set is a no-op from the bucket's perspective.
 */

import { loadConfig } from "../src/common/config";
import { R2Service } from "../src/modules/integrations/r2/r2.service";

interface Args {
  origins: string[];
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  let origins: string[] | null = null;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--origins") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error("--origins requires a value (comma-separated origins).");
      }
      origins = next.split(",").map((s) => s.trim()).filter(Boolean);
      i++;
    } else if (a.startsWith("--origins=")) {
      origins = a.slice("--origins=".length).split(",").map((s) => s.trim()).filter(Boolean);
    }
  }

  if (origins == null) {
    // Default: derive from env. `WEB_PUBLIC_URL` is the canonical origin
    // (typically https://www.myusaerrands.com); `WEB_ALLOWED_ORIGINS` is a
    // comma-separated list of additional origins (apex domain, staging,
    // localhost dev, etc.). We dedupe so the XML stays clean.
    const cfg = loadConfig();
    const fromEnv = new Set<string>();
    if (cfg.WEB_PUBLIC_URL) fromEnv.add(stripTrailingSlash(cfg.WEB_PUBLIC_URL));
    for (const extra of cfg.WEB_ALLOWED_ORIGINS ?? []) {
      fromEnv.add(stripTrailingSlash(extra));
    }
    origins = Array.from(fromEnv);
  }

  if (origins.length === 0) {
    throw new Error(
      "No origins resolved. Set WEB_PUBLIC_URL (+ optional WEB_ALLOWED_ORIGINS) or pass --origins.",
    );
  }

  for (const o of origins) {
    if (!/^https?:\/\/[^\s/]+$/.test(o)) {
      throw new Error(
        `Origin "${o}" doesn't look like a bare origin (https://example.com — no path, no trailing slash).`,
      );
    }
  }

  return { origins, dryRun };
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // eslint-disable-next-line no-console
  console.log("R2 CORS apply");
  // eslint-disable-next-line no-console
  console.log("  Origins:", args.origins.join(", "));
  // eslint-disable-next-line no-console
  console.log("  Methods: GET, HEAD, PUT");
  // eslint-disable-next-line no-console
  console.log("  Max age: 3600s");

  if (args.dryRun) {
    // eslint-disable-next-line no-console
    console.log("\n--dry-run set — not sending. (R2 config not loaded.)");
    return;
  }

  // R2Service constructor reads env via loadConfig() — no Nest container
  // needed since the service is a plain class. Done AFTER the dry-run
  // short-circuit so `--dry-run --origins ...` doesn't require a full
  // API env to print the plan.
  const r2 = new R2Service();
  if (!r2.isConfigured()) {
    throw new Error(
      "R2 isn't configured. Ensure R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, " +
        "R2_BUCKET, and R2_PUBLIC_BASE_URL are set in the environment.",
    );
  }

  await r2.setBucketCors({
    allowedOrigins: args.origins,
    allowedMethods: ["GET", "HEAD", "PUT"],
    maxAgeSeconds: 3600,
  });

  // eslint-disable-next-line no-console
  console.log("\nApplied successfully. Refresh the buyer thread page and retry uploading.");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Failed:", err instanceof Error ? err.message : err);
  if (err && typeof err === "object" && "response" in err) {
    // eslint-disable-next-line no-console
    console.error("Response:", (err as { response?: unknown }).response);
  }
  process.exit(1);
});
