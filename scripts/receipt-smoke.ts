import { buildReceiptBreakdown, buildReceiptSvg, buildReceiptHtmlBlock, buildReceiptText } from "../src/modules/shopper/shopper-receipt.builder";

const request: any = {
  id: "00000000-0000-0000-0000-000000000001",
  reference: "SHP-000042",
  parentRequestId: null,
  buyerEmail: "buyer@example.com",
  buyerName: "Anna Buyer",
  shippingAddress: null,
  shippingMethod: "PLATFORM_FREIGHT",
  trackingNumber: "1Z999AA10123456784",
  carrier: "UPS",
  shippedAt: null,
  deliveredAt: null,
  itemsSubtotalCents: 12500,
  commissionRateBps: 1500,
  commissionCents: 1875,
  estimatedTaxRateBps: 825,
  estimatedTaxCents: 1031,
  actualTaxCents: 1080,
  effectiveTaxState: "TX",
  intakeTotalCents: 15406,
  intakeStripeSessionId: null,
  intakeStripeIntentId: null,
  intakePaidAt: new Date("2026-05-09T10:00:00Z"),
  itemsActualSubtotalCents: 13200,
  shippingCostCents: 1450,
  followupAmountCents: 1199, // positive = buyer pays
  followupStripeSessionId: null,
  followupStripeIntentId: null,
  followupStripeRefundId: null,
  followupResolvedAt: null,
  cancelIntakeRefundId: null,
  cancelFollowupRefundId: null,
  parcelLengthIn: 12.5,
  parcelWidthIn: 9,
  parcelHeightIn: 6,
  parcelWeightOz: 24.3,
  status: "AWAITING_RECONCILIATION",
  assignedAdminId: null,
  internalNotes: null,
  createdAt: new Date("2026-05-08T08:30:00Z"),
  updatedAt: new Date(),
};

const lines: any[] = [
  {
    id: "l1", requestId: request.id,
    productUrl: "https://example.com/cool-jeans-32x32",
    productTitle: "Levi's 501 Original Fit",
    productNotes: null,
    quantity: 2,
    estimatedUnitPriceCents: 4500,
    actualUnitPriceCents: 4800,
    actualWeightOz: 18,
    procurementStatus: "purchased",
    procurementNotes: null,
    createdAt: new Date(), updatedAt: new Date(),
  },
  {
    id: "l2", requestId: request.id,
    productUrl: "https://example.com/sneakers-blue",
    productTitle: null,
    productNotes: null,
    quantity: 1,
    estimatedUnitPriceCents: 3500,
    actualUnitPriceCents: 3600,
    actualWeightOz: 6.3,
    procurementStatus: "substituted",
    procurementNotes: null,
    createdAt: new Date(), updatedAt: new Date(),
  },
];

const breakdown = buildReceiptBreakdown(request, lines, "SHP-000041");
const svg = buildReceiptSvg(breakdown);
const html = buildReceiptHtmlBlock(breakdown);
const text = buildReceiptText(breakdown);

console.log("--- SVG length:", svg.length);
console.log("--- HTML length:", html.length);
console.log("--- TEXT ---");
console.log(text);
console.log("--- SVG valid root:", svg.startsWith("<svg") && svg.endsWith("</svg>"));
require("fs").writeFileSync("/tmp/receipt.svg", svg);
require("fs").writeFileSync("/tmp/receipt.html", `<html><body style="background:#ddd;padding:20px;">${html}</body></html>`);
console.log("Written /tmp/receipt.svg and /tmp/receipt.html");
