/**
 * P1 happy-path integration test.
 *
 * Walks: vendor signup → email verify → MFA enrollment → KYC webhook →
 *        agreement → product create → PSN draft → submit → operator receive →
 *        SKU exists with correct quantity → audit log entries present.
 *
 * Runs against a real Postgres via the same connection the API uses. Designed
 * to be invoked by `pnpm test:e2e` against an ephemeral database (CI service
 * containers). Idempotent: cleans up the user it creates between runs.
 *
 * Implementation Plan §15.2 acceptance criteria.
 */

import { Test, type TestingModule } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { ValidationPipe, VersioningType } from "@nestjs/common";
import * as argon2 from "argon2";
import cookieParser from "cookie-parser";
import { authenticator } from "otplib";
import request from "supertest";

import { AppModule } from "../src/app.module";
import { CryptoService } from "../src/common/crypto.service";
import { PrismaService } from "../src/common/prisma.service";

const TEST_EMAIL = "p1-e2e@usa-errands.test";
const TEST_PASSWORD = "X7uFJ4G3!aD2qzA9Pm";

describe("P1 happy path (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let crypto: CryptoService;
  let server: ReturnType<INestApplication["getHttpServer"]>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ rawBody: true });
    app.use(cookieParser());
    app.enableVersioning({ type: VersioningType.URI });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    server = app.getHttpServer();
    prisma = app.get(PrismaService);
    crypto = app.get(CryptoService);

    // Idempotent cleanup of any prior run.
    const existing = await prisma.user.findUnique({ where: { email: TEST_EMAIL } });
    if (existing) {
      if (existing.vendorId) await prisma.vendor.delete({ where: { id: existing.vendorId } }).catch(() => undefined);
      else await prisma.user.delete({ where: { id: existing.id } }).catch(() => undefined);
    }
  }, 30_000);

  afterAll(async () => {
    await app.close();
  });

  it("walks the full vendor flow end-to-end", async () => {
    // 1. Signup creates user + vendor in the same transaction.
    await request(server)
      .post("/v1/auth/signup")
      .send({
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
        businessName: "P1 E2E Vendor",
        country: "NG",
      })
      .expect(201);

    const user = await prisma.user.findUnique({ where: { email: TEST_EMAIL } });
    expect(user).toBeTruthy();
    expect(user!.vendorId).toBeTruthy();
    const vendorId = user!.vendorId!;

    // 2. Force-verify email + skip the mfa-challenge dance by stubbing the
    //    fields directly. The dance itself is covered by P0 unit tests.
    const totpSecret = authenticator.generateSecret();
    await prisma.user.update({
      where: { id: user!.id },
      data: {
        emailVerified: true,
        status: "ACTIVE",
        mfaEnrolled: true,
        mfaSecretEncrypted: crypto.encrypt(totpSecret),
        mfaEnrolledAt: new Date(),
      },
    });

    // 3. Login → MFA challenge → verify with the seeded TOTP.
    const login = await request(server)
      .post("/v1/auth/login")
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD })
      .expect(200);
    expect(login.body.status).toBe("mfa_required");
    const code = authenticator.generate(totpSecret);
    const verify = await request(server)
      .post("/v1/auth/2fa/verify")
      .send({ challengeToken: login.body.challengeToken, code })
      .expect(200);
    const accessToken: string = verify.body.accessToken;
    expect(accessToken).toBeTruthy();

    // 4. KYC webhook → vendor flips to APPROVED. Skip signature check (allowed in non-production).
    await request(server)
      .post("/v1/webhooks/kyc")
      .send({
        id: `evt_test_${Date.now()}`,
        type: "identity.verification_session.verified",
        data: {
          object: {
            id: `vs_test_${Date.now()}`,
            status: "verified",
            metadata: { vendorId },
          },
        },
      })
      .expect(200);

    let vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
    expect(vendor!.kycStatus).toBe("APPROVED");

    // 5. Accept the vendor agreement → vendor becomes ACTIVE.
    await request(server)
      .post("/v1/vendors/me/agreement")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ version: "1.0" })
      .expect(201);
    vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
    expect(vendor!.status).toBe("ACTIVE");

    // 6. Create a product.
    const productRes = await request(server)
      .post("/v1/products")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        code: "TSH-BLK-M",
        name: "T-shirt — Black, M",
        variant: "STD",
        countryOfOrigin: "NG",
        declaredValueCents: 1500,
        weightOz: 4,
        lengthIn: 12,
        widthIn: 9,
        heightIn: 1,
      })
      .expect(201);
    const productId: string = productRes.body.id;

    // 7. Create + submit a PSN.
    const psnRes = await request(server)
      .post("/v1/psns")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        carrier: "DHL",
        masterTracking: "TEST-TRACK-001",
        declaredBoxCounts: { SMALL: 1 },
        lines: [{ productId, declaredQty: 100 }],
      })
      .expect(201);
    const psnId: string = psnRes.body.id;
    const lineId: string = psnRes.body.lines[0].id;

    const submitted = await request(server)
      .post(`/v1/psns/${psnId}/submit`)
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(submitted.body.status).toBe("AWAITING_RECEIPT");
    expect(submitted.body.onboardingFeeCents).toBe(3400); // SMALL onboarding total

    // 8. Operator receives the PSN. Need an operator user for this — promote
    //    a temp admin via direct DB write so we don't take a dependency on
    //    invite flows that aren't built yet.
    const operatorEmail = "p1-operator@usa-errands.test";
    await prisma.user.deleteMany({ where: { email: operatorEmail } });
    const operator = await prisma.user.create({
      data: {
        email: operatorEmail,
        passwordHash: await argon2.hash(TEST_PASSWORD),
        role: "WAREHOUSE_OPERATOR",
        emailVerified: true,
        mfaEnrolled: true,
        mfaSecretEncrypted: crypto.encrypt(totpSecret),
        mfaEnrolledAt: new Date(),
        status: "ACTIVE",
      },
    });
    const oLogin = await request(server)
      .post("/v1/auth/login")
      .send({ email: operatorEmail, password: TEST_PASSWORD })
      .expect(200);
    const oVerify = await request(server)
      .post("/v1/auth/2fa/verify")
      .send({ challengeToken: oLogin.body.challengeToken, code: authenticator.generate(totpSecret) })
      .expect(200);
    const operatorToken: string = oVerify.body.accessToken;

    const received = await request(server)
      .post(`/v1/admin/psns/${psnId}/receive`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({
        lines: [{ lineId, acceptedQty: 100, damagedQty: 0 }],
      })
      .expect(200);
    expect(received.body.status).toBe("RECEIVED");

    // 9. The SKU bucket exists with the correct quantity.
    const skus = await prisma.sku.findMany({ where: { vendorId } });
    expect(skus).toHaveLength(1);
    expect(skus[0]!.quantityAvailable).toBe(100);
    expect(skus[0]!.id).toMatch(/^UER-/);

    const movements = await prisma.inventoryMovement.findMany({ where: { vendorId } });
    expect(movements).toHaveLength(1);
    expect(movements[0]!.type).toBe("RECEIVE");
    expect(movements[0]!.deltaAvailable).toBe(100);

    // 10. Audit log captured the high-signal events.
    const auditActions = await prisma.auditLogEntry
      .findMany({
        where: {
          actorId: { in: [user!.id, operator.id] },
          createdAt: { gte: new Date(Date.now() - 60_000) },
        },
        select: { action: true },
      })
      .then((rows) => rows.map((r) => r.action));
    for (const expected of ["auth.signup", "vendor.agreement_accepted", "product.created", "psn.created", "psn.submitted", "psn.received"]) {
      expect(auditActions).toContain(expected);
    }
  }, 60_000);
});
