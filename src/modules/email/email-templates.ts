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
