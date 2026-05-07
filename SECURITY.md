# USA Errands API — Security Posture

This document records the security guarantees the codebase makes and the
self-audit run after P3 (Fulfillment) and P4 (polish + hardening). Use it as
the entry point for any external review.

---

## Threat model (v1)

USA Errands holds vendor money, vendor inventory, and shipping addresses for
end-customers. The headline attacker scenarios we defend against:

- **Cross-tenant access (IDOR).** Vendor A reading or mutating Vendor B's
  rows. Mitigation: explicit `vendorId` parameter on every vendor-scoped
  query, `TenantGuard` per vendor controller, IDOR test template at
  `src/modules/products/product.service.spec.ts`.
- **Money replay.** A re-sent order, deposit, or refund causing a
  double-charge. Mitigation: `Idempotency-Key` required on every money-moving
  endpoint; the key is hashed against the canonical request body and scoped
  to `(vendor, endpoint)` (`common/idempotency.service.ts`).
- **Money math poisoning.** A forged total/fees value sneaking past
  validation. Mitigation: server is authoritative on all fee math
  (`common/order-fees.ts`, `common/fees.ts`); the `orders_total_matches_components`
  CHECK constraint enforces shipping + fulfillment + insurance == total at
  the DB level.
- **Webhook forgery.** A signed-looking but tampered Stripe / KYC / EasyPost
  payload causing a wallet credit, KYC flip, or order status jump.
  Mitigation: HMAC verified on every webhook; replay-safe via
  `webhook_events` unique constraint; Stripe signature compared with
  `Stripe.webhooks.constructEvent`.
- **Token theft.** A leaked refresh token used by an attacker. Mitigation:
  refresh-token rotation with reuse detection — when a previously-rotated
  hash is presented, the entire user session family is revoked
  (`auth/token.service.ts` + `token.service.spec.ts`).
- **Privilege escalation.** A vendor user tampering with their JWT to claim
  admin role. Mitigation: JWTs signed with a 256-bit secret, `RolesGuard`
  enforced globally, role read from the verified JWT only.
- **PII exfiltration.** Customer addresses or vendor financials leaking via
  logs, error messages, or referrer headers. Mitigation: pino redact list,
  `EmailService` recipient redaction, `strict-origin-when-cross-origin`
  Referrer-Policy, single-origin CORS allowlist.
- **CSV / formula injection.** A vendor uploading a product name like
  `=cmd|...` that opens a shell when an admin opens the export in Excel.
  Mitigation: `common/csv.ts` defangs cells starting with `=`, `+`, `-`, `@`,
  `\t`, `\r` per the OWASP CSV-Injection cheat sheet.

---

## Audit pass — May 2026 (after P3 + P4 land)

### Authorization
- Every controller has been hand-checked. State-changing routes either have
  `@Roles(...)` + `@UseGuards(TenantGuard)` (vendor), `@Roles(<admin>)`
  (admin), or `@Public()` (webhooks, auth, health).
- The global `JwtAuthGuard` and `RolesGuard` are baseline; opt-out is
  explicit via `@Public()`.

### Tenant scoping (IDOR)
- Every vendor-scoped service uses `findFirst({ where: { id, vendorId } })`
  for single-row reads. Cross-tenant access returns 404 (never 403) so the
  service does not confirm existence to the wrong tenant.
- Raw `$queryRaw` against vendor-scoped tables (`wallets`, `skus`, `orders`)
  always includes `vendor_id = ${vendorId}::uuid`.
- The `enforce_order_line_tenant_match` DB trigger refuses any insert/update
  on `order_lines` that mismatches its parent order's `vendor_id`.

### Money-replay defence
- `POST /v1/wallet/fund/stripe` — Idempotency-Key required.
- `POST /v1/orders` — Idempotency-Key required.
- `POST /v1/admin/wallets/:vendorId/credit` — Idempotency-Key required.
- `POST /v1/psns/:id/submit` — Idempotency-Key required (added in P4.7).
- Order cancel relies on `SELECT … FOR UPDATE` inside the cancel transaction
  to prevent double-refund races; the status check is authoritative.

### Webhook surface
- **Stripe**: HMAC verified with `Stripe.webhooks.constructEvent` against the
  `STRIPE_WEBHOOK_SECRET`; dedup via `webhook_events.unique(provider, event_id)`;
  rate-limited to 600/min (P4.7).
- **KYC**: HMAC verified (when `KYC_WEBHOOK_SECRET` is set); rate-limited to
  600/min (P4.7).
- **EasyPost tracking**: HMAC verified (stub validator in v1; replace before
  production); rate-limited to 600/min; will not downgrade an order's status
  rank.

### Append-only invariants (DB-enforced)
- `audit_log_entries` (migration 0002): `RAISE EXCEPTION` on UPDATE/DELETE.
- `ledger_entries` (migration 0005): same trigger, plus a sign-consistency
  CHECK (`DEPOSIT > 0`, `ONBOARDING/STORAGE/etc < 0`, `REVERSAL` either).
- `order_events` (migration 0006): same trigger.

### State-machine guards
- `orders.status` transitions are validated by the
  `enforce_order_status_transition` DB trigger: forward-only, with
  `DELIVERED`/`CANCELLED`/`RETURNED` as terminal. Backwards moves throw at
  the database level even if the service layer is bypassed.

### Headers (helmet)
- CSP `defaultSrc 'self'`, `scriptSrc 'self'`, `frameAncestors 'none'`,
  `objectSrc 'none'`, `baseUri 'self'`. `styleSrc` allows `'unsafe-inline'`
  pending the CSS-in-JS migration; tracked.
- HSTS `max-age=63072000; includeSubDomains; preload`.
- Referrer-Policy `strict-origin-when-cross-origin` (P4.7 — was
  `no-referrer-when-downgrade`).
- CORS: single explicit origin (`WEB_PUBLIC_URL`), credentials allowed,
  fixed methods + allowed headers.

### Logging
- Pino redact paths cover `Authorization`, `Cookie`, `body.password`,
  `body.newPassword`, `body.code`, `body.recoveryCode`, `body.pendingSecret`.
- `EmailService` redacts the recipient email (`a***@example.com`) and never
  logs the API key.
- No service uses `console.log` for runtime telemetry.

### CSV / formula injection
- `common/csv.ts` quotes any field with `,`, `"`, `\r`, or `\n`, and prefixes
  any string starting with `=`, `+`, `-`, `@`, `\t`, `\r` with a single
  quote. `streamCsv` writes one row at a time — never accumulates the full
  file in memory.

---

## Known follow-ups

| ID | Severity | Description | Tracking |
|----|----------|-------------|----------|
| CSP-1 | low | Tighten `styleSrc` from `'unsafe-inline'` to nonce/hash | After web app migrates to a CSS-in-JS strategy with nonces |
| EP-1 | medium | EasyPost webhook stub returns `true` — wire real HMAC before production | P3.9 follow-up |
| Q-1 | low | Add Postgres connection-pool query timeout (current default = unlimited) | P4.7 hardening |
| OBS-1 | medium | Sentry DSN is wired but breadcrumb scrubbing not enabled | Pre-prod |

---

## How to run an external review

1. `pnpm install && pnpm prisma migrate deploy && pnpm prisma db seed`
2. `pnpm test` — runs the full unit suite incl. IDOR + wallet invariants.
3. `pnpm test:e2e` — requires Postgres + Redis; runs the full vendor flow,
   the Stripe webhook test, and the order-flow atomicity test.
4. `pnpm audit --production` — fails the build on any Critical CVE.
5. Run the CodeQL workflow locally: `gh workflow run codeql.yml`.

For a manual penetration test, the P3 atomicity contracts in
`test/order-flow.e2e-spec.ts` are the right starting point.
