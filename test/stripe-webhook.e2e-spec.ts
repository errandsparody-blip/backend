/**
 * Stripe webhook integration test.
 *
 * Asserts:
 *   1. A signed payment_intent.succeeded webhook credits the wallet.
 *   2. Replaying the SAME event id is deduped (no second credit).
 *   3. A tampered or unsigned payload is rejected.
 *
 * Implementation Plan §6.5.1, §14.2.
 */

import { Test, type TestingModule } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { ValidationPipe, VersioningType } from "@nestjs/common";
import * as argon2 from "argon2";
import cookieParser from "cookie-parser";
import { createHmac } from "node:crypto";
import request from "supertest";

import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/common/prisma.service";

const TEST_EMAIL = "p2-stripe-e2e@usa-errands.test";
const TEST_PASSWORD = "X7uFJ4G3!aD2qzA9Pm";
const WEBHOOK_SECRET = "whsec_test_p2_e2e";

function signPayload(rawBody: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const signedPayload = `${timestamp}.${rawBody}`;
  const v1 = createHmac("sha256", secret).update(signedPayload).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

describe("Stripe webhook (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<INestApplication["getHttpServer"]>;
  let vendorId: string;

  beforeAll(async () => {
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "sk_test_dummy";

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ rawBody: true });
    app.use(cookieParser());
    app.enableVersioning({ type: VersioningType.URI });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    server = app.getHttpServer();
    prisma = app.get(PrismaService);

    // Idempotent cleanup + fresh vendor.
    await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });
    const vendor = await prisma.vendor.create({
      data: { businessName: "Stripe Webhook E2E", country: "NG" },
      select: { id: true },
    });
    vendorId = vendor.id;
    await prisma.wallet.create({ data: { vendorId } });
    await prisma.user.create({
      data: {
        email: TEST_EMAIL,
        passwordHash: await argon2.hash(TEST_PASSWORD),
        role: "VENDOR",
        vendorId,
        emailVerified: true,
        status: "ACTIVE",
      },
    });
  }, 30_000);

  afterAll(async () => {
    await prisma.webhookEvent.deleteMany({ where: { provider: "stripe" } });
    await prisma.ledgerEntry.deleteMany({ where: { vendorId } });
    await prisma.wallet.delete({ where: { vendorId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { vendorId } });
    await prisma.vendor.delete({ where: { id: vendorId } }).catch(() => undefined);
    await app.close();
  });

  it("signed payment_intent.succeeded credits the wallet exactly once", async () => {
    const eventId = `evt_test_${Date.now()}`;
    const intentId = `pi_test_${Date.now()}`;
    const event = {
      id: eventId,
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: intentId,
          object: "payment_intent",
          amount: 51470,
          currency: "usd",
          status: "succeeded",
          metadata: {
            vendorId,
            netAmountCents: "50000",
            processorFeeCents: "1470",
            purpose: "wallet.fund",
          },
        },
      },
    };
    const raw = JSON.stringify(event);
    const signature = signPayload(raw, WEBHOOK_SECRET);

    // First delivery — credits the wallet.
    await request(server)
      .post("/v1/webhooks/stripe")
      .set("Stripe-Signature", signature)
      .set("Content-Type", "application/json")
      .send(raw)
      .expect(200)
      .expect((r) => {
        expect(r.body.deduped).toBeUndefined();
      });

    const wallet = await prisma.wallet.findUnique({ where: { vendorId } });
    expect(wallet!.balanceCents).toBe(50000);

    const entries = await prisma.ledgerEntry.findMany({ where: { vendorId, type: "DEPOSIT" } });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.amountCents).toBe(50000);
    expect(entries[0]!.referenceId).toBe(intentId);

    // Second delivery (replay) with the SAME event id — deduped, no second credit.
    await request(server)
      .post("/v1/webhooks/stripe")
      .set("Stripe-Signature", signature)
      .set("Content-Type", "application/json")
      .send(raw)
      .expect(200)
      .expect((r) => {
        expect(r.body.deduped).toBe(true);
      });

    const walletAfterReplay = await prisma.wallet.findUnique({ where: { vendorId } });
    expect(walletAfterReplay!.balanceCents).toBe(50000); // unchanged
    const entriesAfter = await prisma.ledgerEntry.findMany({ where: { vendorId, type: "DEPOSIT" } });
    expect(entriesAfter).toHaveLength(1);
  }, 30_000);

  it("rejects an unsigned webhook", async () => {
    const event = {
      id: `evt_test_unsigned_${Date.now()}`,
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: `pi_test_unsigned_${Date.now()}`,
          metadata: { vendorId, netAmountCents: "1000", purpose: "wallet.fund" },
          status: "succeeded",
        },
      },
    };
    const raw = JSON.stringify(event);

    await request(server)
      .post("/v1/webhooks/stripe")
      .set("Content-Type", "application/json")
      .send(raw)
      .expect((res) => {
        // Not 200. Either 400 or 401 depending on the AllExceptionsFilter mapping;
        // the contract is "no wallet credit on unsigned payload."
        expect(res.status).not.toBe(200);
      });

    const balance = (await prisma.wallet.findUnique({ where: { vendorId } }))!.balanceCents;
    expect(balance).toBe(50000); // still the value from the first test
  }, 30_000);

  it("rejects a tampered payload (signature mismatch)", async () => {
    const event = {
      id: `evt_test_tamper_${Date.now()}`,
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: `pi_test_tamper_${Date.now()}`,
          metadata: { vendorId, netAmountCents: "999900", purpose: "wallet.fund" },
          status: "succeeded",
        },
      },
    };
    const raw = JSON.stringify(event);
    const wrongSecret = signPayload(raw, "whsec_wrong_secret");

    await request(server)
      .post("/v1/webhooks/stripe")
      .set("Stripe-Signature", wrongSecret)
      .set("Content-Type", "application/json")
      .send(raw)
      .expect((res) => expect(res.status).not.toBe(200));

    // Crucially: the inflated $9,999 amount NEVER lands on the ledger.
    const dump = await prisma.ledgerEntry.findMany({ where: { vendorId } });
    expect(dump.every((e) => e.amountCents !== 999900)).toBe(true);
  }, 30_000);
});
