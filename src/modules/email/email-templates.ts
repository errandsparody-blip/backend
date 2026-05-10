/**
 * Email templates — pure functions returning { subject, html, text }.
 *
 * Implementation Plan §6.8.
 *
 * The HTML uses table-based layout (the only layout primitive that survives
 * every email client) and inlined styles in LEDGR colours:
 *
 *   cream   #F1EFE9   page background
 *   ink     #0A0A0A   primary text
 *   amber   #C99428   single-CTA accent
 *
 * Every template MUST include a plain-text twin so screen readers and
 * spam-filters get a clean copy. Every URL goes through encodeURIComponent
 * for query params; no raw user input lands in HTML attributes.
 */

import { loadConfig } from "../../common/config";

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const cfg = loadConfig();

// ---------------------------------------------------------------------------
// Shared HTML chrome — header, container, footer, single-button CTA.
// ---------------------------------------------------------------------------

function escape(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function shell(args: { eyebrow: string; title: string; bodyHtml: string; cta?: { label: string; href: string } }): string {
  const cta = args.cta
    ? `
      <tr>
        <td style="padding:24px 32px 8px 32px;">
          <a href="${escape(args.cta.href)}"
             style="display:inline-block;padding:12px 24px;background:#C99428;color:#0A0A0A;text-decoration:none;font-family:'Inter Tight',Helvetica,Arial,sans-serif;font-weight:600;font-size:13px;letter-spacing:1.5px;text-transform:uppercase;border-radius:4px;">
            ${escape(args.cta.label)}
          </a>
        </td>
      </tr>`
    : "";

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escape(args.title)}</title></head>
<body style="margin:0;padding:0;background:#F1EFE9;font-family:'Inter Tight',Helvetica,Arial,sans-serif;color:#0A0A0A;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#F1EFE9;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="background:#FFFFFF;border:1px solid #E2DFD7;">
          <tr>
            <td style="padding:24px 32px;border-bottom:1px solid #E2DFD7;">
              <div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:1.6px;text-transform:uppercase;color:#777270;">USA ERRANDS</div>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 32px 0 32px;">
              <div style="font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:1.6px;text-transform:uppercase;color:#777270;margin-bottom:8px;">${escape(args.eyebrow)}</div>
              <h1 style="margin:0 0 16px 0;font-size:24px;font-weight:600;line-height:1.3;color:#0A0A0A;">${escape(args.title)}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 16px 32px;font-size:15px;line-height:1.6;color:#3A3A3A;">
              ${args.bodyHtml}
            </td>
          </tr>
          ${cta}
          <tr>
            <td style="padding:24px 32px;border-top:1px solid #E2DFD7;font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:1.4px;text-transform:uppercase;color:#9C9892;">
              You're receiving this because you have a USA Errands account.
              Reply to <a href="mailto:${escape(cfg.EMAIL_REPLY_TO)}" style="color:#9C9892;text-decoration:underline;">${escape(cfg.EMAIL_REPLY_TO)}</a> for help.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export function emailVerifyTemplate(args: { email: string; code: string }): RenderedEmail {
  // Render the 6-digit code as a large, monospaced, easy-to-copy block. We
  // render it as plain text inside a styled div so it survives every email
  // client — Gmail, Outlook, native iOS Mail. No clickable link to mangle.
  const codeBlock = `
    <div style="margin:8px 0 16px 0;padding:20px 24px;background:#F1EFE9;border:1px solid #E2DFD7;border-radius:6px;text-align:center;">
      <div style="font-family:'JetBrains Mono',Menlo,Consolas,monospace;font-size:32px;font-weight:600;letter-spacing:8px;color:#0A0A0A;">${escape(args.code)}</div>
    </div>`;

  return {
    subject: `${args.code} is your USA Errands verification code`,
    html: shell({
      eyebrow: "[01] Verify your email",
      title: "Your verification code",
      bodyHtml: `<p style="margin:0 0 12px 0;">Enter this code on the verification screen to confirm <strong>${escape(args.email)}</strong>.</p>
        ${codeBlock}
        <p style="margin:0 0 12px 0;color:#9C9892;font-size:13px;">The code expires in 15 minutes and only works once.</p>
        <p style="margin:0 0 12px 0;color:#9C9892;font-size:13px;">If you didn't sign up, ignore this email — your address won't be added.</p>`,
    }),
    text:
      `Your USA Errands verification code\n\n` +
      `Enter this code on the verification screen to confirm ${args.email}:\n\n` +
      `    ${args.code}\n\n` +
      `The code expires in 15 minutes and only works once.\n\n` +
      `If you didn't sign up, ignore this email.`,
  };
}

export function passwordResetTemplate(args: { email: string; resetUrl: string }): RenderedEmail {
  return {
    subject: "Reset your USA Errands password",
    html: shell({
      eyebrow: "[01] Password reset",
      title: "Reset your password",
      bodyHtml: `<p style="margin:0 0 12px 0;">We received a password reset request for <strong>${escape(args.email)}</strong>.</p>
        <p style="margin:0 0 12px 0;">The link expires in 60 minutes and only works once. If you didn't request a reset, ignore this email; your password won't change.</p>`,
      cta: { label: "Reset password", href: args.resetUrl },
    }),
    text:
      `Reset your USA Errands password\n\n` +
      `We received a password reset request for ${args.email}. Open this link within 60 minutes:\n${args.resetUrl}\n\n` +
      `If you didn't request a reset, ignore this email.`,
  };
}

/**
 * Sent when someone tries to sign up with an email that already has an
 * account. The signup endpoint returns a generic success in that case — we
 * never confirm/deny existence to the caller — but the legitimate owner of
 * the inbox needs a useful next step. This email gives them one.
 */
export function existingAccountReminderTemplate(args: { email: string }): RenderedEmail {
  return {
    subject: "You already have a USA Errands account",
    html: shell({
      eyebrow: "[01] Account exists",
      title: "Looks like you've been here before",
      bodyHtml: `<p style="margin:0 0 12px 0;">Someone — probably you — just tried to sign up using <strong>${escape(args.email)}</strong>. There's already an account with this email.</p>
        <p style="margin:0 0 12px 0;">Sign in below to pick up where you left off, or reset your password if you've forgotten it.</p>
        <p style="margin:0 0 12px 0;color:#9C9892;font-size:13px;">If this wasn't you, no action is needed — your account hasn't changed.</p>`,
      cta: { label: "Sign in", href: `${cfg.WEB_PUBLIC_URL}/login` },
    }),
    text:
      `You already have a USA Errands account\n\n` +
      `Someone tried to sign up using ${args.email}. There's already an account with this email.\n` +
      `Sign in here: ${cfg.WEB_PUBLIC_URL}/login\n` +
      `Forgot your password? Reset it: ${cfg.WEB_PUBLIC_URL}/forgot-password\n\n` +
      `If this wasn't you, no action is needed.`,
  };
}

export function mfaEnrolledTemplate(args: { email: string }): RenderedEmail {
  return {
    subject: "Two-factor authentication is on",
    html: shell({
      eyebrow: "[01] MFA enrolled",
      title: "Your account is protected by 2FA",
      bodyHtml: `<p style="margin:0 0 12px 0;">Two-factor authentication has been turned on for <strong>${escape(args.email)}</strong>.</p>
        <p style="margin:0 0 12px 0;">If you didn't do this, sign in now and remove the device, then change your password.</p>`,
      cta: { label: "Open account settings", href: `${cfg.WEB_PUBLIC_URL}/settings/security` },
    }),
    text:
      `Two-factor authentication is on\n\n` +
      `2FA was just enabled for ${args.email}. If you didn't do this, sign in now ` +
      `and remove the device, then change your password.\n${cfg.WEB_PUBLIC_URL}/settings/security`,
  };
}

// ---------------------------------------------------------------------------
// Vendor lifecycle
// ---------------------------------------------------------------------------

export function kycApprovedTemplate(args: { businessName: string }): RenderedEmail {
  return {
    subject: "KYC approved — you're good to ship",
    html: shell({
      eyebrow: "[02] KYC approved",
      title: `${args.businessName} is verified`,
      bodyHtml: `<p style="margin:0 0 12px 0;">Your KYC review is complete. Once you accept the vendor agreement, your account becomes active and you can submit your first PSN.</p>`,
      cta: { label: "Go to dashboard", href: `${cfg.WEB_PUBLIC_URL}/` },
    }),
    text:
      `KYC approved — you're good to ship\n\n` +
      `Your KYC review is complete. Accept the vendor agreement and you can submit your first PSN.\n` +
      `${cfg.WEB_PUBLIC_URL}/`,
  };
}

export function kycResubmissionTemplate(args: {
  businessName: string;
  reason: string;
}): RenderedEmail {
  return {
    subject: "Action needed: KYC resubmission requested",
    html: shell({
      eyebrow: "[02] KYC resubmission",
      title: `Quick fixes needed for ${args.businessName}`,
      bodyHtml: `<p style="margin:0 0 12px 0;">Our review team needs a few details corrected before we can finish verifying your account.</p>
        <div style="margin:8px 0 16px 0;padding:14px 18px;background:#F1EFE9;border-left:3px solid #C99428;color:#0A0A0A;font-size:14px;line-height:1.55;">
          ${escape(args.reason)}
        </div>
        <p style="margin:0 0 12px 0;color:#9C9892;font-size:13px;">Update your settings, then we'll re-review automatically — no need to email us back.</p>`,
      cta: { label: "Update settings", href: `${cfg.WEB_PUBLIC_URL}/settings` },
    }),
    text:
      `Action needed: KYC resubmission requested\n\n` +
      `${args.businessName} — our review team needs a few details corrected before we can finish verifying your account:\n\n` +
      `${args.reason}\n\n` +
      `Update your settings here: ${cfg.WEB_PUBLIC_URL}/settings\n` +
      `We'll re-review once you've made the changes.`,
  };
}

export function kycRejectedTemplate(args: {
  businessName: string;
  reason: string;
}): RenderedEmail {
  return {
    subject: "KYC review outcome",
    html: shell({
      eyebrow: "[02] KYC declined",
      title: "We weren't able to verify your account",
      bodyHtml: `<p style="margin:0 0 12px 0;">Hi ${escape(args.businessName)} — we've finished reviewing the information you provided and can't proceed with onboarding right now.</p>
        <div style="margin:8px 0 16px 0;padding:14px 18px;background:#F1EFE9;border-left:3px solid #C0392B;color:#0A0A0A;font-size:14px;line-height:1.55;">
          ${escape(args.reason)}
        </div>
        <p style="margin:0 0 12px 0;">If you believe this was a mistake or you have additional documentation that addresses the concern, reply to this email and we'll take another look.</p>
        <p style="margin:0 0 12px 0;color:#9C9892;font-size:13px;">No further action is needed; your account is now closed and no charges have been made.</p>`,
    }),
    text:
      `KYC review outcome\n\n` +
      `Hi ${args.businessName} — we've finished reviewing the information you provided and can't proceed with onboarding right now.\n\n` +
      `${args.reason}\n\n` +
      `If you believe this was a mistake or have additional documentation that addresses the concern, reply to this email and we'll take another look.\n\n` +
      `No further action is needed; your account is now closed and no charges have been made.`,
  };
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

export function lowBalanceTemplate(args: { businessName: string; balanceCents: number; thresholdCents: number }): RenderedEmail {
  const balance = `$${(args.balanceCents / 100).toFixed(2)}`;
  const threshold = `$${(args.thresholdCents / 100).toFixed(2)}`;
  return {
    subject: `Wallet balance low — ${balance}`,
    html: shell({
      eyebrow: "[03] Wallet alert",
      title: "Your wallet balance is low",
      bodyHtml: `<p style="margin:0 0 12px 0;">${escape(args.businessName)}'s balance is <strong>${balance}</strong>, at or below your alert threshold of ${threshold}.</p>
        <p style="margin:0 0 12px 0;">Add funds to keep fulfillments running. New orders will fail with insufficient funds at $0.</p>`,
      cta: { label: "Add funds", href: `${cfg.WEB_PUBLIC_URL}/wallet/fund` },
    }),
    text:
      `Wallet balance low — ${balance}\n\n` +
      `${args.businessName}'s balance is ${balance}, at or below your alert threshold of ${threshold}.\n\n` +
      `Add funds: ${cfg.WEB_PUBLIC_URL}/wallet/fund`,
  };
}

export function depositReceiptTemplate(args: { amountCents: number; balanceAfterCents: number; reference: string }): RenderedEmail {
  const amount = `$${(args.amountCents / 100).toFixed(2)}`;
  const balance = `$${(args.balanceAfterCents / 100).toFixed(2)}`;
  return {
    subject: `Deposit received — ${amount}`,
    html: shell({
      eyebrow: "[03] Wallet receipt",
      title: `${amount} added to your wallet`,
      bodyHtml: `<p style="margin:0 0 12px 0;">Your deposit of <strong>${amount}</strong> has cleared. New balance: <strong>${balance}</strong>.</p>
        <p style="margin:0 0 12px 0;font-family:'JetBrains Mono',monospace;font-size:13px;color:#777270;">Reference: ${escape(args.reference)}</p>`,
      cta: { label: "Open wallet", href: `${cfg.WEB_PUBLIC_URL}/wallet` },
    }),
    text:
      `Deposit received — ${amount}\n\n` +
      `Your deposit of ${amount} has cleared. New balance: ${balance}.\n` +
      `Reference: ${args.reference}\n\n` +
      `Open wallet: ${cfg.WEB_PUBLIC_URL}/wallet`,
  };
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export function orderShippedTemplate(args: { orderRef: string; carrier: string; trackingNumber: string; orderId: string }): RenderedEmail {
  return {
    subject: `Order ${args.orderRef} shipped`,
    html: shell({
      eyebrow: "[05] Order shipped",
      title: `Order ${args.orderRef} is on its way`,
      bodyHtml: `<p style="margin:0 0 12px 0;">${escape(args.carrier)} picked it up. Tracking number:</p>
        <p style="margin:0 0 12px 0;font-family:'JetBrains Mono',monospace;font-size:14px;color:#0A0A0A;">${escape(args.trackingNumber)}</p>`,
      cta: { label: "View order", href: `${cfg.WEB_PUBLIC_URL}/orders/${encodeURIComponent(args.orderId)}` },
    }),
    text:
      `Order ${args.orderRef} shipped\n\n` +
      `${args.carrier} picked it up. Tracking: ${args.trackingNumber}\n\n` +
      `View order: ${cfg.WEB_PUBLIC_URL}/orders/${args.orderId}`,
  };
}

export function orderDeliveredTemplate(args: { orderRef: string; orderId: string }): RenderedEmail {
  return {
    subject: `Order ${args.orderRef} delivered`,
    html: shell({
      eyebrow: "[05] Order delivered",
      title: `Order ${args.orderRef} was delivered`,
      bodyHtml: `<p style="margin:0 0 12px 0;">The carrier marked the package delivered. If your customer reports they didn't receive it, open a return within 30 days.</p>`,
      cta: { label: "View order", href: `${cfg.WEB_PUBLIC_URL}/orders/${encodeURIComponent(args.orderId)}` },
    }),
    text:
      `Order ${args.orderRef} delivered\n\n` +
      `The carrier marked the package delivered.\n\n` +
      `View order: ${cfg.WEB_PUBLIC_URL}/orders/${args.orderId}`,
  };
}

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

export function teamInviteTemplate(args: { businessName: string; inviterEmail: string; acceptUrl: string }): RenderedEmail {
  return {
    subject: `Join ${args.businessName} on USA Errands`,
    html: shell({
      eyebrow: "[07] Team invitation",
      title: `${escape(args.businessName)} invited you to USA Errands`,
      bodyHtml: `<p style="margin:0 0 12px 0;"><strong>${escape(args.inviterEmail)}</strong> added you as a sub-user. Accept the invite to set a password and enrol two-factor authentication.</p>
        <p style="margin:0 0 12px 0;color:#9C9892;font-size:13px;">The link expires in 24 hours and only works once.</p>`,
      cta: { label: "Accept invite", href: args.acceptUrl },
    }),
    text:
      `${args.businessName} invited you to USA Errands\n\n` +
      `${args.inviterEmail} added you as a sub-user. Open this link within 24 hours:\n${args.acceptUrl}\n\n` +
      `If you weren't expecting this, ignore the email.`,
  };
}

// ---------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------

export function returnAuthorizedTemplate(args: { rmaCode: string; orderRef: string; trackingNumber: string | null }): RenderedEmail {
  return {
    subject: `Return ${args.rmaCode} authorised`,
    html: shell({
      eyebrow: "[06] Return authorised",
      title: `RMA ${args.rmaCode} is open`,
      bodyHtml: `<p style="margin:0 0 12px 0;">A return against order <strong>${escape(args.orderRef)}</strong> is now authorised.</p>
        ${args.trackingNumber ? `<p style="margin:0 0 12px 0;">Inbound tracking: <span style="font-family:'JetBrains Mono',monospace;">${escape(args.trackingNumber)}</span></p>` : ""}
        <p style="margin:0 0 12px 0;">When the package arrives at our warehouse we'll inspect and refund the agreed amount to your wallet.</p>`,
      cta: { label: "Track return", href: `${cfg.WEB_PUBLIC_URL}/returns` },
    }),
    text:
      `Return ${args.rmaCode} authorised\n\n` +
      `A return against order ${args.orderRef} is now authorised.\n` +
      (args.trackingNumber ? `Inbound tracking: ${args.trackingNumber}\n` : "") +
      `\nTrack: ${cfg.WEB_PUBLIC_URL}/returns`,
  };
}

export function returnRefundedTemplate(args: { rmaCode: string; netRefundCents: number; balanceAfterCents: number }): RenderedEmail {
  const refund = `$${(args.netRefundCents / 100).toFixed(2)}`;
  const balance = `$${(args.balanceAfterCents / 100).toFixed(2)}`;
  return {
    subject: `Return ${args.rmaCode} refunded — ${refund}`,
    html: shell({
      eyebrow: "[06] Return refunded",
      title: `${refund} refunded to your wallet`,
      bodyHtml: `<p style="margin:0 0 12px 0;">RMA <strong>${escape(args.rmaCode)}</strong> has been resolved. Your wallet balance is now <strong>${balance}</strong>.</p>`,
      cta: { label: "Open wallet", href: `${cfg.WEB_PUBLIC_URL}/wallet` },
    }),
    text:
      `Return ${args.rmaCode} refunded — ${refund}\n\n` +
      `RMA ${args.rmaCode} has been resolved. Wallet balance: ${balance}.\n\n` +
      `Open wallet: ${cfg.WEB_PUBLIC_URL}/wallet`,
  };
}

// ---------------------------------------------------------------------------
// Personal Shopper — public buyer flow
// ---------------------------------------------------------------------------
//
// All shopper emails go to the buyer's email (no User row). The thread URL
// is the magic-link form: WEB_PUBLIC_URL/shopper/r/<token>. Tokens are 60-day
// long-lived and tracked at the DB level — see ShopperTokenService.

function shopperThreadUrl(token: string): string {
  return `${cfg.WEB_PUBLIC_URL}/shopper/r/${encodeURIComponent(token)}`;
}

function shopperPayUrl(checkoutUrl: string): string {
  // Stripe Checkout URLs are full URLs we just pass through. Encoded once.
  return checkoutUrl;
}

/**
 * Prepend a shopper request's reference to a rendered email so it shows
 * up in the subject ("[SHP-000042] …") and as a small label inside the
 * body. Saves us repeating the same string-concat in every template.
 *
 * Why brackets in the subject? Mail clients group by subject prefix in
 * threading, so [SHP-000042] also helps the buyer's inbox visually
 * group all the emails about the same order.
 */
function withShopperReference(
  rendered: RenderedEmail,
  reference: string,
  parentReference?: string | null,
): RenderedEmail {
  const refLineHtml = parentReference
    ? `<div style="margin:0 0 16px 0;font-family:'JetBrains Mono',monospace;font-size:11px;color:#777270;letter-spacing:1.4px;text-transform:uppercase;">Order ${escape(reference)} · addition to ${escape(parentReference)}</div>`
    : `<div style="margin:0 0 16px 0;font-family:'JetBrains Mono',monospace;font-size:11px;color:#777270;letter-spacing:1.4px;text-transform:uppercase;">Order ${escape(reference)}</div>`;
  const refLineText = parentReference
    ? `Order ${reference} · addition to ${parentReference}\n\n`
    : `Order ${reference}\n\n`;
  return {
    subject: `[${reference}] ${rendered.subject}`,
    // Inject the reference line right before the first <p> in the body
    // by prepending — every template's body starts with content directly,
    // not extra padding, so this lands at the top of the readable area.
    html: rendered.html.replace(
      /<td style="padding:0 32px 16px 32px;font-size:15px;line-height:1.6;color:#3A3A3A;">\s*/,
      (m) => `${m}${refLineHtml}`,
    ),
    text: refLineText + rendered.text,
  };
}

export function shopperIntakeReceivedTemplate(args: {
  reference: string;
  parentReference?: string | null;
  threadToken: string;
  intakePayUrl: string;
  intakeTotalCents: number;
}): RenderedEmail {
  const total = `$${(args.intakeTotalCents / 100).toFixed(2)}`;
  const base: RenderedEmail = {
    subject: `Your USA Errands shopper request — ${total}`,
    html: shell({
      eyebrow: "[08] Shopper request",
      title: "Your request is in. One step to finish.",
      bodyHtml: `<p style="margin:0 0 12px 0;">Thanks for using USA Errands. To start procurement we need the upfront amount of <strong>${total}</strong>.</p>
        <p style="margin:0 0 12px 0;color:#9C9892;font-size:13px;">After we buy your items we'll either send a small follow-up invoice for the actual cost difference + shipping, or refund the difference. Either way, you'll see it in this thread.</p>
        <p style="margin:0 0 12px 0;color:#9C9892;font-size:13px;">Want to add more items later? Use the order reference above when you submit a new request and we'll link them.</p>`,
      cta: { label: `Pay ${total} securely`, href: shopperPayUrl(args.intakePayUrl) },
    }),
    text:
      `Your USA Errands shopper request — ${total}\n\n` +
      `Thanks for using USA Errands. To start procurement we need the upfront amount of ${total}.\n\n` +
      `Pay securely: ${args.intakePayUrl}\n\n` +
      `Open your request thread anytime: ${shopperThreadUrl(args.threadToken)}\n\n` +
      `To add more items later, submit a new request and reference this order number.`,
  };
  return withShopperReference(base, args.reference, args.parentReference);
}

export function shopperIntakePaidTemplate(args: {
  reference: string;
  threadToken: string;
  intakeTotalCents: number;
}): RenderedEmail {
  const total = `$${(args.intakeTotalCents / 100).toFixed(2)}`;
  const base: RenderedEmail = {
    subject: `Payment received — ${total}`,
    html: shell({
      eyebrow: "[08] Payment received",
      title: "Got it — we're on it.",
      bodyHtml: `<p style="margin:0 0 12px 0;">We've received your payment of <strong>${total}</strong> and are starting procurement now.</p>
        <p style="margin:0 0 12px 0;">You'll get an update in your thread when we have item updates or a shipping quote.</p>`,
      cta: { label: "Open your thread", href: shopperThreadUrl(args.threadToken) },
    }),
    text:
      `Payment received — ${total}\n\n` +
      `We've received your payment and are starting procurement now.\n\n` +
      `Open your thread: ${shopperThreadUrl(args.threadToken)}`,
  };
  return withShopperReference(base, args.reference);
}

export function shopperNewMessageTemplate(args: {
  reference: string;
  threadToken: string;
  preview: string;
}): RenderedEmail {
  const trimmed = args.preview.length > 280 ? `${args.preview.slice(0, 280)}…` : args.preview;
  const base: RenderedEmail = {
    subject: "New message from USA Errands",
    html: shell({
      eyebrow: "[08] New message",
      title: "USA Errands replied to your request",
      bodyHtml: `<blockquote style="margin:0 0 16px 0;padding:12px 16px;background:#F1EFE9;border-left:3px solid #C99428;color:#3A3A3A;font-size:14px;">${escape(trimmed)}</blockquote>`,
      cta: { label: "Open thread to reply", href: shopperThreadUrl(args.threadToken) },
    }),
    text:
      `New message from USA Errands\n\n` +
      `${trimmed}\n\n` +
      `Reply in your thread: ${shopperThreadUrl(args.threadToken)}`,
  };
  return withShopperReference(base, args.reference);
}

export function shopperFollowupOwedTemplate(args: {
  reference: string;
  threadToken: string;
  followupPayUrl: string;
  amountCents: number;
}): RenderedEmail {
  const amount = `$${(args.amountCents / 100).toFixed(2)}`;
  const base: RenderedEmail = {
    subject: `Adjustment + shipping invoice — ${amount}`,
    html: shell({
      eyebrow: "[08] Follow-up invoice",
      title: "Final payment to release shipping",
      bodyHtml: `<p style="margin:0 0 12px 0;">We've finished procurement and confirmed shipping cost. The remaining balance is <strong>${amount}</strong>.</p>
        <p style="margin:0 0 12px 0;color:#9C9892;font-size:13px;">As soon as this is paid we'll dispatch your package and email tracking.</p>`,
      cta: { label: `Pay ${amount} securely`, href: shopperPayUrl(args.followupPayUrl) },
    }),
    text:
      `Adjustment + shipping invoice — ${amount}\n\n` +
      `Pay securely: ${args.followupPayUrl}\n\n` +
      `Thread: ${shopperThreadUrl(args.threadToken)}`,
  };
  return withShopperReference(base, args.reference);
}

export function shopperRefundIssuedTemplate(args: {
  reference: string;
  threadToken: string;
  amountCents: number;
}): RenderedEmail {
  const amount = `$${(args.amountCents / 100).toFixed(2)}`;
  const base: RenderedEmail = {
    subject: `Refund issued — ${amount}`,
    html: shell({
      eyebrow: "[08] Refund issued",
      title: `${amount} on its way back to your card`,
      bodyHtml: `<p style="margin:0 0 12px 0;">Actual costs came in under your estimate. We've refunded <strong>${amount}</strong> to the card you paid with — most banks settle within 5–10 business days.</p>
        <p style="margin:0 0 12px 0;">Your package will ship as soon as the warehouse picks it up.</p>`,
      cta: { label: "Open your thread", href: shopperThreadUrl(args.threadToken) },
    }),
    text:
      `Refund issued — ${amount}\n\n` +
      `We've refunded ${amount} to your card. Most banks settle within 5–10 business days.\n\n` +
      `Thread: ${shopperThreadUrl(args.threadToken)}`,
  };
  return withShopperReference(base, args.reference);
}

export function shopperShippedTemplate(args: {
  reference: string;
  threadToken: string;
  carrier: string;
  trackingNumber: string;
}): RenderedEmail {
  const base: RenderedEmail = {
    subject: `Your shopper order shipped via ${args.carrier}`,
    html: shell({
      eyebrow: "[08] Shipped",
      title: "Package handed to the carrier",
      bodyHtml: `<p style="margin:0 0 12px 0;">${escape(args.carrier)} picked up your package.</p>
        <p style="margin:0 0 12px 0;font-family:'JetBrains Mono',monospace;font-size:14px;color:#0A0A0A;">${escape(args.trackingNumber)}</p>`,
      cta: { label: "Open your thread", href: shopperThreadUrl(args.threadToken) },
    }),
    text:
      `Your shopper order shipped via ${args.carrier}\n\n` +
      `Tracking: ${args.trackingNumber}\n\n` +
      `Thread: ${shopperThreadUrl(args.threadToken)}`,
  };
  return withShopperReference(base, args.reference);
}

export function shopperFollowupPaidTemplate(args: {
  reference: string;
  threadToken: string;
  amountCents: number;
}): RenderedEmail {
  const amount = `$${(args.amountCents / 100).toFixed(2)}`;
  const base: RenderedEmail = {
    subject: `Final payment received — ${amount}`,
    html: shell({
      eyebrow: "[08] Final payment received",
      title: "All set — your package ships next.",
      bodyHtml: `<p style="margin:0 0 12px 0;">Thanks — we&apos;ve received the final payment of <strong>${amount}</strong>. Your package is being prepared for dispatch and we&apos;ll email tracking the moment it leaves the warehouse.</p>`,
      cta: { label: "Open your thread", href: shopperThreadUrl(args.threadToken) },
    }),
    text:
      `Final payment received — ${amount}\n\n` +
      `Your package is being prepared for dispatch. Tracking lands in your thread shortly.\n\n` +
      `Thread: ${shopperThreadUrl(args.threadToken)}`,
  };
  return withShopperReference(base, args.reference);
}

export function shopperDeliveredTemplate(args: {
  reference: string;
  threadToken: string;
}): RenderedEmail {
  const base: RenderedEmail = {
    subject: "Your shopper order was delivered",
    html: shell({
      eyebrow: "[08] Delivered",
      title: "Delivered — thanks for using USA Errands.",
      bodyHtml: `<p style="margin:0 0 12px 0;">The carrier marked your package delivered. If anything is wrong, reply in your thread within 14 days and we&apos;ll help you sort it.</p>`,
      cta: { label: "Open your thread", href: shopperThreadUrl(args.threadToken) },
    }),
    text:
      `Your shopper order was delivered\n\n` +
      `If something&apos;s wrong, reply in your thread within 14 days.\n\n` +
      `Thread: ${shopperThreadUrl(args.threadToken)}`,
  };
  return withShopperReference(base, args.reference);
}

// ---------------------------------------------------------------------------
// PSN — vendor-facing
// ---------------------------------------------------------------------------

export function psnSubmittedTemplate(args: {
  psnId: string;
  lineCount: number;
  onboardingFeeCents: number;
}): RenderedEmail {
  const fee = `$${(args.onboardingFeeCents / 100).toFixed(2)}`;
  return {
    subject: `PSN ${args.psnId.slice(0, 8)} submitted — ${fee} debited`,
    html: shell({
      eyebrow: "[03] PSN submitted",
      title: "We&apos;re ready for your inbound shipment",
      bodyHtml: `<p style="margin:0 0 12px 0;">Your Pre-Shipment Notice with <strong>${args.lineCount} ${args.lineCount === 1 ? "line" : "lines"}</strong> is in our queue.</p>
        <p style="margin:0 0 12px 0;">Onboarding fee debited from your wallet: <strong>${fee}</strong>.</p>
        <p style="margin:0 0 12px 0;color:#9C9892;font-size:13px;">We&apos;ll email you again when the package is received and inventory is reflected on your dashboard.</p>`,
      cta: { label: "View PSN", href: `${cfg.WEB_PUBLIC_URL}/psn/${encodeURIComponent(args.psnId)}` },
    }),
    text:
      `PSN ${args.psnId.slice(0, 8)} submitted\n\n` +
      `${args.lineCount} line(s). Onboarding fee debited: ${fee}.\n\n` +
      `View: ${cfg.WEB_PUBLIC_URL}/psn/${args.psnId}`,
  };
}

export function psnReceivedTemplate(args: {
  psnId: string;
  acceptedUnits: number;
  rejectedUnits: number;
}): RenderedEmail {
  const ok = args.acceptedUnits;
  const bad = args.rejectedUnits;
  return {
    subject: `PSN ${args.psnId.slice(0, 8)} received — ${ok} units accepted`,
    html: shell({
      eyebrow: "[03] Inventory received",
      title: "Your shipment is in the warehouse",
      bodyHtml: `<p style="margin:0 0 12px 0;"><strong>${ok}</strong> units have been accepted into inventory and are reflected on your dashboard.</p>
        ${bad > 0 ? `<p style="margin:0 0 12px 0;color:#C99428;"><strong>${bad}</strong> units were rejected on inspection — see the PSN for details.</p>` : ""}`,
      cta: { label: "Open PSN", href: `${cfg.WEB_PUBLIC_URL}/psn/${encodeURIComponent(args.psnId)}` },
    }),
    text:
      `PSN ${args.psnId.slice(0, 8)} received\n\n` +
      `${ok} units accepted${bad > 0 ? `; ${bad} rejected` : ""}.\n\n` +
      `View: ${cfg.WEB_PUBLIC_URL}/psn/${args.psnId}`,
  };
}

// ---------------------------------------------------------------------------
// Orders — vendor-facing
// ---------------------------------------------------------------------------

export function orderCreatedTemplate(args: {
  orderRef: string;
  orderId: string;
  totalChargedCents: number;
  walletBalanceAfterCents: number;
}): RenderedEmail {
  const total = `$${(args.totalChargedCents / 100).toFixed(2)}`;
  const balance = `$${(args.walletBalanceAfterCents / 100).toFixed(2)}`;
  return {
    subject: `Order ${args.orderRef} created — ${total} reserved`,
    html: shell({
      eyebrow: "[04] Order created",
      title: "Order in fulfillment queue",
      bodyHtml: `<p style="margin:0 0 12px 0;"><strong>${total}</strong> reserved from your wallet (new balance: ${balance}). We&apos;ll email tracking the moment it ships.</p>`,
      cta: { label: "View order", href: `${cfg.WEB_PUBLIC_URL}/orders/${encodeURIComponent(args.orderId)}` },
    }),
    text:
      `Order ${args.orderRef} created — ${total} reserved\n\n` +
      `New wallet balance: ${balance}.\n\n` +
      `View: ${cfg.WEB_PUBLIC_URL}/orders/${args.orderId}`,
  };
}

export function orderInsufficientFundsTemplate(args: {
  shortfallCents: number;
  walletBalanceCents: number;
  requiredCents: number;
}): RenderedEmail {
  const short = `$${(args.shortfallCents / 100).toFixed(2)}`;
  const bal = `$${(args.walletBalanceCents / 100).toFixed(2)}`;
  const req = `$${(args.requiredCents / 100).toFixed(2)}`;
  return {
    subject: `Order rejected — wallet short by ${short}`,
    html: shell({
      eyebrow: "[02] Wallet shortfall",
      title: "Order couldn&apos;t be created — top up your wallet",
      bodyHtml: `<p style="margin:0 0 12px 0;">An order failed to submit because your wallet balance (<strong>${bal}</strong>) is below the required <strong>${req}</strong>.</p>
        <p style="margin:0 0 12px 0;">Add at least <strong>${short}</strong> to your wallet and re-submit the order from your dashboard.</p>`,
      cta: { label: "Fund wallet", href: `${cfg.WEB_PUBLIC_URL}/wallet/fund` },
    }),
    text:
      `Order rejected — wallet short by ${short}\n\n` +
      `Balance: ${bal}. Required: ${req}.\n\n` +
      `Fund: ${cfg.WEB_PUBLIC_URL}/wallet/fund`,
  };
}

export function orderCancelledTemplate(args: {
  orderRef: string;
  orderId: string;
  reason: string;
  refundedToWalletCents: number;
}): RenderedEmail {
  const refund = `$${(args.refundedToWalletCents / 100).toFixed(2)}`;
  return {
    subject: `Order ${args.orderRef} cancelled`,
    html: shell({
      eyebrow: "[04] Order cancelled",
      title: `Order ${args.orderRef} was cancelled`,
      bodyHtml: `<p style="margin:0 0 12px 0;"><strong>Reason:</strong> ${escape(args.reason)}.</p>
        ${args.refundedToWalletCents > 0 ? `<p style="margin:0 0 12px 0;"><strong>${refund}</strong> credited back to your wallet.</p>` : ""}`,
      cta: { label: "View order", href: `${cfg.WEB_PUBLIC_URL}/orders/${encodeURIComponent(args.orderId)}` },
    }),
    text:
      `Order ${args.orderRef} cancelled\n\n` +
      `Reason: ${args.reason}\n` +
      (args.refundedToWalletCents > 0 ? `Refunded to wallet: ${refund}\n` : "") +
      `\nView: ${cfg.WEB_PUBLIC_URL}/orders/${args.orderId}`,
  };
}

// ---------------------------------------------------------------------------
// Ops alerts — internal team alerts. Plain styling, action-oriented.
// ---------------------------------------------------------------------------

function opsShell(args: { eyebrow: string; title: string; bodyHtml: string; cta: { label: string; href: string } }): string {
  return shell(args);
}

export function opsNewPsnTemplate(args: {
  psnId: string;
  vendorBusinessName: string;
  lineCount: number;
  onboardingFeeCents: number;
}): RenderedEmail {
  const fee = `$${(args.onboardingFeeCents / 100).toFixed(2)}`;
  return {
    subject: `[OPS] New PSN — ${args.vendorBusinessName} (${fee})`,
    html: opsShell({
      eyebrow: "[Ops] New PSN",
      title: `${escape(args.vendorBusinessName)} submitted PSN ${args.psnId.slice(0, 8)}`,
      bodyHtml: `<p style="margin:0 0 12px 0;">${args.lineCount} line(s); onboarding fee ${fee}.</p>`,
      cta: { label: "Open PSN", href: `${cfg.WEB_PUBLIC_URL}/admin/psn/${encodeURIComponent(args.psnId)}` },
    }),
    text: `[OPS] New PSN from ${args.vendorBusinessName} — ${args.psnId.slice(0, 8)}, ${args.lineCount} line(s), ${fee}.\n${cfg.WEB_PUBLIC_URL}/admin/psn/${args.psnId}`,
  };
}

export function opsNewKycTemplate(args: {
  vendorId: string;
  vendorBusinessName: string;
}): RenderedEmail {
  return {
    subject: `[OPS] KYC submitted — ${args.vendorBusinessName}`,
    html: opsShell({
      eyebrow: "[Ops] KYC submitted",
      title: `Review KYC for ${escape(args.vendorBusinessName)}`,
      bodyHtml: `<p style="margin:0 0 12px 0;">A new KYC submission needs review.</p>`,
      cta: { label: "Open vendor", href: `${cfg.WEB_PUBLIC_URL}/admin/vendors/${encodeURIComponent(args.vendorId)}` },
    }),
    text: `[OPS] KYC submitted by ${args.vendorBusinessName}.\n${cfg.WEB_PUBLIC_URL}/admin/vendors/${args.vendorId}`,
  };
}

export function opsNewShopperRequestTemplate(args: {
  requestId: string;
  reference: string;
  parentReference?: string | null;
  buyerEmail: string;
  itemsCount: number;
  intakeTotalCents: number;
}): RenderedEmail {
  const total = `$${(args.intakeTotalCents / 100).toFixed(2)}`;
  const parentLine = args.parentReference
    ? `<p style="margin:0 0 12px 0;color:#C99428;font-size:13px;">Addition to <strong>${escape(args.parentReference)}</strong> — same buyer, ship together if the parent order has not been shipped.</p>`
    : "";
  const parentText = args.parentReference ? `Addition to ${args.parentReference}.\n` : "";
  return {
    subject: `[OPS] [${args.reference}] New shopper request — ${total} (${args.buyerEmail})`,
    html: opsShell({
      eyebrow: `[Ops] ${args.reference}`,
      title: `${args.itemsCount} item(s) — ${total}`,
      bodyHtml: `<p style="margin:0 0 12px 0;">From <strong>${escape(args.buyerEmail)}</strong>. Awaiting intake payment.</p>${parentLine}`,
      cta: { label: "Open request", href: `${cfg.WEB_PUBLIC_URL}/admin/shopper/${encodeURIComponent(args.requestId)}` },
    }),
    text:
      `[OPS] ${args.reference} — New shopper request — ${total} from ${args.buyerEmail}.\n` +
      parentText +
      `${cfg.WEB_PUBLIC_URL}/admin/shopper/${args.requestId}`,
  };
}

export function opsBuyerMessageTemplate(args: {
  requestId: string;
  reference: string;
  buyerEmail: string;
  preview: string;
}): RenderedEmail {
  const trimmed = args.preview.length > 160 ? `${args.preview.slice(0, 160)}…` : args.preview;
  return {
    subject: `[OPS] [${args.reference}] New buyer message — ${args.buyerEmail}`,
    html: opsShell({
      eyebrow: `[Ops] ${args.reference}`,
      title: `Reply needed`,
      bodyHtml: `<blockquote style="margin:0 0 12px 0;padding:8px 12px;background:#F1EFE9;border-left:3px solid #C99428;font-size:13px;">${escape(trimmed)}</blockquote>
        <p style="margin:0 0 12px 0;color:#9C9892;font-size:13px;">From <strong>${escape(args.buyerEmail)}</strong>.</p>`,
      cta: { label: "Open thread", href: `${cfg.WEB_PUBLIC_URL}/admin/shopper/${encodeURIComponent(args.requestId)}` },
    }),
    text: `[OPS] ${args.reference} — New buyer message from ${args.buyerEmail}: ${trimmed}\n${cfg.WEB_PUBLIC_URL}/admin/shopper/${args.requestId}`,
  };
}

// ---------------------------------------------------------------------------

export function shopperCancelledTemplate(args: {
  reference: string;
  threadToken: string;
  refundedAmountCents: number;
  reason: string;
}): RenderedEmail {
  const refunded = args.refundedAmountCents > 0
    ? ` We&apos;ve refunded <strong>$${(args.refundedAmountCents / 100).toFixed(2)}</strong> to your card — most banks settle within 5–10 business days.`
    : "";
  const base: RenderedEmail = {
    subject:
      args.refundedAmountCents > 0
        ? `Request cancelled — $${(args.refundedAmountCents / 100).toFixed(2)} refunded`
        : "Your shopper request was cancelled",
    html: shell({
      eyebrow: "[08] Cancelled",
      title: "Your request was cancelled.",
      bodyHtml: `<p style="margin:0 0 12px 0;">Your USA Errands shopper request has been cancelled.${refunded}</p>
        <p style="margin:0 0 12px 0;color:#9C9892;font-size:13px;"><strong>Reason from our team:</strong> ${escape(args.reason)}</p>
        <p style="margin:0 0 12px 0;">If you have questions, reply in your thread.</p>`,
      cta: { label: "Open your thread", href: shopperThreadUrl(args.threadToken) },
    }),
    text:
      `Your shopper request was cancelled\n\n` +
      (args.refundedAmountCents > 0
        ? `Refund issued: $${(args.refundedAmountCents / 100).toFixed(2)}. Most banks settle within 5–10 business days.\n\n`
        : "") +
      `Reason: ${args.reason}\n\n` +
      `Thread: ${shopperThreadUrl(args.threadToken)}`,
  };
  return withShopperReference(base, args.reference);
}
