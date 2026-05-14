# =============================================================================
# USA Errands — API Dockerfile.
#
# Two-stage build:
#   1. builder — installs all deps, generates Prisma client, compiles to dist.
#                Everything happens in one stage so node_modules NEVER crosses
#                a `COPY --from`. pnpm uses symlinked content-addressable
#                node_modules; copying that across stages corrupts the symlink
#                graph and leaves Prisma's typed client in a half-broken state.
#   2. runner  — slim runtime. Re-installs prod deps from scratch (so its
#                node_modules is fresh and its symlinks are intact), copies
#                the compiled dist + prisma directories.
#
# Native modules (argon2, @sentry/profiling-node, @prisma/engines) need
# python3/make/g++/openssl during install. Debian-slim is more compatible
# with Prisma's prebuilt engines than Alpine, so we use node:20-slim.
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1 — builder. All dev deps + Prisma generate + nest build.
# -----------------------------------------------------------------------------
FROM node:20-slim AS builder
WORKDIR /app

# Build tools for native modules + openssl for Prisma's query engine.
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

# Copy package.json + lockfile + prisma BEFORE running install. The
# @prisma/client package has a postinstall hook that runs `prisma generate`
# against schema.prisma — without the schema present, that hook generates
# either a stub or nothing at all, and the typed client is missing fields.
COPY package.json pnpm-lock.yaml ./
COPY .npmrc* ./
COPY prisma ./prisma

# Diagnostic — surface the schema's relevant fields in the build log so we
# can immediately see whether the schema in the image matches what's on
# main. If these greps print nothing, the repo at this commit doesn't have
# the social-handles changes and the typed client cannot include them.
RUN echo "=== schema.prisma diagnostic ===" \
  && grep -E "instagram_handle|tiktok_handle|x_handle|website_url|social_verified_at|kyc_rejection_reason" prisma/schema.prisma || echo "MISSING — schema does not include social-handle fields" \
  && echo "================================"

RUN pnpm install --frozen-lockfile

# Now copy the rest of the source. This keeps the Docker layer cache hot for
# install when only application code changes.
COPY . .

# Belt-and-braces regenerate. If schema.prisma changed between the cached
# install layer and this point, this pulls the latest. Output is pinned by
# `output = "../node_modules/.prisma/client"` in schema.prisma so it lands
# in a stable, hoisted path regardless of pnpm's symlink layout.
RUN pnpm prisma generate

# Compile TypeScript → dist/. nest build writes dist/main.js + dist/**.
RUN pnpm build

# -----------------------------------------------------------------------------
# Stage 2 — runner. Slim production image with fresh prod-only node_modules.
# -----------------------------------------------------------------------------
FROM node:20-slim AS runner
WORKDIR /app

# OpenSSL for Prisma at runtime; ca-certs for outbound HTTPS to Stripe / Sentry.
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --shell /bin/bash app

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

ENV NODE_ENV=production

# Re-install in --prod mode so devDependencies are dropped and the symlink
# graph is built fresh inside this stage. Schema is in place before install
# so the @prisma/client postinstall hook generates a real typed client.
COPY package.json pnpm-lock.yaml ./
COPY .npmrc* ./
COPY --from=builder /app/prisma ./prisma
RUN pnpm install --frozen-lockfile --prod

# The compiled application.
COPY --from=builder /app/dist ./dist

# Static assets bundled at runtime — currently the marketing pricing-guide
# PDF, served as an email attachment via PricingGuideService. The service
# resolves `process.cwd()/assets/...`, which is `/app/assets/...` in this
# container. Without this COPY the email send would fail with
# `pricing_guide.pdf_missing` on every request.
COPY --from=builder /app/assets ./assets

# Belt-and-braces regenerate. Postinstall handled it above; this is just
# insurance against any caching surprises.
RUN pnpm prisma generate

# Drop privileges before exec.
RUN chown -R app:app /app
USER app

# Railway injects PORT; main.ts reads PORT first then falls back to API_PORT.
EXPOSE 4000

# Apply pending migrations, then start the API. If the migration step fails,
# the container exits and Railway's restartPolicy kicks in (configured in
# railway.json).
#
# The first step (`prisma db execute --file recover-failed-0019.sql`) is a
# one-time self-heal for the 0019_unified_ledger migration that originally
# failed with "unsafe use of new enum value" (SQLSTATE 55P04). The SQL
# inside deletes only the failed (unfinished) row from `_prisma_migrations`,
# leaving the rest of the migration history intact. After it runs, Prisma
# re-applies 0019 cleanly. The file is idempotent — once the failed row is
# gone, the DELETE is a no-op on every subsequent boot, so it's safe to
# leave in the deploy chain forever.
CMD ["sh", "-c", "pnpm prisma db execute --schema prisma/schema.prisma --file prisma/recover-failed-0019.sql && pnpm prisma migrate deploy && node dist/main.js"]
