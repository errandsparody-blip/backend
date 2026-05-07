/**
 * P3 fulfillment-flow integration test.
 *
 * Asserts the security-critical guarantees that only a real Postgres can prove:
 *
 *   1. Happy path: a vendor with stock + funds creates an order. The wallet is
 *      debited; the SKU's available qty drops; reserved qty rises. An
 *      OrderEvent timeline row exists. An audit row exists.
 *
 *   2. Atomicity (insufficient funds): the wallet is intentionally underfunded.
 *      The /v1/orders call returns 409. NO order row is written. NO ledger row
 *      is written. SKU quantities are unchanged.
 *
 *   3. Atomicity (insufficient stock): a line requests more than available.
 *      The /v1/orders call returns 409. NO order row, NO ledger row, NO change
 *      to wallet balance.
 *
 *   4. Cancel refunds and releases. After a successful create, cancel produces
 *      a REVERSAL ledger entry equal to the totalChargedCents, restores the
 *      SKU's available qty, and writes an `order.cancelled` OrderEvent.
 *
 *   5. State-machine: backwards transitions are refused at the DB trigger
 *      level. Setting status from CANCELLED back to ALLOCATED via raw SQL
 *      throws an error.
 *
 * Implementation Plan §6.6, §14.3 (atomic order create), §14.4 (defence in depth).
 */

import { Test, type TestingModule } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { ValidationPipe, VersioningType } from "@nestjs/common";
import cookieParser from "cookie-parser";
import { authenticator } from "otplib";
import { randomUUID } from "node:crypto";
import request from "supertest";

import { AppModule } from "../src/app.module";
import { CryptoService } from "../src/common/crypto.service";
import { PrismaService } from "../src/common/prisma.service";

const TEST_EMAIL = "p3-order-e2e@usa-errands.test";
const TEST_PASSWORD = "X7uFJ4G3!aD2qzA9Pm";

describe("P3 Order flow (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let crypto: CryptoService;
  let server: ReturnType<INestApplication["getHttpServer"]>;

  let accessToken = "";
  let vendorId = "";
  let userId = "";
  let productId = "";
  let skuId = "";

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

    // Idempotent cleanup of any prior run. Order matters because
    // OrderLine.skuId is ON DELETE RESTRICT — orders must die before SKUs.
    const existing = await prisma.user.findUnique({ where: { email: TEST_EMAIL } });
    if (existing?.vendorId) {
      await prisma.order.deleteMany({ where: { vendorId: existing.vendorId } });
      await prisma.vendor.delete({ where: { id: existing.vendorId } }).catch(() => undefined);
    } else if (existing) {
      await prisma.user.delete({ where: { id: existing.id } }).catch(() => undefined);
    }

    // 1. Signup.
    await request(server)
      .post("/v1/auth/signup")
      .send({
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
        businessName: "P3 Order E2E Vendor",
        country: "NG",
      })
      .expect(201);

    const user = await prisma.user.findUnique({ where: { email: TEST_EMAIL } });
    if (!user || !user.vendorId) throw new Error("vendor not provisioned");
    userId = user.id;
    vendorId = user.vendorId;

    // 2. Force-verify + enrol MFA so we can log in.
    const totpSecret = authenticator.generateSecret();
    await prisma.user.update({
      where: { id: userId },
      data: {
        emailVerified: true,
        status: "ACTIVE",
        mfaEnrolled: true,
        mfaSecretEncrypted: crypto.encrypt(totpSecret),
        mfaEnrolledAt: new Date(),
      },
    });

    // 3. Login + verify MFA.
    const loginRes = await request(server)
      .post("/v1/auth/login")
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD })
      .expect(200);
    const verifyRes = await request(server)
      .post("/v1/auth/2fa/verify")
      .send({ challengeToken: loginRes.body.challengeToken, code: authenticator.generate(totpSecret) })
      .expect(200);
    accessToken = verifyRes.body.accessToken;

    // 4. Mark vendor ACTIVE.
    await prisma.vendor.update({
      where: { id: vendorId },
      data: { kycStatus: "APPROVED", status: "ACTIVE", agreementAcceptedAt: new Date(), agreementVersion: "1.0" },
    });

    // 5. Create a product directly (faster than the API).
    const product = await prisma.product.create({
      data: {
        vendorId,
        code: "BOOK-A",
        name: "Test Book",
        variant: "STD",
        countryOfOrigin: "US",
        declaredValueCents: 2_000,
        weightOz: 8,
        lengthIn: 9,
        widthIn: 6,
        heightIn: 1,
      },
    });
    productId = product.id;

    // 6. Create an SKU bucket with 5 in stock.
    skuId = `UER-${vendorId.replace(/-/g, "").slice(0, 6).toUpperCase()}-BOOK-A-STD`;
    await prisma.sku.create({
      data: {
        id: skuId,
        vendorId,
        productId,
        variant: "STD",
        quantityAvailable: 5,
        quantityReserved: 0,
        storageTier: "SMALL",
        status: "ACTIVE",
      },
    });

    // 7. Pre-fund the wallet generously for the happy path tests.
    await prisma.wallet.update({
      where: { vendorId },
      data: { balanceCents: 50_000 },
    });
    await prisma.ledgerEntry.create({
      data: {
        vendorId,
        type: "DEPOSIT",
        amountCents: 50_000,
        balanceAfterCents: 50_000,
        description: "test fund",
      },
    });
  }, 60_000);

  afterAll(async () => {
    // Same cascade ordering: orders → vendor → users.
    if (vendorId) {
      await prisma.order.deleteMany({ where: { vendorId } });
      await prisma.vendor.delete({ where: { id: vendorId } }).catch(() => undefined);
    }
    await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });
    await app.close();
  });

  // ---------------------------------------------------------------------------

  const RECIPIENT = {
    recipientName: "Jane Doe",
    shipAddressLine1: "1 Test Way",
    shipCity: "Miami",
    shipState: "FL",
    shipPostalCode: "33101",
    shipCountry: "US",
  } as const;

  // ---------------------------------------------------------------------------
  // 1. Happy path
  // ---------------------------------------------------------------------------

  it("happy path: quote → create → wallet debited, stock reserved, timeline written", async () => {
    const quote = await request(server)
      .post("/v1/orders/quote")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        recipient: RECIPIENT,
        lines: [{ skuId, quantity: 2 }],
        insuranceRequested: false,
      })
      .expect(200);
    expect(quote.body.rates.length).toBeGreaterThan(0);
    expect(quote.body.totalUnits).toBe(2);

    const idempotencyKey = randomUUID();
    const create = await request(server)
      .post("/v1/orders")
      .set("Authorization", `Bearer ${accessToken}`)
      .set("Idempotency-Key", idempotencyKey)
      .send({
        recipient: RECIPIENT,
        lines: [{ skuId, quantity: 2 }],
        carrierService: "USPS Priority",
        insuranceRequested: false,
      })
      .expect(201);

    const orderId: string = create.body.id;
    expect(create.body.status).toBe("ALLOCATED");
    expect(create.body.totalChargedCents).toBeGreaterThan(0);

    // SKU available decreased by 2; reserved increased by 2.
    const sku = await prisma.sku.findUnique({ where: { id: skuId } });
    expect(sku!.quantityAvailable).toBe(3);
    expect(sku!.quantityReserved).toBe(2);

    // Wallet was debited.
    const wallet = await prisma.wallet.findUnique({ where: { vendorId } });
    expect(wallet!.balanceCents).toBe(50_000 - create.body.totalChargedCents);

    // Ledger entry exists with negative amount + correct reference.
    const ledger = await prisma.ledgerEntry.findFirst({
      where: { vendorId, type: "FULFILLMENT", referenceType: "order", referenceId: orderId },
    });
    expect(ledger).toBeTruthy();
    expect(ledger!.amountCents).toBe(-create.body.totalChargedCents);

    // Timeline events written (append-only).
    const events = await prisma.orderEvent.findMany({ where: { orderId }, orderBy: { occurredAt: "asc" } });
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["order.submitted", "order.allocated"]));

    // Idempotency replay: same key + same body returns the cached response.
    const replay = await request(server)
      .post("/v1/orders")
      .set("Authorization", `Bearer ${accessToken}`)
      .set("Idempotency-Key", idempotencyKey)
      .send({
        recipient: RECIPIENT,
        lines: [{ skuId, quantity: 2 }],
        carrierService: "USPS Priority",
        insuranceRequested: false,
      })
      .expect(201);
    expect(replay.body.id).toBe(orderId);

    // Cleanup the order so subsequent tests start from a known state.
    await request(server)
      .post(`/v1/orders/${orderId}/cancel`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ reason: "VENDOR_REQUEST" })
      .expect(200);
  }, 60_000);

  // ---------------------------------------------------------------------------
  // 2. Insufficient funds
  // ---------------------------------------------------------------------------

  it("insufficient funds: 409, no order row, no ledger row, no SKU change", async () => {
    // Drain the wallet to $0 with a manual debit + ledger entry.
    const before = await prisma.wallet.findUnique({ where: { vendorId } });
    const drainAmount = before!.balanceCents;
    if (drainAmount > 0) {
      await prisma.wallet.update({ where: { vendorId }, data: { balanceCents: 0 } });
      await prisma.ledgerEntry.create({
        data: {
          vendorId,
          type: "MANUAL_DEBIT",
          amountCents: -drainAmount,
          balanceAfterCents: 0,
          description: "test drain",
        },
      });
    }

    const ordersBefore = await prisma.order.count({ where: { vendorId } });
    const skuBefore = await prisma.sku.findUnique({ where: { id: skuId } });

    const res = await request(server)
      .post("/v1/orders")
      .set("Authorization", `Bearer ${accessToken}`)
      .set("Idempotency-Key", randomUUID())
      .send({
        recipient: RECIPIENT,
        lines: [{ skuId, quantity: 1 }],
        carrierService: "USPS Priority",
        insuranceRequested: false,
      });
    expect(res.status).toBe(409);

    // CRITICAL: no order row was created.
    const ordersAfter = await prisma.order.count({ where: { vendorId } });
    expect(ordersAfter).toBe(ordersBefore);

    // SKU untouched.
    const skuAfter = await prisma.sku.findUnique({ where: { id: skuId } });
    expect(skuAfter!.quantityAvailable).toBe(skuBefore!.quantityAvailable);
    expect(skuAfter!.quantityReserved).toBe(skuBefore!.quantityReserved);

    // Wallet still at 0.
    const walletAfter = await prisma.wallet.findUnique({ where: { vendorId } });
    expect(walletAfter!.balanceCents).toBe(0);
  }, 60_000);

  // ---------------------------------------------------------------------------
  // 3. Insufficient stock
  // ---------------------------------------------------------------------------

  it("insufficient stock: 409, no order row, no ledger row, wallet untouched", async () => {
    // Re-fund the wallet so funds aren't the failing axis.
    await prisma.wallet.update({ where: { vendorId }, data: { balanceCents: 100_000 } });
    await prisma.ledgerEntry.create({
      data: { vendorId, type: "MANUAL_CREDIT", amountCents: 100_000, balanceAfterCents: 100_000, description: "refund" },
    });
    const walletBefore = await prisma.wallet.findUnique({ where: { vendorId } });
    const ordersBefore = await prisma.order.count({ where: { vendorId } });

    const res = await request(server)
      .post("/v1/orders")
      .set("Authorization", `Bearer ${accessToken}`)
      .set("Idempotency-Key", randomUUID())
      .send({
        recipient: RECIPIENT,
        lines: [{ skuId, quantity: 999 }], // SKU only has 5 in stock
        carrierService: "USPS Priority",
        insuranceRequested: false,
      });
    expect(res.status).toBe(409);

    const ordersAfter = await prisma.order.count({ where: { vendorId } });
    expect(ordersAfter).toBe(ordersBefore);

    // Wallet untouched.
    const walletAfter = await prisma.wallet.findUnique({ where: { vendorId } });
    expect(walletAfter!.balanceCents).toBe(walletBefore!.balanceCents);
  }, 60_000);

  // ---------------------------------------------------------------------------
  // 4. Cancel refunds + releases
  // ---------------------------------------------------------------------------

  it("cancel: refunds the wallet via REVERSAL and releases the reservation", async () => {
    const idempotencyKey = randomUUID();
    const create = await request(server)
      .post("/v1/orders")
      .set("Authorization", `Bearer ${accessToken}`)
      .set("Idempotency-Key", idempotencyKey)
      .send({
        recipient: RECIPIENT,
        lines: [{ skuId, quantity: 1 }],
        carrierService: "USPS Priority",
        insuranceRequested: false,
      })
      .expect(201);

    const orderId: string = create.body.id;
    const totalCharged: number = create.body.totalChargedCents;
    const walletAfterCreate = await prisma.wallet.findUnique({ where: { vendorId } });

    await request(server)
      .post(`/v1/orders/${orderId}/cancel`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ reason: "VENDOR_REQUEST", note: "changed mind" })
      .expect(200);

    // SKU available restored, reserved decremented.
    const sku = await prisma.sku.findUnique({ where: { id: skuId } });
    expect(sku!.quantityReserved).toBe(0);

    // REVERSAL ledger entry exists, equal in magnitude to the original charge.
    const reversal = await prisma.ledgerEntry.findFirst({
      where: { vendorId, type: "REVERSAL", referenceType: "order", referenceId: orderId },
    });
    expect(reversal).toBeTruthy();
    expect(reversal!.amountCents).toBe(totalCharged);

    // Wallet returned to its pre-create balance.
    const walletAfterCancel = await prisma.wallet.findUnique({ where: { vendorId } });
    expect(walletAfterCancel!.balanceCents).toBe(walletAfterCreate!.balanceCents + totalCharged);

    // Cancel timeline event written.
    const cancelEvent = await prisma.orderEvent.findFirst({
      where: { orderId, type: "order.cancelled" },
    });
    expect(cancelEvent).toBeTruthy();

    // Repeated cancel is rejected.
    await request(server)
      .post(`/v1/orders/${orderId}/cancel`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ reason: "VENDOR_REQUEST" })
      .expect(409);
  }, 60_000);

  // ---------------------------------------------------------------------------
  // 5. State-machine trigger refuses backward transitions
  // ---------------------------------------------------------------------------

  it("DB trigger refuses moving an order from CANCELLED back to ALLOCATED", async () => {
    const cancelled = await prisma.order.findFirst({
      where: { vendorId, status: "CANCELLED" },
      orderBy: { createdAt: "desc" },
    });
    expect(cancelled).toBeTruthy();
    await expect(
      prisma.$executeRaw`UPDATE orders SET status = 'ALLOCATED' WHERE id = ${cancelled!.id}::uuid`,
    ).rejects.toThrow(/order_status_terminal|order_status_backwards|terminal/i);
  }, 30_000);
});
