import { buildLedger, toCsv } from './classify';
import { closableMonth, monthlyBreakdownCsv, quickbooksCsv, summariseMonth, summaryCsv } from './close';
import { decryptCryptoJs, safeEqual, seal, signToken, verifyToken } from './crypto';
import { companyKey, mintLocationToken, syncAll, syncLocation } from './sync';
import type { ContactRow, Env, LocationConfig, PaymentRow } from './types';
import { PAGE } from './ui';
import { LINK_LIMIT_PER_HOUR, LINK_TTL, locationsFor, looksLikeEmail, normaliseEmail, randomToken, sendEmail, sha256Hex, signInEmail } from './signin';

interface Session { loc: string; email: string; name: string; exp: number }

const now = () => Math.floor(Date.now() / 1000);
const SESSION_TTL = 8 * 3600;

function headers(env: Env, type: string, extra: Record<string, string> = {}): Headers {
  const h = new Headers({ 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...extra });
  // Only the CRM may frame the page. Domains come from config, never code.
  const ancestors = env.FRAME_ANCESTORS ?? "'self'";
  h.set('Content-Security-Policy', `frame-ancestors ${ancestors}; default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:`);
  return h;
}
const json = (env: Env, data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: headers(env, 'application/json') });

async function session(req: Request, env: Env): Promise<Session | null> {
  const auth = req.headers.get('Authorization') ?? '';
  const tok = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!tok || !env.SESSION_SECRET) return null;
  const s = await verifyToken<Session>(tok, env.SESSION_SECRET);
  return s && s.exp > now() ? s : null;
}

async function loadConfig(env: Env, loc: string): Promise<LocationConfig | null> {
  const r = await env.DB.prepare('SELECT config_json FROM location_config WHERE location_id=?').bind(loc).first<{ config_json: string }>();
  return r ? (JSON.parse(r.config_json) as LocationConfig) : null;
}

/** The admin secret never lives on the server; only its SHA-256 does. */
async function isAdmin(req: Request, env: Env): Promise<boolean> {
  const got = req.headers.get('X-Admin-Secret') ?? '';
  if (!env.ADMIN_SECRET_SHA256 || got.length < 32) return false;
  const h = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(got)))].map((b) => b.toString(16).padStart(2, '0')).join('');
  return safeEqual(h, env.ADMIN_SECRET_SHA256.toLowerCase());
}

/** Records who used the reports. Never blocks the request it describes. */
async function logAccess(env: Env, req: Request, loc: string, email: string, event: string, detail = ''): Promise<void> {
  const cf = (req as Request & { cf?: { city?: string; region?: string; country?: string; colo?: string } }).cf ?? {};
  try {
    await env.DB.prepare('INSERT INTO access_log (location_id,at,email,event,detail,city,region,country,colo) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(loc, now(), email || null, event, detail.slice(0, 200) || null, cf.city ?? null, cf.region ?? null, cf.country ?? null, cf.colo ?? null).run();
  } catch (e) { console.error('access log', e); }
}

async function handleSso(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { payload?: string; dev?: boolean };
  let loc = ''; let email = ''; let name = '';
  if (body.dev && env.ENVIRONMENT === 'development' && env.DEV_LOCATION && env.DEV_EMAIL) {
    loc = env.DEV_LOCATION; email = env.DEV_EMAIL; name = 'Local preview';
  } else {
    if (!body.payload || !env.GHL_SSO_SHARED_SECRET) return json(env, { error: 'sign-in unavailable' }, 400);
    let user: { email?: string; userName?: string; activeLocation?: string };
    try { user = JSON.parse(await decryptCryptoJs(body.payload, env.GHL_SSO_SHARED_SECRET)); }
    catch { return json(env, { error: 'sign-in could not be verified' }, 401); }
    loc = user.activeLocation ?? ''; email = (user.email ?? '').toLowerCase(); name = user.userName ?? '';
  }
  const cfg = loc ? await loadConfig(env, loc) : null;
  if (!cfg) return json(env, { error: 'Reports are not set up for this account yet.' }, 403);
  // The CRM vouches for who the user is. Who may see the money is our decision.
  if (!cfg.viewers.map((v) => v.toLowerCase()).includes(email)) {
    await logAccess(env, req, loc, email, 'denied');
    return json(env, { error: 'Your login does not have access to these reports. Ask the account owner to add you.' }, 403);
  }
  await logAccess(env, req, loc, email, 'open', name);
  const token = await signToken({ loc, email, name, exp: now() + SESSION_TTL }, env.SESSION_SECRET!);
  return json(env, { token, name, displayName: cfg.displayName });
}

/** The address the visitor actually used. A branded domain proxies here, so trust its forwarded host only if allowlisted. */
function publicOrigin(req: Request, env: Env, url: URL): string {
  const fwd = (req.headers.get('x-forwarded-host') ?? '').split(',')[0].trim().toLowerCase();
  const allowed = (env.PUBLIC_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  return fwd && allowed.includes(fwd) ? `https://${fwd}` : url.origin;
}

/** Ask for a sign-in link. Always answers the same way, so it never reveals who has access. */
async function handleLinkRequest(req: Request, env: Env, origin: string): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { email?: string };
  const email = normaliseEmail(body.email);
  const same = json(env, { ok: true, message: 'If that address has access, a sign-in link is on its way. Check your inbox in a minute.' });
  if (!looksLikeEmail(email)) return json(env, { error: 'Enter the email address the reports were shared with.' }, 400);
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM signin_links WHERE email=? AND created_at > ?').bind(email, now() - 3600).first<{ n: number }>();
  if ((recent?.n ?? 0) >= LINK_LIMIT_PER_HOUR) return same;
  const configs = (await env.DB.prepare('SELECT location_id, config_json FROM location_config').all<{ location_id: string; config_json: string }>()).results
    .map((r) => ({ location_id: r.location_id, config: JSON.parse(r.config_json) as LocationConfig }));
  const [loc] = locationsFor(email, configs);
  if (!loc) { await logAccess(env, req, '', email, 'link-denied'); return same; }
  const cfg = configs.find((c) => c.location_id === loc)!.config;
  const token = randomToken();
  await env.DB.prepare('INSERT INTO signin_links (hash,location_id,email,created_at,expires_at) VALUES (?,?,?,?,?)')
    .bind(await sha256Hex(token), loc, email, now(), now() + LINK_TTL).run();
  const sent = await sendEmail(env, email, signInEmail(cfg.displayName, `${origin}/?signin=${token}`));
  await logAccess(env, req, loc, email, sent ? 'link-sent' : 'link-failed');
  return same;
}

/** Trade a one-time link for a session. A link works once, for 30 minutes, and only while the address is still a viewer. */
async function handleLinkVerify(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { token?: string };
  const token = String(body.token ?? '');
  const expired = json(env, { error: 'This sign-in link has expired or was already used. Ask for a new one below.' }, 401);
  if (token.length < 20) return expired;
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare('SELECT location_id, email, expires_at, used_at FROM signin_links WHERE hash=?').bind(hash).first<{ location_id: string; email: string; expires_at: number; used_at: number | null }>();
  if (!row || row.used_at || row.expires_at < now()) return expired;
  const claimed = await env.DB.prepare('UPDATE signin_links SET used_at=? WHERE hash=? AND used_at IS NULL').bind(now(), hash).run();
  if (claimed.meta.changes !== 1) return expired;
  const cfg = await loadConfig(env, row.location_id);
  if (!cfg || !cfg.viewers.map((v) => v.toLowerCase()).includes(row.email)) {
    await logAccess(env, req, row.location_id, row.email, 'denied', 'email link, no longer a viewer');
    return json(env, { error: 'Your access to these reports has been removed.' }, 403);
  }
  await logAccess(env, req, row.location_id, row.email, 'open', 'email link');
  const sessionToken = await signToken({ loc: row.location_id, email: row.email, name: row.email, exp: now() + SESSION_TTL }, env.SESSION_SECRET!);
  return json(env, { token: sessionToken, name: row.email, displayName: cfg.displayName, exp: now() + SESSION_TTL });
}

async function ledgerFor(env: Env, s: Session, url: URL) {
  const cfg = (await loadConfig(env, s.loc))!;
  const rows = (await env.DB.prepare('SELECT * FROM payments WHERE location_id=?').bind(s.loc).all<PaymentRow>()).results;
  const contacts = new Map((await env.DB.prepare('SELECT contact_id,name,company,address,tags_json FROM contacts WHERE location_id=?').bind(s.loc).all<ContactRow>()).results.map((c) => [c.contact_id, c]));
  const payouts = (await env.DB.prepare('SELECT id,arrival_at,amount_cents,status FROM payouts WHERE location_id=?').bind(s.loc).all<{ id: string; arrival_at: number; amount_cents: number; status: string | null }>()).results;
  const arrival = new Map(payouts.map((p) => [p.id, p.arrival_at]));
  let lines = buildLedger(s.loc, cfg, rows, contacts, arrival);
  const from = url.searchParams.get('from'); const to = url.searchParams.get('to');
  if (from) lines = lines.filter((l) => l.date >= from);
  if (to) lines = lines.filter((l) => l.date <= to);
  const last = await env.DB.prepare("SELECT value FROM sync_state WHERE location_id=? AND key='last_sync'").bind(s.loc).first<{ value: string }>();
  return { cfg, lines, payouts, lastSync: last ? Number(last.value) : null };
}

async function handleOauth(url: URL, env: Env): Promise<Response> {
  const code = url.searchParams.get('code');
  const page = (msg: string, status = 200) => new Response(`<!doctype html><meta charset="utf-8"><title>Reports</title><body style="font:16px system-ui;padding:40px;background:oklch(97% 0.006 270);color:oklch(18% 0.012 270)"><p>${msg}</p>`, { status, headers: headers(env, 'text/html; charset=utf-8') });
  if (!code) return page('Missing install code.', 400);
  const body = new URLSearchParams({ client_id: env.GHL_CLIENT_ID!, client_secret: env.GHL_CLIENT_SECRET!, grant_type: 'authorization_code', code, redirect_uri: env.GHL_REDIRECT_URI!, user_type: 'Location' });
  const r = await fetch('https://services.leadconnectorhq.com/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body });
  const j = (await r.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; locationId?: string; companyId?: string; userType?: string; message?: string };
  await env.DB.prepare('INSERT INTO install_attempts (at,location_id,status,detail) VALUES (?,?,?,?)').bind(now(), j.locationId ?? null, r.ok ? 'ok' : `http ${r.status}`, JSON.stringify({ userType: j.userType, scope: j.scope, message: j.message }).slice(0, 500)).run();
  if (!r.ok || !j.access_token || !j.refresh_token) return page('The install could not be completed. Please try again or contact support.', 400);

  const isCompany = j.userType === 'Company';
  const key = isCompany ? companyKey(j.companyId ?? '') : j.locationId;
  if (!key || (isCompany && !j.companyId)) return page('The install could not be completed. Please try again or contact support.', 400);
  await env.DB.prepare(`INSERT INTO installs (location_id,company_id,access_enc,refresh_enc,expires_at,scope,user_type,updated_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(location_id) DO UPDATE SET company_id=excluded.company_id, access_enc=excluded.access_enc, refresh_enc=excluded.refresh_enc, expires_at=excluded.expires_at, scope=excluded.scope, user_type=excluded.user_type, updated_at=excluded.updated_at`)
    .bind(key, j.companyId ?? null, await seal(j.access_token, env.ENC_KEY!), await seal(j.refresh_token, env.ENC_KEY!), now() + (j.expires_in ?? 86399), j.scope ?? null, isCompany ? 'Company' : 'Location', now()).run();

  if (isCompany) {
    // Agency-level (bulk) install: find the sub-accounts it covers and mint a token for each.
    const appId = (env.GHL_CLIENT_ID ?? '').split('-')[0];
    const q = new URLSearchParams({ companyId: j.companyId!, appId, isInstalled: 'true', limit: '500' });
    const lr = await fetch(`https://services.leadconnectorhq.com/oauth/installedLocations?${q}`, { headers: { Authorization: `Bearer ${j.access_token}`, Version: '2021-07-28', Accept: 'application/json' } });
    const lj = (await lr.json().catch(() => ({}))) as { locations?: { _id: string; name?: string }[]; message?: string };
    const minted: string[] = []; const failed: string[] = [];
    for (const l of (lj.locations ?? []).slice(0, 25)) {
      try { await mintLocationToken(env, j.companyId!, l._id); minted.push(l._id); } catch (e) { failed.push(`${l._id}: ${String(e).slice(0, 80)}`); }
    }
    await env.DB.prepare('INSERT INTO install_attempts (at,location_id,status,detail) VALUES (?,?,?,?)')
      .bind(now(), key, lr.ok ? 'locations minted' : `installedLocations http ${lr.status}`, JSON.stringify({ minted, failed, message: lj.message }).slice(0, 500)).run();
  }
  return page('Installed. Open Reports from the left menu.');
}

async function handleAdmin(req: Request, env: Env, url: URL): Promise<Response> {
  if (!(await isAdmin(req, env))) return json(env, { error: 'not found' }, 404);
  const body = req.method === 'POST' ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};
  const loc = String(body.locationId ?? url.searchParams.get('locationId') ?? '');
  if (!loc) return json(env, { error: 'locationId required' }, 400);
  switch (url.pathname) {
    case '/admin/config': {
      const cfg = body.config as LocationConfig;
      if (!cfg?.displayName || !Array.isArray(cfg.viewers) || !Array.isArray(cfg.rules)) return json(env, { error: 'invalid config' }, 400);
      await env.DB.prepare(`INSERT INTO location_config (location_id,config_json,updated_at) VALUES (?,?,?)
        ON CONFLICT(location_id) DO UPDATE SET config_json=excluded.config_json, updated_at=excluded.updated_at`).bind(loc, JSON.stringify(cfg), now()).run();
      return json(env, { ok: true });
    }
    case '/admin/stripe-key': {
      const key = String(body.key ?? '');
      if (!/^rk_(live|test)_/.test(key)) return json(env, { error: 'expected a restricted key' }, 400);
      const r = await fetch('https://api.stripe.com/v1/balance?', { headers: { Authorization: `Bearer ${key}` } });
      if (!r.ok) return json(env, { error: `key rejected by Stripe (${r.status})` }, 400);
      const res = await env.DB.prepare('UPDATE location_config SET stripe_key_enc=?, updated_at=? WHERE location_id=?').bind(await seal(key, env.ENC_KEY!), now(), loc).run();
      return json(env, { ok: res.meta.changes === 1 });
    }
    case '/admin/ghl-token': {
      // Interim credential (a Private Integration Token, or a short-lived location token) until the app install supplies OAuth tokens.
      const token = String(body.token ?? ''); const ttl = Number(body.ttlSeconds ?? 365 * 86400);
      if (token.length < 20) return json(env, { error: 'token required' }, 400);
      const probe = await fetch(`https://services.leadconnectorhq.com/locations/${loc}`, { headers: { Authorization: `Bearer ${token}`, Version: '2021-07-28', Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126 Safari/537.36' } });
      if (!probe.ok) return json(env, { error: `token rejected (${probe.status})` }, 400);
      await env.DB.prepare(`INSERT INTO installs (location_id,company_id,access_enc,refresh_enc,expires_at,scope,user_type,updated_at) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(location_id) DO UPDATE SET access_enc=excluded.access_enc, refresh_enc=excluded.refresh_enc, expires_at=excluded.expires_at, user_type=excluded.user_type, updated_at=excluded.updated_at`)
        .bind(loc, null, await seal(token, env.ENC_KEY!), '', now() + ttl, null, 'Static', now()).run();
      return json(env, { ok: true, expiresAt: now() + ttl });
    }
    case '/admin/summary': {
      // Aggregates only, for verifying a tenant's numbers without a viewer session.
      const { lines } = await ledgerFor(env, { loc, email: '', name: '', exp: 0 }, url);
      const by: Record<string, number> = {}; const flags: Record<string, number> = {};
      for (const l of lines) { by[l.segment] = (by[l.segment] ?? 0) + l.gross; if (l.flag && l.type !== 'Reversal') flags[l.flag] = (flags[l.flag] ?? 0) + 1; }
      const stripe = lines.filter((l) => l.source === 'stripe');
      return json(env, { lines: lines.length, gross: lines.reduce((a, l) => a + l.gross, 0), fees: lines.reduce((a, l) => a + l.fee, 0),
        stripeLines: stripe.length, stripeWithDeposit: stripe.filter((l) => l.depositDate).length, bySegment: by, flags });
    }
    case '/admin/export': {
      // Accountant files for a period, pulled by the operator to send by hand. period: "" all time, "2026" a year, "2026-09" a month.
      const { lines, cfg: c } = await ledgerFor(env, { loc, email: '', name: '', exp: 0 }, url);
      const period = String(url.searchParams.get('period') ?? '');
      if (!/^(\d{4}(-\d{2})?)?$/.test(period)) return json(env, { error: 'period must be empty, YYYY or YYYY-MM' }, 400);
      const inPeriod = lines.filter((l) => l.date.startsWith(period));
      const file = String(url.searchParams.get('file') ?? '');
      const body = file === 'summary' ? summaryCsv(summariseMonth(period, inPeriod, c))
        : file === 'by-month' ? monthlyBreakdownCsv(inPeriod, c)
        : file === 'payments' ? toCsv(inPeriod)
        : null;
      if (body === null) return json(env, { error: 'file must be summary, by-month or payments' }, 400);
      await logAccess(env, req, loc, 'admin', 'download', `admin export ${file} ${period || 'all time'}`);
      return new Response(body, { headers: headers(env, 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="${file}.csv"` }) });
    }
    case '/admin/reopen': {
      const month = String(body.month ?? '');
      const r = await env.DB.prepare('DELETE FROM month_closes WHERE location_id=? AND month=?').bind(loc, month).run();
      return json(env, { ok: true, reopened: r.meta.changes === 1 });
    }
    case '/admin/access':
      return json(env, { access: (await env.DB.prepare('SELECT at, email, event, detail, city, region, country, colo FROM access_log WHERE location_id=? ORDER BY id DESC LIMIT 100').bind(loc).all()).results });
    case '/admin/sync':
      return json(env, { ok: true, steps: await syncLocation(env, loc) });
    case '/admin/status': {
      const q = (sql: string) => env.DB.prepare(sql).bind(loc).first();
      return json(env, {
        payments: await q('SELECT source, COUNT(*) n FROM payments WHERE location_id=? GROUP BY source'),
        counts: (await env.DB.prepare('SELECT source, kind, COUNT(*) n FROM payments WHERE location_id=? GROUP BY source, kind').bind(loc).all()).results,
        payouts: await q('SELECT COUNT(*) n, SUM(mapped) mapped FROM payouts WHERE location_id=?'),
        contacts: await q('SELECT COUNT(*) n FROM contacts WHERE location_id=?'),
        state: (await env.DB.prepare('SELECT key, value FROM sync_state WHERE location_id=?').bind(loc).all()).results,
        log: (await env.DB.prepare('SELECT at, step, ok, detail FROM sync_log WHERE location_id=? ORDER BY id DESC LIMIT 8').bind(loc).all()).results,
      });
    }
  }
  return json(env, { error: 'not found' }, 404);
}

interface CloseRow { month: string; closed_at: number; closed_by: string; summary_json: string; lines_csv: string; summary_csv: string; quickbooks_csv: string }

const FILES: Record<string, { col: 'summary_csv' | 'lines_csv' | 'quickbooks_csv'; name: string }> = {
  summary: { col: 'summary_csv', name: 'summary' },
  lines: { col: 'lines_csv', name: 'all-payments' },
  quickbooks: { col: 'quickbooks_csv', name: 'quickbooks-journal-entries' },
};

/** Monthly close: preview a month live, lock it as a snapshot, and serve its three files. */
async function handleClose(req: Request, env: Env, s: Session, url: URL, cfg: LocationConfig): Promise<Response> {
  const { lines } = await ledgerFor(env, s, new URL(url.origin));
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timezone }).format(new Date());
  const closedRows = (await env.DB.prepare('SELECT month, closed_at, closed_by FROM month_closes WHERE location_id=?').bind(s.loc).all<{ month: string; closed_at: number; closed_by: string }>()).results;
  const closed = new Map(closedRows.map((r) => [r.month, r]));

  if (url.pathname === '/api/months') {
    const months = [...new Set(lines.map((l) => l.date.slice(0, 7)))].sort().reverse();
    return json(env, { months: months.map((m) => {
      const sum = summariseMonth(m, lines, cfg);
      const c = closed.get(m);
      return { month: m, gross: sum.totals.gross, net: sum.totals.net, payments: sum.totals.payments, closedAt: c?.closed_at ?? null, closedBy: c?.closed_by ?? null, closable: !c && closableMonth(m, today) };
    }) });
  }

  const month = url.searchParams.get('month') ?? '';
  if (!/^\d{4}-\d{2}$/.test(month)) return json(env, { error: 'Pick a month.' }, 400);
  const snap = closed.has(month) ? await env.DB.prepare('SELECT * FROM month_closes WHERE location_id=? AND month=?').bind(s.loc, month).first<CloseRow>() : null;

  if (url.pathname === '/api/close' && req.method === 'GET') {
    const summary = snap ? JSON.parse(snap.summary_json) : summariseMonth(month, lines, cfg);
    return json(env, { month, summary, closedAt: snap?.closed_at ?? null, closedBy: snap?.closed_by ?? null, closable: !snap && closableMonth(month, today) });
  }

  if (url.pathname === '/api/close' && req.method === 'POST') {
    if (snap) return json(env, { error: 'This month is already closed.' }, 409);
    if (!closableMonth(month, today)) return json(env, { error: 'A month can be closed once it has ended.' }, 400);
    const summary = summariseMonth(month, lines, cfg);
    const monthLines = lines.filter((l) => l.date.startsWith(month));
    await env.DB.prepare('INSERT INTO month_closes (location_id,month,closed_at,closed_by,summary_json,lines_csv,summary_csv,quickbooks_csv) VALUES (?,?,?,?,?,?,?,?)')
      .bind(s.loc, month, now(), s.email, JSON.stringify(summary), toCsv(monthLines), summaryCsv(summary), quickbooksCsv(month, lines, cfg)).run();
    await logAccess(env, req, s.loc, s.email, 'close', month);
    return json(env, { ok: true, month, closedAt: now() });
  }

  if (url.pathname === '/api/close/file') {
    const f = FILES[url.searchParams.get('kind') ?? ''];
    if (!f) return json(env, { error: 'Unknown file.' }, 400);
    let body: string;
    if (snap) body = snap[f.col];
    else if (f.col === 'summary_csv') body = summaryCsv(summariseMonth(month, lines, cfg));
    else if (f.col === 'lines_csv') body = toCsv(lines.filter((l) => l.date.startsWith(month)));
    else body = quickbooksCsv(month, lines, cfg);
    const name = `${cfg.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${month}-${f.name}${snap ? '' : '-draft'}.csv`;
    await logAccess(env, req, s.loc, s.email, 'download', name);
    return new Response(body, { headers: headers(env, 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="${name}"` }) });
  }
  return json(env, { error: 'not found' }, 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (req.method === 'GET' && url.pathname === '/') return new Response(PAGE(env.ENVIRONMENT === 'development'), { headers: headers(env, 'text/html; charset=utf-8') });
      if (url.pathname === '/health') return json(env, { ok: true });
      if (req.method === 'POST' && url.pathname === '/api/sso') return handleSso(req, env);
      if (req.method === 'POST' && url.pathname === '/api/signin/request') return handleLinkRequest(req, env, publicOrigin(req, env, url));
      if (req.method === 'POST' && url.pathname === '/api/signin/verify') return handleLinkVerify(req, env);
      if (req.method === 'GET' && url.pathname === '/oauth/callback') return handleOauth(url, env);
      if (url.pathname.startsWith('/admin/')) return handleAdmin(req, env, url);

      if (url.pathname.startsWith('/api/')) {
        const s = await session(req, env);
        if (!s) return json(env, { error: 'Your session has ended. Reopen Reports from the menu.' }, 401);
        const cfg = await loadConfig(env, s.loc);
        if (!cfg || !cfg.viewers.map((v) => v.toLowerCase()).includes(s.email)) return json(env, { error: 'Access removed.' }, 403);
        if (url.pathname === '/api/ledger') {
          const { cfg: c, lines, payouts, lastSync } = await ledgerFor(env, s, url);
          return json(env, { displayName: c.displayName, segments: c.segments, lines, payouts: payouts.map((p) => ({ id: p.id, arrival: p.arrival_at, amount: p.amount_cents, status: p.status })), lastSync, timezone: c.timezone });
        }
        if (url.pathname.startsWith('/api/close') || url.pathname === '/api/months') return handleClose(req, env, s, url, cfg);
        if (url.pathname === '/api/export.csv') {
          const { lines } = await ledgerFor(env, s, url);
          const seg = url.searchParams.get('segment');
          const out = seg ? lines.filter((l) => l.segment === seg) : lines;
          await logAccess(env, req, s.loc, s.email, 'download', `payments.csv${seg ? ` (${seg})` : ''}`);
          return new Response(toCsv(out), { headers: headers(env, 'text/csv; charset=utf-8', { 'Content-Disposition': 'attachment; filename="payments.csv"' }) });
        }
      }
      return json(env, { error: 'not found' }, 404);
    } catch (e) {
      console.error(e);
      return json(env, { error: 'Something went wrong on our side. Please try again.' }, 500);
    }
  },

  async scheduled(_: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(syncAll(env));
    // Keep a year of access history; free D1 has room for far more, but older rows answer nothing.
    ctx.waitUntil(env.DB.prepare('DELETE FROM access_log WHERE at < ?').bind(now() - 365 * 86400).run());
  },
};
