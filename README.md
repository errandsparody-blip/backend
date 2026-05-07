# usa-errands-api

NestJS REST API for the USA Errands platform.

Companion projects (separate repos):

- `usa-errands-web` — Next.js 14 marketing + vendor + admin UI.

Source-of-truth documents (in `../`):

- PRD v1.3
- Implementation Plan v1.0
- Design System v1.0
- Cost Plan v1.0

## Stack

- Node.js 20+, TypeScript 5.6 (strict)
- NestJS 10
- Prisma + PostgreSQL 15+
- BullMQ + Redis (P2+)
- argon2id, JWT (HS256), TOTP (RFC 6238)
- Pino structured logs
- Helmet, throttler, cookie-parser
- Jest + Supertest
- OpenAPI / Swagger (dev only)

## Prerequisites

- Node.js >= 20.11
- pnpm or npm (pnpm preferred)
- PostgreSQL 15+ running locally (or Docker)
- Redis 7+ running locally (used in P2+, optional for P0)

## Setup

```bash
# 1. install
pnpm install

# 2. environment
cp .env.example .env
# Generate the three required secrets:
openssl rand -base64 64   # JWT_ACCESS_SECRET
openssl rand -base64 64   # JWT_REFRESH_SECRET
openssl rand -base64 32   # ENCRYPTION_MASTER_KEY (must be exactly 32 bytes)

# 3. database
createdb usaerrands
pnpm prisma:migrate:dev
pnpm prisma:generate

# 4. run dev
pnpm start:dev
```

## Scripts

| Command                  | What it does                                |
| ------------------------ | ------------------------------------------- |
| `pnpm start:dev`         | Watch mode with pino-pretty                 |
| `pnpm build`             | Compile TS to `dist/`                       |
| `pnpm start:prod`        | Run the built artifact                      |
| `pnpm typecheck`         | `tsc --noEmit`                              |
| `pnpm lint`              | ESLint with auto-fix                        |
| `pnpm test`              | Jest unit tests                             |
| `pnpm test:e2e`          | Jest e2e (Supertest)                        |
| `pnpm prisma:migrate:dev`| Create + apply migration locally            |
| `pnpm prisma:studio`     | Open Prisma Studio                          |

## Endpoints (P0)

| Endpoint                       | Auth        | Purpose                                |
| ------------------------------ | ----------- | -------------------------------------- |
| `GET  /v1/health`              | Public      | Health + DB ping                       |
| `POST /v1/auth/signup`         | Public      | Email/password signup                  |
| `GET  /v1/auth/verify-email`   | Public      | Email link verification                |
| `POST /v1/auth/login`          | Public      | Password verification → MFA challenge  |
| `POST /v1/auth/2fa/verify`     | Public      | TOTP code verification                 |
| `POST /v1/auth/2fa/recovery`   | Public      | Recovery-code verification             |
| `POST /v1/auth/2fa/enroll`     | Bearer JWT  | Begin TOTP enrollment                  |
| `POST /v1/auth/2fa/enroll/confirm` | Bearer JWT | Confirm TOTP + emit recovery codes  |
| `POST /v1/auth/refresh`        | Refresh cookie | Rotate refresh token + new access |
| `POST /v1/auth/logout`         | Refresh cookie | Revoke session                     |

Swagger UI: `http://localhost:4000/v1/docs` (development only).

## Security posture (Implementation Plan §4)

- argon2id passwords with HIBP banned-password check (P0.1)
- JWT access (15 min) + opaque refresh (30 days) with **token rotation and reuse detection**
- Mandatory TOTP MFA at first login; recovery codes hashed with argon2
- Refresh tokens stored as sha256 hashes; plaintext only in httpOnly + Secure + SameSite=Strict cookies
- Helmet defaults + strict CSP + HSTS preload
- CORS allowlist with credentials
- `@nestjs/throttler` rate limiting (5/min on /auth/* per IP)
- All vendor-scoped queries enforce vendor_id at the Prisma layer (P1+)
- `audit_log_entries` is append-only at the DB privilege level (migration `0002_audit_append_only`)
- AES-256-GCM field-level encryption for MFA secrets, KYC docs, banking metadata
- Pino redaction prevents auth fields, cookies, and secrets from ever reaching logs

## What's in P0

- Foundations only: auth + RBAC + audit + observability + security headers.
- **No vendor / inventory / wallet / orders code yet** — those land in P1, P2, P3.
- Prisma schema is intentionally minimal (`users`, `sessions`, `recovery_codes`, `audit_log_entries`, `configuration`).

## Running the audit-log append-only migration

After `pnpm prisma:migrate:dev` creates the base tables, the `0002_audit_append_only` migration applies the triggers:

```bash
pnpm prisma migrate dev --name audit_append_only
```

The migration enforces `RAISE EXCEPTION` on any UPDATE or DELETE against `audit_log_entries`. Test it with:

```sql
INSERT INTO audit_log_entries (id, action, resource_type) VALUES (gen_random_uuid(), 'test', 'test');
UPDATE audit_log_entries SET action = 'changed';
-- ERROR: audit_log_entries is append-only; UPDATE is forbidden
```

## Deployment

Railway. `start` runs the compiled `dist/main.js`. Migrations run automatically on deploy via `prisma migrate deploy`.

## Tests

Coverage thresholds (per Implementation Plan §16): ≥ 80% on `auth/`, `audit/`. CI blocks merge below threshold.
