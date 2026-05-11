/**
 * Shippo webhook integration test (replaces the earlier EasyPost e2e).
 *
 * Asserts:
 *   1. A `track_updated` event with status "DELIVERED" + correct path-secret
 *      updates the order to DELIVERED + writes a CARRIER OrderEvent.
 *   2. Replaying the same tracker:status:status_date tuple is deduped
 *      via webhook_events unique(provider, event_id).
 *   3. Missing path-secret is rejected (no order change, no event row).
 *   4. Wrong path-secret is rejected.
 *
 * Notes:
 *   - In test mode SHIPPO_API_KEY is unset, so ShippoService runs in stub
 *     mode and `getTracker` returns null — the controller falls back to
 *     trusting the payload's claimed status (the documented test-mode
 *     behaviour). The production callback-verification path is exercised
 *     by manual smoke tests against Shippo's live API.
 *
 * Implementation Plan §6.6.3, §14.4 (defense in depth).
 */

import { Test, type TestingModule } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { ValidationPipe, VersioningType } from "@nestjs/common";
import * as argon2 from "argon2";
import cookieParser from "cookie-parser";
import { randomUUID } from "node:crypto";
import request from "supertest";

import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/common/prisma.service";

const TEST_EMAIL = "p5-shippo-e2e@usa-errands.test";
const TEST_PASSWORD = "X7uFJ4G3!aD2qzA9Pm";
const WEBHOOK_SECRET = "shippo_test_webhook_secret_v1";

describe("Shippo webhook (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<INestApplication["getHttpServer"]>;
  let vendorId: string;
  let orderId: string;
  const trackingNumber = `9400${Date.now()}`;

  beforeAll(async () => {
    process.env.SHIPPO_WEBHOOK_SECRET = WEBHOOK_SECRET;

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

    await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });
    const vendor = await prisma.vendor.create({
      data: {
        businessName: "Shippo Webhook E2E",
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
    await prisma.webhookEvent.deleteMany({ where: { provider: "shippo" } });
    await app.close();
  });

  // ---------------------------------------------------------------------------

  function deliveredEvent(trackerId: string, statusDate: string): object {
    return {
      event: "track_updated",
      data: {
        object_id: trackerId,
        carrier: "usps",
        tracking_number: trackingNumber,
        tracking_status: {
          status: "DELIVERED",
          status_details: "Delivered, In/At Mailbox",
          status_date: statusDate,
          location: { city: "MIAMI", state: "FL", country: "US" },
        },
      },
    };
  }

  // ---------------------------------------------------------------------------

  it("signed delivered event flips the order to DELIVERED + writes one event", async () => {
    const trackerId = `track_${randomUUID()}`;
    const statusDate = new Date().toISOString();
    const event = deliveredEvent(trackerId, statusDate);

    await request(server)
      .post(`/v1/webhooks/shippo?secret=${WEBHOOK_SECRET}`)
      .set("Content-Type", "application/json")
      .send(event)
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

    // Replay with the same trackerId + status + status_date: deduped.
    await request(server)
      .post(`/v1/webhooks/shippo?secret=${WEBHOOK_SECRET}`)
      .set("Content-Type", "application/json")
      .send(event)
      .expect(200)
      .expect((r) => {
        expect(r.body.deduped).toBe(true);
      });

    const eventsAfter = await prisma.orderEvent.findMany({
      where: { orderId, type: "carrier.delivered" },
    });
    expect(eventsAfter).toHaveLength(1);
  }, 60_000);

  it("missing path-secret is rejected", async () => {
    const trackerId = `track_${randomUUID()}`;
    const statusDate = new Date().toISOString();
    const event = deliveredEvent(trackerId, statusDate);

    await request(server)
      .post("/v1/webhooks/shippo")
      .set("Content-Type", "application/json")
      .send(event)
      .expect((res) => {
        expect(res.status).not.toBe(200);
      });

    const row = await prisma.webhookEvent.findFirst({
      where: { provider: "shippo", eventId: { contains: trackerId } },
    });
    expect(row).toBeNull();
  }, 30_000);

  it("wrong path-secret is rejected", async () => {
    const trackerId = `track_${randomUUID()}`;
    const statusDate = new Date().toISOString();
    const event = deliveredEvent(trackerId, statusDate);

    await request(server)
      .post("/v1/webhooks/shippo?secret=wrong_secret")
      .set("Content-Type", "application/json")
      .send(event)
      .expect((res) => expect(res.status).not.toBe(200));

    const row = await prisma.webhookEvent.findFirst({
      where: { provider: "shippo", eventId: { contains: trackerId } },
    });
    expect(row).toBeNull();
  }, 30_000);
});
