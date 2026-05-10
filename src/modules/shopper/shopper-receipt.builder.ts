/**
 * Shopper receipt builder — pure functions producing one breakdown in
 * three formats: SVG (chat preview, scalable image), HTML (email body,
 * inline-styled, table-based for client compatibility), and text
 * (plaintext mail twin + screen readers).
 *
 * One source of truth: `ReceiptBreakdown`. Build it from the persisted
 * row + lines via `buildReceiptBreakdown()`, then render with whichever
 * format suits the surface.
 *
 * Why three formats?
 *   - **SVG**: hand-rendered, no fonts, scales crisply on retina, posts
 *     into the chat thread as an attachment URL. Browsers render SVG
 *     natively; mobile previews are sharp.
 *   - **HTML**: table-based receipt block; pasted INSIDE the email body
 *     so Gmail / Outlook / Apple Mail all render it. Image embedding
 *     in email is unreliable (Gmail strips SVG <img> from external
 *     hosts) — putting the breakdown directly in the body is the only
 *     way to guarantee the buyer sees it.
 *   - **text**: also embedded in the email's `text` twin so plaintext
 *     readers and spam filters get the same data.
 *
 * Money is integer cents end-to-end. Floats only appear when displaying
 * USD (formatUSD) or weight in lb. Never used for arithmetic.
 *
 * Security:
 *   - All buyer / line text is escaped before injection into SVG/HTML.
 *   - SVG is self-contained (no <foreignObject>, no external refs, no
 *     script). Safe to host as `image/svg+xml` on R2 and embed via <img>.
 */

import type { LineRow, RequestRow } from "./shopper-request.service";

// ---------------------------------------------------------------------------
// Data shape
// ---------------------------------------------------------------------------

export interface ReceiptLine {
  /** Display name — productTitle if known, else last URL segment. */
  label: string;
  quantity: number;
  estimatedUnitPriceCents: number;
  actualUnitPriceCents: number | null;
  /** "purchased" / "unavailable" / "substituted" / null at intake. */
  status: string | null;
  /** Per-line weight (oz) once warehouse weighs receive. */
  actualWeightOz: number | null;
}

export interface ReceiptBreakdown {
  /** Header lines. */
  reference: string;
  parentReference: string | null;
  status: string;
  createdAt: Date;

  /** Buyer block. */
  buyerName: string | null;
  buyerEmail: string;

  /** Items + estimate. */
  lines: ReceiptLine[];
  itemsSubtotalCents: number;
  commissionCents: number;
  /** Buyer-protective tax estimate at intake. */
  estimatedTaxRateBps: number;
  estimatedTaxCents: number;
  effectiveTaxState: string | null;
  intakeTotalCents: number;
  intakePaidAt: Date | null;

  /** Reconciliation (null if not yet known). */
  itemsActualSubtotalCents: number | null;
  actualTaxCents: number | null;
  shippingCostCents: number | null;

  /** Parcel (null until weighed/measured). */
  parcelLengthIn: number | null;
  parcelWidthIn: number | null;
  parcelHeightIn: number | null;
  parcelWeightOz: number | null;

  /**
   * Migration 0017 — freight breakdown. `freightRateCentsPerLb` is the
   * snapshot of the per-method rate used at save time; together with
   * `shippingCalculatedCents` it lets the receipt show
   * `weight × rate = calc · charged X` so the buyer sees any operator
   * override. `shippingMethod` labels the rate (Platform freight /
   * Buyer forwarder / Warehouse pickup) — same field as on the row,
   * mirrored here so the builder doesn't take a dependency on the
   * Prisma enum types.
   */
  shippingMethod: string | null;
  freightRateCentsPerLb: number | null;
  shippingCalculatedCents: number | null;

  /** Follow-up (signed: + buyer pays, − we refund, 0 nothing). */
  followupAmountCents: number | null;

  /** Carrier + tracking (null until shipped). */
  carrier: string | null;
  trackingNumber: string | null;
}

// ---------------------------------------------------------------------------
// Build from persisted shapes
// ---------------------------------------------------------------------------

export function buildReceiptBreakdown(
  request: RequestRow,
  lines: LineRow[],
  parentReference: string | null = null,
): ReceiptBreakdown {
  return {
    reference: request.reference,
    parentReference,
    status: request.status,
    createdAt: request.createdAt,
    buyerName: request.buyerName,
    buyerEmail: request.buyerEmail,
    lines: lines.map((l) => ({
      label: l.productTitle ?? deriveLabelFromUrl(l.productUrl),
      quantity: l.quantity,
      estimatedUnitPriceCents: l.estimatedUnitPriceCents,
      actualUnitPriceCents: l.actualUnitPriceCents,
      status: l.procurementStatus,
      actualWeightOz: l.actualWeightOz,
    })),
    itemsSubtotalCents: request.itemsSubtotalCents,
    commissionCents: request.commissionCents,
    estimatedTaxRateBps: request.estimatedTaxRateBps,
    estimatedTaxCents: request.estimatedTaxCents,
    effectiveTaxState: request.effectiveTaxState,
    intakeTotalCents: request.intakeTotalCents,
    intakePaidAt: request.intakePaidAt,
    itemsActualSubtotalCents: request.itemsActualSubtotalCents,
    actualTaxCents: request.actualTaxCents,
    shippingCostCents: request.shippingCostCents,
    parcelLengthIn: request.parcelLengthIn,
    parcelWidthIn: request.parcelWidthIn,
    parcelHeightIn: request.parcelHeightIn,
    parcelWeightOz: request.parcelWeightOz,
    shippingMethod: request.shippingMethod,
    freightRateCentsPerLb: request.freightRateCentsPerLb,
    shippingCalculatedCents: request.shippingCalculatedCents,
    followupAmountCents: request.followupAmountCents,
    carrier: request.carrier,
    trackingNumber: request.trackingNumber,
  };
}

// ---------------------------------------------------------------------------
// Formatting primitives
// ---------------------------------------------------------------------------

function formatUSD(cents: number | null | undefined, opts: { signed?: boolean } = {}): string {
  if (cents == null) return "—";
  // Sign goes BEFORE the $: `+$11.99`, `-$14.31`. Otherwise `$-14.31` reads
  // weirdly and confuses scan-readers.
  const sign = cents < 0 ? "-" : opts.signed && cents > 0 ? "+" : "";
  const value = (Math.abs(cents) / 100).toFixed(2);
  // Native US formatting with commas. Avoid Intl for a small dep cost.
  const [intPart, decPart] = value.split(".");
  const withCommas = (intPart ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${withCommas}.${decPart ?? "00"}`;
}

function formatPercent(bps: number): string {
  if (bps === 0) return "0%";
  // 2-decimal precision is enough; trim trailing zeros for clean reading.
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}

function formatDate(d: Date | null | undefined): string {
  if (!d) return "—";
  // YYYY-MM-DD HH:mm UTC — terse, monospace-friendly, no locale surprises.
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function formatWeightOz(oz: number | null | undefined): string {
  if (oz == null) return "—";
  if (oz >= 16) {
    const lb = oz / 16;
    return `${lb.toFixed(2).replace(/\.00$/, "")} lb (${oz.toFixed(1)} oz)`;
  }
  return `${oz.toFixed(1)} oz`;
}

function formatDims(d: ReceiptBreakdown): string {
  const { parcelLengthIn, parcelWidthIn, parcelHeightIn } = d;
  if (parcelLengthIn == null || parcelWidthIn == null || parcelHeightIn == null) {
    return "—";
  }
  const fmt = (n: number) => n.toFixed(1).replace(/\.0$/, "");
  return `${fmt(parcelLengthIn)} × ${fmt(parcelWidthIn)} × ${fmt(parcelHeightIn)} in`;
}

function formatStatus(status: string): string {
  return status.replace(/_/g, " ").toLowerCase();
}

function formatShippingMethod(m: string | null): string {
  if (!m) return "—";
  switch (m) {
    case "PLATFORM_FREIGHT":
      return "Platform freight";
    case "BUYER_FORWARDER":
      return "Buyer forwarder";
    case "PICKUP":
      return "Warehouse pickup";
    default:
      return m.replace(/_/g, " ").toLowerCase();
  }
}

/**
 * "1.52 lb × $4.50/lb = $6.84" — the human-readable freight calculation
 * shown under the Shipping line so the buyer sees how it was reached.
 *
 * Returns null when the inputs to the calc aren't all present (no
 * weight, no rate, or PICKUP @ $0). Caller decides whether to render
 * the line at all.
 */
function formatFreightCalc(d: ReceiptBreakdown): string | null {
  if (d.freightRateCentsPerLb == null || d.parcelWeightOz == null || d.parcelWeightOz <= 0) {
    return null;
  }
  const lb = d.parcelWeightOz / 16;
  // parseFloat drops trailing zeros without losing precision (1.50 → 1.5,
  // 1.25 → 1.25). A regex on toFixed only strips ".00", so 1.50 leaks
  // through and reads weirdly next to "$4.50/lb".
  const lbStr = parseFloat(lb.toFixed(2)).toString();
  const ratePerLbDollars = (d.freightRateCentsPerLb / 100).toFixed(2);
  return `${lbStr} lb × $${ratePerLbDollars}/lb`;
}

function escapeXml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function deriveLabelFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop() ?? u.host;
    return decodeURIComponent(last).replace(/[-_+]/g, " ").slice(0, 60) || u.host;
  } catch {
    return url.slice(0, 60);
  }
}

// ---------------------------------------------------------------------------
// Total computation — the line that answers "what have you paid so far?"
// ---------------------------------------------------------------------------

interface ComputedTotals {
  /** intake + (positive followup) — what buyer has been charged net. */
  totalChargedCents: number;
  /** Plain readable label of where the order is in the money lifecycle. */
  paymentStateLabel: string;
}

function computeTotals(d: ReceiptBreakdown): ComputedTotals {
  let charged = 0;
  if (d.intakePaidAt) charged += d.intakeTotalCents;
  if (d.followupAmountCents != null && d.followupAmountCents > 0) {
    charged += d.followupAmountCents;
  }
  // negative followup = refund, doesn't add to charged total

  let label: string;
  if (!d.intakePaidAt) {
    label = "Awaiting intake payment";
  } else if (d.followupAmountCents == null) {
    label = "Intake paid — procurement in progress";
  } else if (d.followupAmountCents > 0) {
    label = "Final payment outstanding";
  } else if (d.followupAmountCents < 0) {
    label = "Refund due to buyer";
  } else {
    label = "Settled — no follow-up needed";
  }
  return { totalChargedCents: charged, paymentStateLabel: label };
}

// ---------------------------------------------------------------------------
// Line items for both renders
// ---------------------------------------------------------------------------

interface RenderRow {
  label: string;
  amount: string;
  isMuted?: boolean;
  isStrong?: boolean;
  isDelta?: boolean;
}

function buildRows(d: ReceiptBreakdown): RenderRow[] {
  const rows: RenderRow[] = [];

  rows.push({
    label: "Items subtotal (estimate)",
    amount: formatUSD(d.itemsSubtotalCents),
  });
  rows.push({
    label: "Service commission",
    amount: formatUSD(d.commissionCents),
  });
  rows.push({
    label: `Estimated sales tax${d.effectiveTaxState ? ` (${d.effectiveTaxState} ${formatPercent(d.estimatedTaxRateBps)})` : ""}`,
    amount: formatUSD(d.estimatedTaxCents),
  });
  rows.push({
    label: "Intake total",
    amount: formatUSD(d.intakeTotalCents),
    isStrong: true,
  });

  // Reconciliation — only meaningful once any actual is set.
  const hasActuals =
    d.itemsActualSubtotalCents != null ||
    d.actualTaxCents != null ||
    d.shippingCostCents != null;

  if (hasActuals) {
    rows.push({ label: "— Reconciliation —", amount: "", isMuted: true });
    rows.push({
      label: "Items subtotal (actual)",
      amount: formatUSD(d.itemsActualSubtotalCents),
    });
    rows.push({
      label: "Sales tax (actual)",
      amount: formatUSD(d.actualTaxCents),
    });

    // Freight: method + system calc + override delta. Three possible
    // shapes:
    //   (a) PICKUP / no freight data    → single "Shipping cost" row
    //   (b) Auto-calculated, no override → method + "weight × rate" subline
    //   (c) Override                     → also show system calc + delta
    const calcText = formatFreightCalc(d);
    const methodLabel = d.shippingMethod ? `Shipping (${formatShippingMethod(d.shippingMethod)})` : "Shipping cost";
    rows.push({
      label: methodLabel,
      amount: formatUSD(d.shippingCostCents),
    });
    if (calcText) {
      rows.push({
        label: `   ${calcText}`,
        amount: formatUSD(d.shippingCalculatedCents),
        isMuted: true,
      });
      // Override surfacing — only when the operator-charged number
      // differs from the system calc by more than rounding noise.
      if (
        d.shippingCalculatedCents != null &&
        d.shippingCostCents != null &&
        Math.abs(d.shippingCalculatedCents - d.shippingCostCents) > 1
      ) {
        const delta = d.shippingCostCents - d.shippingCalculatedCents;
        rows.push({
          label: "   Operator adjustment",
          amount: formatUSD(delta, { signed: true }),
          isMuted: true,
        });
      }
    }
  }

  if (d.followupAmountCents != null) {
    rows.push({
      label: d.followupAmountCents > 0
        ? "Follow-up due (you pay)"
        : d.followupAmountCents < 0
          ? "Follow-up refund (we refund)"
          : "Follow-up settled",
      amount: formatUSD(d.followupAmountCents, { signed: true }),
      isStrong: true,
      isDelta: true,
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// HTML renderer — styled table block. Slot this INSIDE an existing email's
// body via `buildReceiptHtmlBlock()`. Self-contained inline styles only.
// ---------------------------------------------------------------------------

export function buildReceiptHtmlBlock(d: ReceiptBreakdown): string {
  const rows = buildRows(d);
  const totals = computeTotals(d);

  const lineRowsHtml = d.lines
    .map((ln) => {
      const est = formatUSD(ln.estimatedUnitPriceCents * ln.quantity);
      const act = ln.actualUnitPriceCents != null
        ? formatUSD(ln.actualUnitPriceCents * ln.quantity)
        : "—";
      const status = ln.status
        ? `<span style="color:#777270;font-size:11px;text-transform:uppercase;letter-spacing:1px;">${escapeXml(ln.status)}</span>`
        : "";
      return `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #E2DFD7;font-size:13px;color:#0A0A0A;">
          ${escapeXml(ln.label)} <span style="color:#777270;">× ${ln.quantity}</span> ${status}
        </td>
        <td style="padding:8px 12px;border-bottom:1px solid #E2DFD7;font-size:13px;text-align:right;color:#3A3A3A;">${est}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #E2DFD7;font-size:13px;text-align:right;color:#0A0A0A;">${act}</td>
      </tr>`;
    })
    .join("");

  const sumRowsHtml = rows
    .map((row) => {
      const labelStyle = [
        "padding:6px 12px",
        "font-size:13px",
        row.isMuted
          ? "color:#9C9892;text-transform:uppercase;letter-spacing:1.4px;font-size:11px;border-top:1px solid #E2DFD7;padding-top:14px;"
          : row.isStrong
            ? "color:#0A0A0A;font-weight:600;border-top:1px solid #E2DFD7;padding-top:10px;"
            : "color:#3A3A3A",
      ].join(";");
      const amountStyle = [
        "padding:6px 12px",
        "font-size:13px",
        "text-align:right",
        "font-family:'JetBrains Mono',monospace",
        row.isStrong ? "color:#0A0A0A;font-weight:600;" : "color:#3A3A3A",
        row.isDelta && row.amount.startsWith("+") ? "color:#9A4F2A;" : "",
        row.isDelta && row.amount.startsWith("-$") ? "color:#3A6F4D;" : "",
      ].join(";");
      return `<tr><td style="${labelStyle}">${escapeXml(row.label)}</td><td style="${amountStyle}">${escapeXml(row.amount)}</td></tr>`;
    })
    .join("");

  const parcelHtml =
    d.parcelLengthIn != null || d.parcelWidthIn != null || d.parcelHeightIn != null || d.parcelWeightOz != null
      ? `<tr>
          <td colspan="2" style="padding:14px 12px 6px 12px;font-size:11px;color:#9C9892;text-transform:uppercase;letter-spacing:1.4px;border-top:1px solid #E2DFD7;">Parcel</td>
        </tr>
        <tr>
          <td style="padding:6px 12px;font-size:13px;color:#3A3A3A;">Dimensions</td>
          <td style="padding:6px 12px;font-size:13px;text-align:right;color:#3A3A3A;font-family:'JetBrains Mono',monospace;">${escapeXml(formatDims(d))}</td>
        </tr>
        <tr>
          <td style="padding:6px 12px;font-size:13px;color:#3A3A3A;">Total weight</td>
          <td style="padding:6px 12px;font-size:13px;text-align:right;color:#3A3A3A;font-family:'JetBrains Mono',monospace;">${escapeXml(formatWeightOz(d.parcelWeightOz))}</td>
        </tr>`
      : "";

  const trackingHtml =
    d.carrier && d.trackingNumber
      ? `<tr>
          <td style="padding:14px 12px 6px 12px;font-size:11px;color:#9C9892;text-transform:uppercase;letter-spacing:1.4px;border-top:1px solid #E2DFD7;">Carrier</td>
          <td style="padding:14px 12px 6px 12px;font-size:13px;text-align:right;color:#3A3A3A;border-top:1px solid #E2DFD7;">${escapeXml(d.carrier)}</td>
        </tr>
        <tr>
          <td style="padding:6px 12px;font-size:13px;color:#3A3A3A;">Tracking</td>
          <td style="padding:6px 12px;font-size:13px;text-align:right;color:#0A0A0A;font-family:'JetBrains Mono',monospace;">${escapeXml(d.trackingNumber)}</td>
        </tr>`
      : "";

  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;background:#FFFFFF;border:1px solid #E2DFD7;margin:16px 0;">
    <tr>
      <td colspan="2" style="padding:16px 12px;border-bottom:1px solid #E2DFD7;background:#F1EFE9;">
        <div style="font-family:'JetBrains Mono',monospace;font-size:11px;color:#777270;letter-spacing:1.6px;text-transform:uppercase;">Receipt · ${escapeXml(d.reference)}</div>
        <div style="margin-top:4px;font-size:13px;color:#3A3A3A;">${escapeXml(formatStatus(d.status))} · ${escapeXml(formatDate(d.createdAt))}</div>
        <div style="margin-top:4px;font-size:12px;color:#777270;">${escapeXml(totals.paymentStateLabel)}</div>
      </td>
    </tr>
    <tr>
      <th style="padding:10px 12px;font-size:11px;color:#9C9892;text-transform:uppercase;letter-spacing:1.4px;text-align:left;border-bottom:1px solid #E2DFD7;">Item</th>
      <th style="padding:10px 12px;font-size:11px;color:#9C9892;text-transform:uppercase;letter-spacing:1.4px;text-align:right;border-bottom:1px solid #E2DFD7;">Estimate</th>
      <th style="padding:10px 12px;font-size:11px;color:#9C9892;text-transform:uppercase;letter-spacing:1.4px;text-align:right;border-bottom:1px solid #E2DFD7;">Actual</th>
    </tr>
    ${lineRowsHtml}
    <tr><td colspan="3" style="padding:0;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
        ${sumRowsHtml}
        ${parcelHtml}
        ${trackingHtml}
        <tr>
          <td style="padding:14px 12px;font-size:13px;color:#0A0A0A;font-weight:600;border-top:2px solid #0A0A0A;">Total charged to date</td>
          <td style="padding:14px 12px;font-size:13px;text-align:right;font-family:'JetBrains Mono',monospace;color:#0A0A0A;font-weight:600;border-top:2px solid #0A0A0A;">${escapeXml(formatUSD(totals.totalChargedCents))}</td>
        </tr>
      </table>
    </td></tr>
  </table>`;
}

// ---------------------------------------------------------------------------
// Plain-text renderer
// ---------------------------------------------------------------------------

export function buildReceiptText(d: ReceiptBreakdown): string {
  const totals = computeTotals(d);
  const out: string[] = [];
  out.push(`RECEIPT · ${d.reference}`);
  if (d.parentReference) out.push(`Addition to ${d.parentReference}`);
  out.push(`Status: ${formatStatus(d.status)}`);
  out.push(`Created: ${formatDate(d.createdAt)}`);
  out.push(`Buyer: ${d.buyerName ?? "—"} <${d.buyerEmail}>`);
  out.push("");
  out.push("ITEMS");
  out.push("-----");
  for (const ln of d.lines) {
    const est = formatUSD(ln.estimatedUnitPriceCents * ln.quantity);
    const act =
      ln.actualUnitPriceCents != null
        ? formatUSD(ln.actualUnitPriceCents * ln.quantity)
        : "—";
    const status = ln.status ? ` [${ln.status}]` : "";
    out.push(`  ${ln.label} × ${ln.quantity}${status}`);
    out.push(`    estimate ${est}   actual ${act}`);
  }
  out.push("");
  out.push("BREAKDOWN");
  out.push("---------");
  for (const r of buildRows(d)) {
    if (r.isMuted && r.amount === "") {
      // Section divider — blank line + label only, no money column.
      out.push("");
      out.push(r.label);
      continue;
    }
    // Everything else (regular rows + muted sub-lines like the freight
    // breakdown and operator-adjustment rows) prints the amount too.
    out.push(`  ${r.label.padEnd(38, " ")} ${r.amount}`);
  }
  if (
    d.parcelLengthIn != null ||
    d.parcelWidthIn != null ||
    d.parcelHeightIn != null ||
    d.parcelWeightOz != null
  ) {
    out.push("");
    out.push("PARCEL");
    out.push("------");
    out.push(`  Dimensions      ${formatDims(d)}`);
    out.push(`  Total weight    ${formatWeightOz(d.parcelWeightOz)}`);
  }
  if (d.carrier && d.trackingNumber) {
    out.push("");
    out.push("SHIPMENT");
    out.push("--------");
    out.push(`  Carrier         ${d.carrier}`);
    out.push(`  Tracking        ${d.trackingNumber}`);
  }
  out.push("");
  out.push(`TOTAL CHARGED TO DATE  ${formatUSD(totals.totalChargedCents)}`);
  out.push(`(${totals.paymentStateLabel})`);
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// SVG renderer — self-contained, no external fonts/scripts. Designed
// to render at ~640px wide; viewBox lets clients scale to 2× retina
// without blur. Used for the chat-thread attachment.
// ---------------------------------------------------------------------------

export function buildReceiptSvg(d: ReceiptBreakdown): string {
  const rows = buildRows(d);
  const totals = computeTotals(d);

  // Column geometry. Width in user units; ratio between cols hand-tuned
  // for the longest line label in production fixtures.
  const W = 640;
  const PAD = 28;
  const TITLE_BAR_H = 78;

  // Per-line row height for the items table
  const ITEM_ROW_H = 30;
  const ITEMS_HEADER_H = 26;

  const itemsBlockH = ITEMS_HEADER_H + ITEM_ROW_H * d.lines.length;

  const SUM_ROW_H = 24;
  const sumBlockH = SUM_ROW_H * rows.length + 14;

  const parcelRows =
    (d.parcelLengthIn != null || d.parcelWidthIn != null || d.parcelHeightIn != null || d.parcelWeightOz != null
      ? 3
      : 0) +
    (d.carrier && d.trackingNumber ? 3 : 0);
  const parcelBlockH = parcelRows * SUM_ROW_H;

  const TOTAL_BAR_H = 50;
  const FOOTER_H = 20;

  const H = TITLE_BAR_H + 16 + itemsBlockH + 16 + sumBlockH + parcelBlockH + 12 + TOTAL_BAR_H + FOOTER_H + PAD;

  // Helpers
  const text = (
    x: number,
    y: number,
    content: string,
    opts: {
      anchor?: "start" | "end" | "middle";
      size?: number;
      color?: string;
      family?: "sans" | "mono";
      weight?: "normal" | "600";
      letterSpacing?: number;
      transform?: string;
    } = {},
  ) => {
    const family =
      opts.family === "mono"
        ? "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace"
        : "system-ui, -apple-system, 'Inter Tight', Helvetica, Arial, sans-serif";
    const attrs = [
      `x="${x}"`,
      `y="${y}"`,
      `font-family="${family}"`,
      `font-size="${opts.size ?? 13}"`,
      `fill="${opts.color ?? "#0A0A0A"}"`,
      opts.weight ? `font-weight="${opts.weight}"` : "",
      opts.anchor ? `text-anchor="${opts.anchor}"` : "",
      opts.letterSpacing ? `letter-spacing="${opts.letterSpacing}"` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return `<text ${attrs}>${escapeXml(content)}</text>`;
  };

  const rect = (x: number, y: number, w: number, h: number, fill: string, stroke?: string) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${stroke ? ` stroke="${stroke}"` : ""}/>`;

  const line = (x1: number, y1: number, x2: number, y2: number, stroke = "#E2DFD7", w = 1) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${w}"/>`;

  // Build SVG body
  const parts: string[] = [];

  // Background
  parts.push(rect(0, 0, W, H, "#FFFFFF"));

  // Title bar
  parts.push(rect(0, 0, W, TITLE_BAR_H, "#F1EFE9"));
  parts.push(line(0, TITLE_BAR_H, W, TITLE_BAR_H));
  parts.push(
    text(PAD, 28, `RECEIPT · ${d.reference}`, {
      family: "mono",
      size: 11,
      color: "#777270",
      letterSpacing: 1.6,
    }),
  );
  if (d.parentReference) {
    parts.push(
      text(W - PAD, 28, `addition to ${d.parentReference}`, {
        family: "mono",
        size: 11,
        color: "#777270",
        letterSpacing: 1.4,
        anchor: "end",
      }),
    );
  }
  parts.push(text(PAD, 50, `${formatStatus(d.status)} · ${formatDate(d.createdAt)}`, { size: 13, color: "#3A3A3A" }));
  parts.push(text(PAD, 68, totals.paymentStateLabel, { size: 12, color: "#777270" }));

  // Items header
  let cursorY = TITLE_BAR_H + 16;
  parts.push(
    text(PAD, cursorY + 16, "ITEM", {
      size: 10,
      color: "#9C9892",
      letterSpacing: 1.4,
    }),
  );
  parts.push(
    text(W - 220, cursorY + 16, "ESTIMATE", {
      size: 10,
      color: "#9C9892",
      letterSpacing: 1.4,
      anchor: "end",
    }),
  );
  parts.push(
    text(W - PAD, cursorY + 16, "ACTUAL", {
      size: 10,
      color: "#9C9892",
      letterSpacing: 1.4,
      anchor: "end",
    }),
  );
  parts.push(line(PAD, cursorY + ITEMS_HEADER_H - 2, W - PAD, cursorY + ITEMS_HEADER_H - 2));

  cursorY += ITEMS_HEADER_H;
  for (const ln of d.lines) {
    const labelText = `${truncate(ln.label, 42)}  × ${ln.quantity}${ln.status ? `  [${ln.status}]` : ""}`;
    parts.push(text(PAD, cursorY + 18, labelText, { size: 13, color: "#0A0A0A" }));
    parts.push(
      text(W - 220, cursorY + 18, formatUSD(ln.estimatedUnitPriceCents * ln.quantity), {
        size: 13,
        color: "#3A3A3A",
        family: "mono",
        anchor: "end",
      }),
    );
    parts.push(
      text(
        W - PAD,
        cursorY + 18,
        ln.actualUnitPriceCents != null ? formatUSD(ln.actualUnitPriceCents * ln.quantity) : "—",
        { size: 13, color: "#0A0A0A", family: "mono", anchor: "end" },
      ),
    );
    parts.push(line(PAD, cursorY + ITEM_ROW_H, W - PAD, cursorY + ITEM_ROW_H));
    cursorY += ITEM_ROW_H;
  }

  cursorY += 16;
  // Sum rows
  for (const r of rows) {
    if (r.isMuted) {
      parts.push(
        text(PAD, cursorY + 16, r.label, {
          size: 10,
          color: "#9C9892",
          letterSpacing: 1.4,
        }),
      );
      cursorY += SUM_ROW_H;
      continue;
    }
    if (r.isStrong) {
      parts.push(line(PAD, cursorY, W - PAD, cursorY));
    }
    const lblColor = r.isStrong ? "#0A0A0A" : "#3A3A3A";
    let amtColor = r.isStrong ? "#0A0A0A" : "#3A3A3A";
    if (r.isDelta && r.amount.startsWith("+")) amtColor = "#9A4F2A";
    if (r.isDelta && r.amount.startsWith("-$")) amtColor = "#3A6F4D";
    parts.push(text(PAD, cursorY + 16, r.label, { size: 13, color: lblColor, weight: r.isStrong ? "600" : "normal" }));
    parts.push(
      text(W - PAD, cursorY + 16, r.amount, {
        size: 13,
        color: amtColor,
        family: "mono",
        anchor: "end",
        weight: r.isStrong ? "600" : "normal",
      }),
    );
    cursorY += SUM_ROW_H;
  }

  // Parcel block
  if (
    d.parcelLengthIn != null ||
    d.parcelWidthIn != null ||
    d.parcelHeightIn != null ||
    d.parcelWeightOz != null
  ) {
    parts.push(line(PAD, cursorY, W - PAD, cursorY));
    parts.push(
      text(PAD, cursorY + 16, "PARCEL", {
        size: 10,
        color: "#9C9892",
        letterSpacing: 1.4,
      }),
    );
    cursorY += SUM_ROW_H;
    parts.push(text(PAD, cursorY + 16, "Dimensions", { size: 13, color: "#3A3A3A" }));
    parts.push(
      text(W - PAD, cursorY + 16, formatDims(d), {
        size: 13,
        color: "#3A3A3A",
        family: "mono",
        anchor: "end",
      }),
    );
    cursorY += SUM_ROW_H;
    parts.push(text(PAD, cursorY + 16, "Total weight", { size: 13, color: "#3A3A3A" }));
    parts.push(
      text(W - PAD, cursorY + 16, formatWeightOz(d.parcelWeightOz), {
        size: 13,
        color: "#3A3A3A",
        family: "mono",
        anchor: "end",
      }),
    );
    cursorY += SUM_ROW_H;
  }

  if (d.carrier && d.trackingNumber) {
    parts.push(line(PAD, cursorY, W - PAD, cursorY));
    parts.push(
      text(PAD, cursorY + 16, "CARRIER", {
        size: 10,
        color: "#9C9892",
        letterSpacing: 1.4,
      }),
    );
    parts.push(text(W - PAD, cursorY + 16, d.carrier, { size: 13, color: "#3A3A3A", anchor: "end" }));
    cursorY += SUM_ROW_H;
    parts.push(text(PAD, cursorY + 16, "Tracking", { size: 13, color: "#3A3A3A" }));
    parts.push(
      text(W - PAD, cursorY + 16, d.trackingNumber, {
        size: 13,
        color: "#0A0A0A",
        family: "mono",
        anchor: "end",
      }),
    );
    cursorY += SUM_ROW_H;
  }

  // Total bar
  cursorY += 12;
  parts.push(rect(0, cursorY, W, TOTAL_BAR_H, "#0A0A0A"));
  parts.push(
    text(PAD, cursorY + 30, "TOTAL CHARGED TO DATE", {
      size: 12,
      color: "#FFFFFF",
      letterSpacing: 1.4,
    }),
  );
  parts.push(
    text(W - PAD, cursorY + 30, formatUSD(totals.totalChargedCents), {
      size: 16,
      color: "#FFFFFF",
      family: "mono",
      anchor: "end",
      weight: "600",
    }),
  );
  cursorY += TOTAL_BAR_H;

  // Footer
  parts.push(
    text(PAD, cursorY + 14, "USA Errands · Personal Shopper", {
      size: 10,
      color: "#9C9892",
      letterSpacing: 1.4,
    }),
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  ${parts.join("\n  ")}
</svg>`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
