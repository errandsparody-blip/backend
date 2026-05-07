# =============================================================================
# USA Errands — API Dockerfile.
#
# Multi-stage:
#   1. deps     — installs all node_modules (incl. devDeps + native bindings)
#   2. builder  — generates Prisma client, compiles `nest build` → ./dist
#   3. runner   — slim runtime with production node_modules + ./dist + ./prisma
#
# Native modules (argon2, @sentry/profiling-node, @prisma/engines) need
# python3/make/g++/openssl during install. Alpine works but Debian-slim is
# more compatible with Prisma's prebuilt engines, so we use node:20-slim.
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1 — deps. Installs every node_module including devDependencies.
# -----------------------------------------------------------------------------
FROM node:20-slim AS deps
WORKDIR /app

# Build tools for native modules + openssl for Prisma's query engine.
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

COPY package.json pnpm-lock.yaml ./
# .npmrc is optional; copied if present so registry / hoisting prefs apply.
COPY .npmrc* ./

RUN pnpm install --frozen-lockfile

# -----------------------------------------------------------------------------
# Stage 2 — builder. Generates Prisma client + compiles TypeScript.
# -----------------------------------------------------------------------------
FROM node:20-slim AS builder
WORKDIR /app

RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate Prisma client into node_modules/.prisma — required at runtime.
RUN pnpm prisma generate

# Compile TypeScript → dist/. nest build writes dist/main.js + dist/**.
RUN pnpm build

# -----------------------------------------------------------------------------
# Stage 3 — runner. Slim production image.
# -----------------------------------------------------------------------------
FROM node:20-slim AS runner
WORKDIR /app

# OpenSSL for Prisma at runtime; ca-certs for outbound HTTPS to Stripe / Sentry.
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --shell /bin/bash app

RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

ENV NODE_ENV=production

# Copy production-relevant artefacts only. We re-install deps in --prod mode
# to drop devDependencies — keeps the runtime image small.
COPY package.json pnpm-lock.yaml ./
COPY .npmrc* ./
RUN pnpm install --frozen-lockfile --prod

# The compiled application + the Prisma schema/migrations directory.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

# Generate the Prisma client in the runner stage. Doing this here (instead of
# COPY --from=builder /app/node_modules/.prisma) avoids a pnpm-specific issue:
# pnpm symlinks .prisma into its content-addressable store at a hashed path,
# and Docker COPY can't follow a symlink that points outside the source
# directory it's resolving. Running `prisma generate` in the prod-installed
# node_modules is fast (~5s) and produces a real, copyable directory.

# Generate the Prisma client now that prisma/ + node_modules are in place.
RUN pnpm prisma generate

# Drop privileges before exec.
RUN chown -R app:app /app
USER app

# Railway injects PORT; main.ts reads API_PORT which should be set to ${{PORT}}
# in the Railway service env vars. Default 4000 for local docker run.
EXPOSE 4000

# Apply pending migrations, then start the API. If the migration step fails,
# the container exits and Railway's restartPolicy kicks in (configured in
# railway.json).
CMD ["sh", "-c", "pnpm prisma migrate deploy && node dist/main.js"]
