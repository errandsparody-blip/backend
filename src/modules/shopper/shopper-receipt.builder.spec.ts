/**
 * Receipt builder — pure-function regression coverage.
 *
 * The builder is the single source of truth for "how did we arrive at the
 * numbers?" — both the buyer-facing chat image AND the email body lean
 * on it. A bug here misleads buyers about money, so we lock in the
 * arithmetic + render shape with these tests.
 */

import {
  buildReceiptBreakdown,
  buildReceiptHtmlBlock,
  buildReceiptSvg,
  buildReceiptText,
} from "./shopper-receipt.builder";
import type { LineRow, RequestRow } from "./shopper-request.service";

const baseRequest: RequestRow = {
  id: "00000000-0000-0000-0000-000000000001",
  reference: "SHP-000042",
  parentRequestId: null,
  buyerEmail: "buyer@example.com",
  buyerName: "Anna Buyer",
  shippingAddress: null,
  shippingMethod: "PLATFORM_FREIGHT",
  trackingNumber: null,
  carrier: null,
  shippedAt: null,
  deliveredAt: null,
  itemsSubtotalCents: 12500,
  commissionRateBps: 1500,
  commissionCents: 1875,
  estimatedTaxRateBps: 825,
  estimatedTaxCents: 1031,
  actualTaxCents: null,
  effectiveTaxState: "TX",
  intakeTotalCents: 15406,
  intakeStripeSessionId: null,
  intakeStripeIntentId: null,
  intakePaidAt: new Date("2026-05-09T10:00:00Z"),
  itemsActualSubtotalCents: null,
  shippingCostCents: null,
  followupAmountCents: null,
  followupStripeSessionId: null,
  followupStripeIntentId: null,
  followupStripeRefundId: null,
  followupResolvedAt: null,
  cancelIntakeRefundId: null,
  cancelFollowupRefundId: null,
  parcelLengthIn: null,
  parcelWidthIn: null,
  parcelHeightIn: null,
  parcelWeightOz: null,
  status: "PROCURING",
  assignedAdminId: null,
  internalNotes: null,
  createdAt: new Date("2026-05-08T08:30:00Z"),
  updatedAt: new Date("2026-05-08T08:30:00Z"),
};

const baseLines: LineRow[] = [
  {
    id: "l1",
    requestId: baseRequest.id,
    productUrl: "https://example.com/cool-jeans-32x32",
    productTitle: "Levi's 501 Original Fit",
    productNotes: null,
    quantity: 2,
    estimatedUnitPriceCents: 4500,
    actualUnitPriceCents: null,
    actualWeightOz: null,
    procurementStatus: null,
    procurementNotes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: "l2",
    requestId: baseRequest.id,
    productUrl: "https://example.com/sneakers-blue",
    productTitle: null,
    productNotes: null,
    quantity: 1,
    estimatedUnitPriceCents: 3500,
    actualUnitPriceCents: null,
    actualWeightOz: null,
    procurementStatus: null,
    procurementNotes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

describe("shopper receipt builder", () => {
  describe("buildReceiptBreakdown", () => {
    it("derives a label from the URL when productTitle is null", () => {
      const b = buildReceiptBreakdown(baseRequest, baseLines);
      expect(b.lines[0]!.label).toBe("Levi's 501 Original Fit");
      // sneakers line: last URL segment, hyphens → spaces, decoded
      expect(b.lines[1]!.label).toBe("sneakers blue");
    });

    it("threads the parent reference through verbatim", () => {
      const b = buildReceiptBreakdown(baseRequest, baseLines, "SHP-000041");
      expect(b.parentReference).toBe("SHP-000041");
    });

    it("snapshots tax state + estimate cents from the row", () => {
      const b = buildReceiptBreakdown(baseRequest, baseLines);
      expect(b.effectiveTaxState).toBe("TX");
      expect(b.estimatedTaxCents).toBe(1031);
      expect(b.estimatedTaxRateBps).toBe(825);
    });
  });

  describe("buildReceiptText — money arithmetic", () => {
    it("formats intake-only state without reconciliation block", () => {
      const text = buildReceiptText(buildReceiptBreakdown(baseRequest, baseLines));
      expect(text).toContain("Items subtotal (estimate)");
      expect(text).toContain("$125.00");
      expect(text).toContain("Service commission");
      expect(text).toContain("$18.75");
      expect(text).toContain("Estimated sales tax (TX 8.25%)");
      expect(text).toContain("$10.31");
      expect(text).toContain("Intake total");
      expect(text).toContain("$154.06");
      // Reconciliation block omitted because no actuals exist
      expect(text).not.toContain("— Reconciliation —");
      expect(text).not.toContain("Items subtotal (actual)");
      // Total charged so far = intake (paid)
      expect(text).toContain("TOTAL CHARGED TO DATE  $154.06");
      expect(text).toContain("Intake paid — procurement in progress");
    });

    it("renders positive followup with a + sign and shows running total", () => {
      const lines = baseLines.map((l, i) => ({
        ...l,
        actualUnitPriceCents: i === 0 ? 4800 : 3600,
        procurementStatus: i === 0 ? "purchased" : "substituted",
      }));
      const req = {
        ...baseRequest,
        itemsActualSubtotalCents: 13200,
        actualTaxCents: 1080,
        shippingCostCents: 1450,
        followupAmountCents: 1199,
        status: "AWAITING_RECONCILIATION" as const,
      };
      const text = buildReceiptText(buildReceiptBreakdown(req, lines));
      expect(text).toContain("Items subtotal (actual)");
      expect(text).toContain("$132.00");
      expect(text).toContain("Sales tax (actual)");
      expect(text).toContain("$10.80");
      expect(text).toContain("Shipping cost");
      expect(text).toContain("$14.50");
      expect(text).toContain("Follow-up due (you pay)");
      expect(text).toContain("+$11.99");
      // Total charged so far = intake + positive followup
      expect(text).toContain("TOTAL CHARGED TO DATE  $166.05");
      expect(text).toContain("Final payment outstanding");
    });

    it("renders negative followup as refund (no + sign, refund label)", () => {
      const req = {
        ...baseRequest,
        itemsActualSubtotalCents: 11000,
        actualTaxCents: 900,
        shippingCostCents: 1200,
        followupAmountCents: -1431,
      };
      const text = buildReceiptText(buildReceiptBreakdown(req, baseLines));
      expect(text).toContain("Follow-up refund (we refund)");
      expect(text).toContain("-$14.31");
      // Negative followup doesn't add to charged total
      expect(text).toContain("TOTAL CHARGED TO DATE  $154.06");
      expect(text).toContain("Refund due to buyer");
    });

    it("renders zero-followup as settled", () => {
      const req = {
        ...baseRequest,
        itemsActualSubtotalCents: 12500,
        actualTaxCents: 1031,
        shippingCostCents: 0,
        followupAmountCents: 0,
      };
      const text = buildReceiptText(buildReceiptBreakdown(req, baseLines));
      expect(text).toContain("Follow-up settled");
      expect(text).toContain("Settled — no follow-up needed");
    });
  });

  describe("buildReceiptText — parcel + carrier", () => {
    it("renders parcel block when any dimension or weight present", () => {
      const req = {
        ...baseRequest,
        parcelLengthIn: 12.5,
        parcelWidthIn: 9,
        parcelHeightIn: 6,
        parcelWeightOz: 24.3,
      };
      const text = buildReceiptText(buildReceiptBreakdown(req, baseLines));
      expect(text).toContain("PARCEL");
      expect(text).toContain("12.5 × 9 × 6 in");
      // Weight conversion to lb when ≥ 16 oz
      expect(text).toContain("1.52 lb (24.3 oz)");
    });

    it("renders carrier + tracking when shipped", () => {
      const req = {
        ...baseRequest,
        carrier: "UPS",
        trackingNumber: "1Z999AA10123456784",
      };
      const text = buildReceiptText(buildReceiptBreakdown(req, baseLines));
      expect(text).toContain("SHIPMENT");
      expect(text).toContain("Carrier         UPS");
      expect(text).toContain("Tracking        1Z999AA10123456784");
    });

    it("omits PARCEL block when no dims and no weight", () => {
      const text = buildReceiptText(buildReceiptBreakdown(baseRequest, baseLines));
      expect(text).not.toContain("PARCEL");
    });
  });

  describe("buildReceiptHtmlBlock — security", () => {
    it("escapes HTML special chars in line labels", () => {
      const lines: LineRow[] = [
        {
          ...baseLines[0]!,
          productTitle: '<script>alert("x")</script>',
        },
      ];
      const html = buildReceiptHtmlBlock(buildReceiptBreakdown(baseRequest, lines));
      expect(html).not.toContain("<script>alert");
      expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    });

    it("escapes HTML chars in tracking number", () => {
      const req = {
        ...baseRequest,
        carrier: "UPS",
        trackingNumber: '<img src=x onerror="alert(1)">',
      };
      const html = buildReceiptHtmlBlock(buildReceiptBreakdown(req, baseLines));
      expect(html).not.toContain('<img src=x onerror="alert(1)">');
      expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    });
  });

  describe("buildReceiptSvg — structure", () => {
    it("returns a self-contained SVG with no script / external refs", () => {
      const svg = buildReceiptSvg(buildReceiptBreakdown(baseRequest, baseLines));
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg.endsWith("</svg>")).toBe(true);
      expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
      // No script/foreignObject — safe to serve as image/svg+xml on R2
      expect(svg).not.toMatch(/<script\b/i);
      expect(svg).not.toMatch(/<foreignObject\b/i);
      // No external references
      expect(svg).not.toMatch(/href\s*=/i);
      expect(svg).not.toMatch(/xlink:href/i);
    });

    it("includes the reference, status, and total in the SVG body", () => {
      const svg = buildReceiptSvg(buildReceiptBreakdown(baseRequest, baseLines));
      expect(svg).toContain("RECEIPT · SHP-000042");
      expect(svg).toContain("procuring"); // status formatted lowercase
      expect(svg).toContain("$154.06");
    });

    it("escapes XML special chars in line labels", () => {
      const lines: LineRow[] = [
        {
          ...baseLines[0]!,
          productTitle: 'A & B "fancy" <thing>',
        },
      ];
      const svg = buildReceiptSvg(buildReceiptBreakdown(baseRequest, lines));
      expect(svg).not.toContain("<thing>");
      expect(svg).toContain("A &amp; B &quot;fancy&quot; &lt;thing&gt;");
    });
  });
});
