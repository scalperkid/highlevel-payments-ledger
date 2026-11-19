import type { Env, LocationConfig } from './types';

// Email sign-in for viewers outside the CRM, such as the accountant. The CRM menu stays the main way in.
export const LINK_TTL = 30 * 60;           // a link works for 30 minutes, once
export const LINK_LIMIT_PER_HOUR = 5;      // per email address

const enc = new TextEncoder();

export function randomToken(bytes = 32): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const normaliseEmail = (s: unknown) => String(s ?? '').trim().toLowerCase();
export const looksLikeEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;

/** Every report this email may open: the first one wins when an address is a viewer on several. */
export function locationsFor(email: string, configs: { location_id: string; config: LocationConfig }[]): string[] {
  return configs.filter((c) => c.config.viewers.map((v) => v.toLowerCase()).includes(email)).map((c) => c.location_id);
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function signInEmail(displayName: string, link: string): { subject: string; html: string; text: string } {
  const name = escapeHtml(displayName);
  const subject = `Your sign-in link for ${displayName} reports`;
  const text = `Use this link to open the ${displayName} reports:\n\n${link}\n\nIt works once and expires in 30 minutes. If you did not ask for it, you can ignore this email.`;
  // Plain, table-based layout so it renders the same in Outlook and Gmail.
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f5f7">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fcfcfd;border:1px solid #e3e5ea;border-radius:12px">
<tr><td style="padding:28px 28px 8px;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#1d2230">
<p style="margin:0 0 6px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#4a4fb3">${name}</p>
<h1 style="margin:0 0 14px;font-size:22px;line-height:1.25;font-weight:700">Your sign-in link</h1>
<p style="margin:0 0 22px;font-size:15px;line-height:1.55;color:#4b5263">Use the button below to open the ${name} reports. It works once and expires in 30 minutes.</p>
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:10px;background:#3f44a8"><a href="${escapeHtml(link)}" style="display:inline-block;padding:13px 22px;font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#fcfcfd;text-decoration:none">Open reports</a></td></tr></table>
<p style="margin:22px 0 0;font-size:13px;line-height:1.5;color:#6b7180">If the button does not work, copy this address into your browser:<br><span style="word-break:break-all;color:#4b5263">${escapeHtml(link)}</span></p>
</td></tr>
<tr><td style="padding:18px 28px 26px;font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:#8a8f9c;border-top:1px solid #e3e5ea">You received this because someone asked to sign in to the ${name} reports with this address. If that was not you, you can ignore this email; nothing changes.</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, html, text };
}

export async function sendEmail(env: Env, to: string, mail: { subject: string; html: string; text: string }): Promise<boolean> {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) { console.error('email not configured'); return false; }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject: mail.subject, html: mail.html, text: mail.text }),
  });
  if (!r.ok) console.error('email send failed', r.status, (await r.text()).slice(0, 300));
  return r.ok;
}
