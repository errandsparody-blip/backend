/**
 * ShippoService — unit tests pinning down the boundary helpers.
 *
 * The real REST client isn't exercised here (it needs a live key and is
 * covered by the runbook smoke test + production observability). What we
 * *do* exercise:
 *
 *   1. dollarsToCents — float-free conversion. Off-by-one here means
 *      every customer is over- or under-charged by a fraction of a cent.
 *   2. Stub mode parity — when SHIPPO_API_KEY is unset, getRates and
 *      purchaseLabel still satisfy their published interface.
 *   3. verifyWebhookSecret — accept unsigned in dev when no secret is set,
 *      constant-time compare when set, malformed input rejection.
 *
 * IMPORTANT: env is set before any project import — `loadConfig()` caches
 * at module level, so test files have to win the race.
 */

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.API_PUBLIC_URL ??= "http://localhost:4000";
process.env.WEB_PUBLIC_URL ??= "http://localhost:3000";
process.env.JWT_ACCESS_SECRET ??= Buffer.alloc(64, 1).toString("base64");
process.env.JWT_REFRESH_SECRET ??= Buffer.alloc(64, 2).toString("base64");
process.env.ENCRYPTION_MASTER_KEY ??= Buffer.alloc(32, 3).toString("base64");
process.env.COOKIE_DOMAIN ??= "localhost";
delete process.env.SHIPPO_API_KEY;
delete process.env.SHIPPO_WEBHOOK_SECRET;

import { ShippoService } from "./shippo.service";

function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const r = (err as { response?: unknown }).response;
  if (typeof r === "object" && r !== null) {
    return (r as { code?: string }).code;
  }
  return undefined;
}

/** Test-only seam — override cfg.SHIPPO_WEBHOOK_SECRET on a fresh service. */
function svcWithSecret(secret: string | undefined): ShippoService {
  const svc = new ShippoService();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
  const cfg = (svc as any).cfg as { SHIPPO_WEBHOOK_SECRET?: string };
  if (secret === undefined) {
    delete cfg.SHIPPO_WEBHOOK_SECRET;
  } else {
    cfg.SHIPPO_WEBHOOK_SECRET = secret;
  }
  return svc;
}

describe("ShippoService — boundary helpers", () => {
  const svc = new ShippoService();

  // -------------------------------------------------------------------------
  // dollarsToCents
  // -------------------------------------------------------------------------

  describe("dollarsToCents", () => {
    function call(dollars: string): number {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      return (svc as any).dollarsToCents(dollars);
    }

    it("parses integer dollars", () => {
      expect(call("5")).toBe(500);
      expect(call("100")).toBe(10_000);
    });

    it("parses one-decimal dollars", () => {
      expect(call("8.4")).toBe(840);
    });

    it("parses two-decimal dollars exactly (no float drift)", () => {
      expect(call("8.40")).toBe(840);
      expect(call("8.41")).toBe(841);
      // The classic float trap — 0.1 + 0.2 ≠ 0.3.
      expect(call("0.30")).toBe(30);
      expect(call("0.10")).toBe(10);
      expect(call("0.01")).toBe(1);
    });

    it("rejects non-numeric or over-precision input", () => {
      expect(() => call("abc")).toThrow();
      expect(() => call("")).toThrow();
      expect(() => call("8.405")).toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Stub mode parity — when no API key is set.
  // -------------------------------------------------------------------------

  describe("stub mode (no API key)", () => {
    it("isLive() is false", () => {
      expect(svc.isLive()).toBe(false);
    });

    it("getRates returns the three base carriers with positive integer cents", async () => {
      const resp = await svc.getRates({
        fromAddress: { state: "FL", postalCode: "33101", country: "US" },
        toAddress: {
          line1: "1 Test Way",
          city: "Miami",
          state: "FL",
          postalCode: "33101",
          country: "US",
        },
        // Large/awkward parcel that fits no flat-rate container — so the
        // result is exactly the three weight-based carriers.
        parcel: { weightOz: 16, lengthIn: 20, widthIn: 16, heightIn: 10 },
        declaredValueCents: 5_000,
        insuranceRequested: false,
      });

      expect(resp.shipmentId).toMatch(/^shp_stub_/);
      expect(resp.rates).toHaveLength(3);
      for (const rate of resp.rates) {
        expect(rate.costCents).toBeGreaterThan(0);
        expect(Number.isInteger(rate.costCents)).toBe(true);
        expect(rate.carrier).toMatch(/USPS|UPS|FedEx/);
        expect(rate.shipmentId).toBe(resp.shipmentId);
      }
    });

    it("getRates surfaces flat-rate options when the parcel fits a container", async () => {
      const resp = await svc.getRates({
        fromAddress: { state: "FL", postalCode: "33101", country: "US" },
        toAddress: {
          line1: "1 Test Way",
          city: "Miami",
          state: "FL",
          postalCode: "33101",
          country: "US",
        },
        // 9×6×3 @ 1 lb fits the Medium and Large flat-rate boxes.
        parcel: { weightOz: 16, lengthIn: 9, widthIn: 6, heightIn: 3 },
        declaredValueCents: 5_000,
        insuranceRequested: false,
      });

      const flat = resp.rates.filter((r) => /flat rate/i.test(r.service));
      expect(flat.length).toBeGreaterThan(0);
      for (const rate of flat) {
        expect(rate.carrier).toBe("USPS");
        expect(rate.costCents).toBeGreaterThan(0);
      }
    });

    it("getRates omits flat-rate options when dimensions are unknown", async () => {
      const resp = await svc.getRates({
        fromAddress: { state: "FL", postalCode: "33101", country: "US" },
        toAddress: {
          line1: "1 Test Way",
          city: "Miami",
          state: "FL",
          postalCode: "33101",
          country: "US",
        },
        // Weight-only listing: no measured dims → we can't prove fit.
        parcel: { weightOz: 16, lengthIn: 0, widthIn: 0, heightIn: 0 },
        declaredValueCents: 5_000,
        insuranceRequested: false,
      });

      expect(resp.rates.filter((r) => /flat rate/i.test(r.service))).toHaveLength(0);
    });

    it("getRates rejects zero/negative weight", async () => {
      const result = await svc
        .getRates({
          fromAddress: { state: "FL", postalCode: "33101", country: "US" },
          toAddress: {
            line1: "x",
            city: "x",
            state: "FL",
            postalCode: "33101",
            country: "US",
          },
          parcel: { weightOz: 0, lengthIn: 1, widthIn: 1, heightIn: 1 },
          declaredValueCents: 100,
          insuranceRequested: false,
        })
        .then(() => undefined)
        .catch((err: unknown) => err);
      expect(result).toBeDefined();
      expect(errorCode(result)).toBe("shippo_invalid_weight");
    });

    it("getRates rejects unsupported destinations (US + CA only)", async () => {
      const result = await svc
        .getRates({
          fromAddress: { state: "FL", postalCode: "33101", country: "US" },
          toAddress: {
            line1: "x",
            city: "London",
            state: "LN",
            postalCode: "SW1A",
            country: "GB",
          },
          parcel: { weightOz: 16, lengthIn: 9, widthIn: 6, heightIn: 3 },
          declaredValueCents: 100,
          insuranceRequested: false,
        })
        .then(() => undefined)
        .catch((err: unknown) => err);
      expect(result).toBeDefined();
      expect(errorCode(result)).toBe("shippo_intl_unsupported");
    });

    it("purchaseLabel returns a USPS-shaped tracking number when rate hints USPS", async () => {
      const resp = await svc.purchaseLabel({
        shipmentId: "shp_stub_test",
        rateId: "rate_stub_usps_priority_anything",
      });
      expect(resp.trackingNumber.length).toBeGreaterThan(10);
      expect(resp.labelUrl).toMatch(/^https:\/\//);
      expect(resp.carrier).toBe("USPS");
    });

    it("getTracker returns null in stub mode (no API to call)", async () => {
      await expect(svc.getTracker("usps", "9400123456")).resolves.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // verifyWebhookSecret — path-query token check (NOT HMAC).
  // -------------------------------------------------------------------------

  describe("verifyWebhookSecret", () => {
    it("accepts any value in dev when no secret is set (warns)", () => {
      const noSecret = svcWithSecret(undefined);
      expect(noSecret.verifyWebhookSecret(undefined)).toBe(true);
      expect(noSecret.verifyWebhookSecret("anything")).toBe(true);
    });

    it("rejects when a secret is set but no value present", () => {
      const withSecret = svcWithSecret("secret_v1");
      expect(withSecret.verifyWebhookSecret(undefined)).toBe(false);
      expect(withSecret.verifyWebhookSecret("")).toBe(false);
    });

    it("rejects when the value doesn't match", () => {
      const withSecret = svcWithSecret("secret_v1");
      expect(withSecret.verifyWebhookSecret("wrong")).toBe(false);
      // Same length as secret_v1 but wrong content — exercise the
      // constant-time path explicitly.
      expect(withSecret.verifyWebhookSecret("WRONG_v1A")).toBe(false);
    });

    it("rejects when the value has a different length", () => {
      const withSecret = svcWithSecret("secret_v1");
      expect(withSecret.verifyWebhookSecret("secret_v1_with_extra")).toBe(false);
      expect(withSecret.verifyWebhookSecret("secret")).toBe(false);
    });

    it("accepts the exact secret", () => {
      const secret = "d678b3c36f065c9c22cce5f12fbe4bb7";
      const withSecret = svcWithSecret(secret);
      expect(withSecret.verifyWebhookSecret(secret)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Live-mode shipment extras — signature confirmation + international
  // customs declaration (migration 0055 / Canada). We force live mode and
  // stub the HTTP `request` to capture the shipment body Shippo would
  // receive, then assert the add-on/customs payload is shaped correctly.
  // -------------------------------------------------------------------------

  describe("getRatesLive — signature + customs payload", () => {
    function liveSvc(): { svc: ShippoService; bodies: Array<Record<string, unknown>> } {
      const svc = new ShippoService();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      const cfg = (svc as any).cfg as Record<string, unknown>;
      cfg.SHIPPO_API_KEY = "shippo_test_key";
      cfg.WAREHOUSE_FROM_NAME = "USA Errands";
      cfg.WAREHOUSE_FROM_STREET1 = "1 Warehouse Rd";
      cfg.WAREHOUSE_FROM_CITY = "Miami";
      cfg.WAREHOUSE_FROM_STATE = "FL";
      cfg.WAREHOUSE_FROM_ZIP = "33101";
      cfg.WAREHOUSE_FROM_PHONE = "3055551234";
      cfg.WAREHOUSE_FROM_EMAIL = "ops@example.com";

      const bodies: Array<Record<string, unknown>> = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      (svc as any).request = jest.fn(async (_method: string, _path: string, body?: Record<string, unknown>) => {
        if (body) bodies.push(body);
        return {
          object_id: "shp_live_1",
          rates: [
            {
              object_id: "rate_1",
              provider: "USPS",
              servicelevel: { name: "Priority Mail International", token: "usps_priority_intl" },
              amount: "24.50",
              estimated_days: 6,
            },
          ],
        };
      });
      return { svc, bodies };
    }

    it("adds signature_confirmation + inline customs_declaration for a Canada shipment", async () => {
      const { svc, bodies } = liveSvc();
      const resp = await svc.getRates({
        fromAddress: { state: "FL", postalCode: "33101", country: "US" },
        toAddress: {
          recipientName: "Jean Client",
          line1: "100 Yonge St",
          city: "Toronto",
          state: "ON",
          postalCode: "M5V 2T6",
          country: "CA",
        },
        parcel: { weightOz: 32, lengthIn: 10, widthIn: 8, heightIn: 6 },
        declaredValueCents: 12_000,
        insuranceRequested: true,
        signatureConfirmation: "ADULT",
        customs: {
          contentsType: "MERCHANDISE",
          signer: "USA Errands Fulfillment",
          incoterm: "DDU",
          items: [
            {
              description: "Black Tee",
              quantity: 2,
              netWeightOz: 8,
              valueCents: 6_000,
              hsCode: "610910",
              originCountry: "US",
            },
          ],
        },
      });

      expect(resp.rates.length).toBeGreaterThan(0);
      const shipmentBody = bodies.find((b) => "parcels" in b);
      expect(shipmentBody).toBeDefined();
      // Signature extra present.
      expect((shipmentBody!.extra as { signature_confirmation?: string }).signature_confirmation).toBe("ADULT");
      // Customs declaration present + shaped.
      const customs = shipmentBody!.customs_declaration as {
        contents_type?: string;
        certify?: boolean;
        items?: Array<{ description?: string; quantity?: number; tariff_number?: string }>;
      };
      expect(customs.contents_type).toBe("MERCHANDISE");
      expect(customs.certify).toBe(true);
      expect(customs.items?.[0]?.description).toBe("Black Tee");
      expect(customs.items?.[0]?.tariff_number).toBe("610910");
    });

    it("omits customs + signature for a plain domestic shipment", async () => {
      const { svc, bodies } = liveSvc();
      await svc.getRates({
        fromAddress: { state: "FL", postalCode: "33101", country: "US" },
        toAddress: {
          recipientName: "Jane Buyer",
          line1: "1 Test Way",
          city: "Miami",
          state: "FL",
          postalCode: "33101",
          country: "US",
        },
        parcel: { weightOz: 16, lengthIn: 20, widthIn: 16, heightIn: 10 },
        declaredValueCents: 5_000,
        insuranceRequested: false,
      });
      const shipmentBody = bodies.find((b) => "parcels" in b);
      expect(shipmentBody).toBeDefined();
      expect(shipmentBody!.extra).toBeUndefined();
      expect(shipmentBody!.customs_declaration).toBeUndefined();
    });
  });
});
