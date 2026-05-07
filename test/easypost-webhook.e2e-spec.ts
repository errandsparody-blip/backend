/**
 * EasyPost webhook integration test (P5.5).
 *
 * Asserts:
 *   1. Signed `tracker` event with a status of "delivered" updates the order
 *      to DELIVERED + writes a CARRIER OrderEvent.
 *   2. Replaying the SAME event id is deduped via `webhook_events`
 *      unique(provider, event_id) — second call returns deduped:true,
 *      no extra OrderEvent.
 *   3. Unsigned payload is rejected (no order change, no event row).
 *   4. Tampered signature (correct shape, wrong digest) is rejected.
 *
 * The contract: a forged tracking event cannot transition an order's status.
 *
 * Implementation Plan §6.6.3, §14.4 (defence in depth).
 */

import { Test, type TestingModule } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { ValidationPipe, VersioningType } from "@nestjs/common";
import * as argon2 from "argon2";
import cookieParser from "cookie-parser";
import { createHmac, randomUUID } from "node:crypto";
import request from "supertest";

import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/common/prisma.service";

const TEST_EMAIL = "p5-easypost-e2e@usa-errands.test";
const TEST_PASSWORD = "X7uFJ4G3!aD2qzA9Pm";
const WEBHOOK_SECRET = "ep_test_webhook_secret_v1";

function signBody(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

describe("EasyPost webhook (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<INestApplication["getHttpServer"]>;
  let vendorId: string;
  let orderId: string;
  const trackingNumber = `9400${Date.now()}`;

  beforeAll(async () => {
    process.env.EASYPOST_WEBHOOK_SECRET = WEBHOOK_SECRET;

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

    // Idempotent cleanup.
    await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });
    const vendor = await prisma.vendor.create({
      data: {
        businessName: "EasyPost Webhook E2E",
        country: "NG",
        kycStatus: "APPROVED",
        status: "ACTIVE",
      },
      select: { id: true },
    });
    vendorId = vendor.id;
    await prisma.wallet.create({ data: { vendorId, balanceCents: 100_000 } });
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

    // Seed an order that's already SHIPPED so the next forward step
    // (IN_TRANSIT / DELIVERED) is the relevant transition.
    const product = await prisma.product.create({
      data: {
        vendorId,
        code: "BOOK-WH",
        name: "Webhook Test Book",
        variant: "STD",
        countryOfOrigin: "US",
        declaredValueCents: 1_500,
        weightOz: 8,
        lengthIn: 9,
        widthIn: 6,
        heightIn: 1,
      },
    });
    const skuId = `UER-${vendorId.replace(/-/g, "").slice(0, 6).toUpperCase()}-BOOK-WH-STD`;
    await prisma.sku.create({
      data: {
        id: skuId,
        vendorId,
        productId: product.id,
        variant: "STD",
        quantityAvailable: 5,
        quantityReserved: 0,
        storageTier: "SMALL",
        status: "ACTIVE",
      },
    });
    const order = await prisma.order.create({
      data: {
        vendorId,
        status: "SHIPPED",
        recipientName: "Jane Test",
        shipAddressLine1: "1 Test Way",
        shipCity: "Miami",
        shipState: "FL",
        shipPostalCode: "33101",
        shipCountry: "US",
        addressValidationStatus: "ACCEPTED",
        carrier: "USPS",
        carrierService: "USPS Priority",
        trackingNumber,
        labelUrl: "https://stub/label.pdf",
        rateProviderRef: "shp_e2e",
        ratePurchasedRef: "rate_e2e",
        itemsDeclaredValueCents: 1_500,
        shippingCostCents: 800,
        shippingFeeCents: 880,
        fulfillmentFeeCents: 250,
        insuranceFeeCents: 0,
        totalChargedCents: 1_130,
        submittedAt: new Date(),
        allocatedAt: new Date(),
        shippedAt: new Date(),
        lines: {
          create: [
            {
              vendorId,
              productId: product.id,
              skuId,
              productCode: product.code,
              productName: product.name,
              variant: "STD",
              quantity: 1,
              declaredValueCents: 1_500,
              allocationStatus: "SHIPPED",
            },
          ],
        },
      },
    });
    orderId = order.id;
  }, 60_000);

  afterAll(async () => {
    if (vendorId) {
      await prisma.order.deleteMany({ where: { vendorId } });
      await prisma.vendor.delete({ where: { id: vendorId } }).catch(() => undefined);
    }
    await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });
    await prisma.webhookEvent.deleteMany({ where: { provider: "easypost" } });
    await app.close();
  });

  // ---------------------------------------------------------------------------

  function deliveredEvent(eventId: string): unknown {
    return {
      id: eventId,
      description: "tracker.updated",
      result: {
        object: "Tracker",
        tracking_code: trackingNumber,
        status: "delivered",
        status_detail: "delivered",
        signed_by: "J. TEST",
        tracking_details: [
          {
            object_id: "trkdtl_1",
            status: "delivered",
            status_detail: "delivered",
            message: "Delivered, In/At Mailbox",
            datetime: new Date().toISOString(),
            tracking_location: { city: "MIAMI", state: "FL", country: "US" },
          },
        ],
      },
    };
  }

  // ---------------------------------------------------------------------------

  it("signed delivered event flips the order to DELIVERED + writes one event", async () => {
    const eventId = `evt_ep_${randomUUID()}`;
    const event = deliveredEvent(eventId);
    const raw = JSON.stringify(event);
    const sig = signBody(raw, WEBHOOK_SECRET);

    await request(server)
      .post("/v1/webhooks/easypost")
      .set("X-Hmac-Signature", sig)
      .set("Content-Type", "application/json")
      .send(raw)
      .expect(200)
      .expect((r) => {
        expect(r.body.received).toBe(true);
        expect(r.body.deduped).toBeUndefined();
      });

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    expect(order!.status).toBe("DELIVERED");
    expect(order!.deliveredAt).not.toBeNull();

    const events = await prisma.orderEvent.findMany({
      where: { orderId, type: "carrier.delivered" },
    });
    expect(events).toHaveLength(1);

    // Replay with the same event id: deduped, no extra event row.
    await request(server)
      .post("/v1/webhooks/easypost")
      .set("X-Hmac-Signature", sig)
      .set("Content-Type", "application/json")
      .send(raw)
      .expect(200)
      .expect((r) => {
        expect(r.body.deduped).toBe(true);
      });

    const eventsAfter = await prisma.orderEvent.findMany({
      where: { orderId, type: "carrier.delivered" },
    });
    expect(eventsAfter).toHaveLength(1);
  }, 60_000);

  it("unsigned payload is rejected", async () => {
    const eventId = `evt_ep_unsigned_${randomUUID()}`;
    const event = deliveredEvent(eventId);
    const raw = JSON.stringify(event);

    await request(server)
      .post("/v1/webhooks/easypost")
      .set("Content-Type", "application/json")
      .send(raw)
      .expect((res) => {
        expect(res.status).not.toBe(200);
      });

    // No webhook_events row should have been written.
    const row = await prisma.webhookEvent.findFirst({
      where: { provider: "easypost", eventId },
    });
    expect(row).toBeNull();
  }, 30_000);

  it("tampered signature (wrong digest) is rejected", async () => {
    const eventId = `evt_ep_tampered_${randomUUID()}`;
    const event = deliveredEvent(eventId);
    const raw = JSON.stringify(event);
    const wrongSig = signBody(raw, "this_is_not_the_secret");

    await request(server)
      .post("/v1/webhooks/easypost")
      .set("X-Hmac-Signature", wrongSig)
      .set("Content-Type", "application/json")
      .send(raw)
      .expect((res) => expect(res.status).not.toBe(200));

    // No webhook_events row should have been written.
    const row = await prisma.webhookEvent.findFirst({
      where: { provider: "easypost", eventId },
    });
    expect(row).toBeNull();
  }, 30_000);
});
