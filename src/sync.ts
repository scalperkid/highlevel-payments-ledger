import { seal, unseal } from './crypto';
import type { Env } from './types';

const GHL = 'https://services.leadconnectorhq.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

// Free plan: 50 subrequests per invocation. Keep each run well under it.
const MAX_STRIPE_PAGES = 3;
const MAX_PAYOUTS_MAPPED = 15;
const MAX_CONTACTS = 15;

const now = () => Math.floor(Date.now() / 1000);

async function getState(env: Env, loc: string, key: string): Promise<string | null> {
  const r = await env.DB.prepare('SELECT value FROM sync_state WHERE location_id=? AND key=?').bind(loc, key).first<{ value: string }>();
  return r?.value ?? null;
}
async function setState(env: Env, loc: string, key: string, value: string | null) {
  await env.DB.prepare('INSERT INTO sync_state (location_id,key,value) VALUES (?,?,?) ON CONFLICT(location_id,key) DO UPDATE SET value=excluded.value').bind(loc, key, value).run();
}
async function log(env: Env, loc: string, step: string, ok: boolean, detail: string) {
  await env.DB.prepare('INSERT INTO sync_log (location_id,at,step,ok,detail) VALUES (?,?,?,?,?)').bind(loc, now(), step, ok ? 1 : 0, detail.slice(0, 500)).run();
}

// ---------------------------------------------------------------- HighLevel token

interface InstallRow { location_id: string; company_id: string | null; access_enc: string; refresh_enc: string; expires_at: number; user_type: string }

export const companyKey = (companyId: string) => `company:${companyId}`;

/** Returns a live access token for a stored row, refreshing it (single-use refresh token rotates) when needed. */
async function rowToken(env: Env, row: InstallRow): Promise<string | null> {
  if (row.expires_at - 300 > now()) return unseal(row.access_enc, env.ENC_KEY!);
  if (!row.refresh_enc) return null;
  const refresh = await unseal(row.refresh_enc, env.ENC_KEY!);
  const body = new URLSearchParams({
    client_id: env.GHL_CLIENT_ID!, client_secret: env.GHL_CLIENT_SECRET!,
    grant_type: 'refresh_token', refresh_token: refresh, user_type: row.user_type === 'Company' ? 'Company' : 'Location',
  });
  const r = await fetch(`${GHL}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': UA }, body });
  const j = (await r.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; message?: string };
  if (!r.ok || !j.access_token || !j.refresh_token) throw new Error(`token refresh failed ${r.status} ${j.message ?? ''}`);
  await env.DB.prepare('UPDATE installs SET access_enc=?, refresh_enc=?, expires_at=?, scope=?, updated_at=? WHERE location_id=?')
    .bind(await seal(j.access_token, env.ENC_KEY!), await seal(j.refresh_token, env.ENC_KEY!), now() + (j.expires_in ?? 86399), j.scope ?? null, now(), row.location_id).run();
  return j.access_token;
}

/** Mints a location token from the agency (company) token of a bulk install and caches it. */
export async function mintLocationToken(env: Env, companyId: string, loc: string): Promise<string> {
  const crow = await env.DB.prepare('SELECT * FROM installs WHERE location_id=?').bind(companyKey(companyId)).first<InstallRow>();
  if (!crow) throw new Error('no agency install on record');
  const ctoken = await rowToken(env, crow);
  if (!ctoken) throw new Error('agency token expired');
  const r = await fetch(`${GHL}/oauth/locationToken`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ctoken}`, Version: '2021-07-28', 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': UA },
    body: new URLSearchParams({ companyId, locationId: loc }),
  });
  const j = (await r.json()) as { access_token?: string; expires_in?: number; scope?: string; message?: string };
  if (!r.ok || !j.access_token) throw new Error(`location token mint failed ${r.status} ${j.message ?? ''}`);
  await env.DB.prepare(`INSERT INTO installs (location_id,company_id,access_enc,refresh_enc,expires_at,scope,user_type,updated_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(location_id) DO UPDATE SET company_id=excluded.company_id, access_enc=excluded.access_enc, refresh_enc=excluded.refresh_enc, expires_at=excluded.expires_at, scope=excluded.scope, user_type=excluded.user_type, updated_at=excluded.updated_at`)
    .bind(loc, companyId, await seal(j.access_token, env.ENC_KEY!), '', now() + (j.expires_in ?? 86399), j.scope ?? null, 'Minted', now()).run();
  return j.access_token;
}

export async function ghlToken(env: Env, loc: string): Promise<string> {
  const row = await env.DB.prepare('SELECT * FROM installs WHERE location_id=?').bind(loc).first<InstallRow>();
  if (row) {
    const t = await rowToken(env, row);
    if (t) return t;
    if (row.user_type === 'Minted' && row.company_id) return mintLocationToken(env, row.company_id, loc);
  }
  // No usable location row: fall back to any agency install that covers this location.
  const comp = await env.DB.prepare("SELECT company_id FROM installs WHERE user_type='Company' ORDER BY updated_at DESC LIMIT 1").first<{ company_id: string }>();
  if (comp?.company_id) return mintLocationToken(env, comp.company_id, loc);
  throw new Error(row ? 'stored CRM token has expired; reinstall the app' : 'app not installed on this location');
}

async function ghlGet<T>(token: string, path: string): Promise<T> {
  const r = await fetch(`${GHL}${path}`, { headers: { Authorization: `Bearer ${token}`, Version: '2021-07-28', Accept: 'application/json', 'User-Agent': UA } });
  if (!r.ok) throw new Error(`GET ${path.split('?')[0]} ${r.status}`);
  return (await r.json()) as T;
}

// ---------------------------------------------------------------- CRM payments

const MANUAL_METHOD: Record<string, string> = { cheque: 'Cheque', bank_transfer: 'Bank transfer', cash: 'Cash', other: 'Other, recorded by hand' };

interface GhlTxn {
  _id: string; amount: number; status: string; createdAt: string; contactId?: string; contactName?: string;
  entitySourceName?: string; paymentProviderType?: string; chargeId?: string; chargeSnapshot?: { mode?: string };
}

export async function syncCrm(env: Env, loc: string): Promise<string> {
  const token = await ghlToken(env, loc);
  let offset = 0; let total = Infinity; let n = 0;
  while (offset < total && offset < 5000) {
    const d = await ghlGet<{ data: GhlTxn[]; totalCount: number }>(token, `/payments/transactions?altId=${loc}&altType=location&limit=100&offset=${offset}`);
    total = d.totalCount;
    const stmts = d.data.map((x) => {
      const manual = x.paymentProviderType === 'manual';
      const cents = Math.round(Number(x.amount) * 100);
      return env.DB.prepare(`INSERT INTO payments (id,location_id,source,kind,status,occurred_at,gross_cents,fee_cents,net_cents,method,payer,contact_id,title,payment_intent,origin_location,payout_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
        ON CONFLICT(location_id,id) DO UPDATE SET status=excluded.status, title=excluded.title, payer=excluded.payer, contact_id=excluded.contact_id, method=excluded.method, gross_cents=excluded.gross_cents, net_cents=excluded.net_cents`)
        .bind(`crm:${x._id}`, loc, 'crm', manual ? 'crm_manual' : 'crm_stripe', x.status, Math.floor(Date.parse(x.createdAt) / 1000), cents, 0, cents,
          manual ? (MANUAL_METHOD[x.chargeSnapshot?.mode ?? 'other'] ?? 'Other, recorded by hand') : 'Stripe',
          x.contactName ?? null, x.contactId ?? null, (x.entitySourceName ?? '').replace(/\s+/g, ' ').trim(), manual ? null : (x.chargeId ?? null), loc);
    });
    if (stmts.length) await env.DB.batch(stmts);
    n += d.data.length; offset += 100;
    if (!d.data.length) break;
  }

  // Contacts we have not fetched yet (address and tags drive property and suite).
  const missing = await env.DB.prepare(`SELECT DISTINCT p.contact_id AS id FROM payments p LEFT JOIN contacts c ON c.location_id=p.location_id AND c.contact_id=p.contact_id
    WHERE p.location_id=? AND p.contact_id IS NOT NULL AND c.contact_id IS NULL LIMIT ?`).bind(loc, MAX_CONTACTS).all<{ id: string }>();
  for (const { id } of missing.results) {
    try {
      const c = (await ghlGet<{ contact: { firstName?: string; lastName?: string; companyName?: string; address1?: string; tags?: string[] } }>(token, `/contacts/${id}`)).contact;
      await env.DB.prepare('INSERT OR REPLACE INTO contacts (location_id,contact_id,name,company,address,tags_json,fetched_at) VALUES (?,?,?,?,?,?,?)')
        .bind(loc, id, [c.firstName, c.lastName].filter(Boolean).join(' '), c.companyName ?? null, c.address1 ?? null, JSON.stringify(c.tags ?? []), now()).run();
    } catch (e) {
      await env.DB.prepare('INSERT OR REPLACE INTO contacts (location_id,contact_id,name,fetched_at) VALUES (?,?,?,?)').bind(loc, id, null, now()).run();
    }
  }
  return `crm ${n} rows, ${missing.results.length} contacts fetched`;
}

// ---------------------------------------------------------------- Stripe

interface StripeBt {
  id: string; type: string; amount: number; fee: number; net: number; created: number; description: string | null;
  source: null | string | {
    id: string; object: string; description?: string | null; payment_intent?: string | null; metadata?: Record<string, string>;
    billing_details?: { name?: string | null }; receipt_email?: string | null; payment_method_details?: { type?: string };
    arrival_date?: number; status?: string;
  };
}

async function stripeGet<T>(key: string, path: string, params: Record<string, string | string[]>): Promise<T> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) for (const one of Array.isArray(v) ? v : [v]) q.append(k, one);
  const r = await fetch(`https://api.stripe.com${path}?${q}`, { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`stripe ${path} ${r.status}`);
  return (await r.json()) as T;
}

function btRow(env: Env, loc: string, b: StripeBt) {
  const s = typeof b.source === 'object' && b.source ? b.source : null;
  if (b.type === 'payout') {
    return env.DB.prepare(`INSERT INTO payouts (id,location_id,arrival_at,amount_cents,status) VALUES (?,?,?,?,?)
      ON CONFLICT(location_id,id) DO UPDATE SET arrival_at=excluded.arrival_at, status=excluded.status`)
      .bind(s?.id ?? String(b.source), loc, s?.arrival_date ?? b.created, -b.amount, s?.status ?? null);
  }
  const kind = b.type === 'charge' || b.type === 'payment' ? 'payment'
    : ['refund', 'payment_refund', 'payment_failure_refund'].includes(b.type) ? 'reversal' : 'fee';
  const pmd = s?.payment_method_details?.type ?? '';
  const method = kind !== 'payment' ? 'Stripe' : (pmd === 'us_bank_account' || pmd === 'ach_debit' || b.type === 'payment') ? 'Stripe, bank debit' : 'Stripe, card';
  const meta = s?.metadata ?? {};
  return env.DB.prepare(`INSERT INTO payments (id,location_id,source,kind,status,occurred_at,gross_cents,fee_cents,net_cents,method,payer,contact_id,title,payment_intent,origin_location)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(location_id,id) DO NOTHING`)
    .bind(b.id, loc, 'stripe', kind, 'succeeded', b.created, b.amount, b.fee, b.net, method,
      s?.billing_details?.name ?? s?.receipt_email ?? null, null, s?.description ?? b.description ?? '', s?.payment_intent ?? null,
      meta.locationId ?? meta.location_id ?? null);
}

export async function syncStripe(env: Env, loc: string, key: string): Promise<string> {
  // Backfill walks from newest to oldest with starting_after; once done, each run
  // re-reads the last two days so late payout links and reversals are picked up.
  const backfillDone = (await getState(env, loc, 'bt_backfill_done')) === '1';
  let after = await getState(env, loc, 'bt_backfill_after');
  const since = Number((await getState(env, loc, 'bt_latest')) ?? 0);
  let pages = 0; let rows = 0; let latest = since; let incCursor: string | undefined;
  while (pages < MAX_STRIPE_PAGES) {
    const params: Record<string, string | string[]> = { limit: '100', 'expand[]': 'data.source' };
    if (!backfillDone && after) params.starting_after = after;
    if (backfillDone) params['created[gte]'] = String(Math.max(0, since - 2 * 86400));
    if (backfillDone && incCursor) params.starting_after = incCursor;
    const d = await stripeGet<{ data: StripeBt[]; has_more: boolean }>(key, '/v1/balance_transactions', params);
    pages++; rows += d.data.length;
    if (d.data.length) await env.DB.batch(d.data.map((b) => btRow(env, loc, b)));
    for (const b of d.data) latest = Math.max(latest, b.created);
    if (!backfillDone) {
      after = d.data.at(-1)?.id ?? after;
      await setState(env, loc, 'bt_backfill_after', after);
      if (!d.has_more) { await setState(env, loc, 'bt_backfill_done', '1'); break; }
    } else if (!d.has_more) break;
    else incCursor = d.data.at(-1)!.id;
  }
  if (latest > since) await setState(env, loc, 'bt_latest', String(latest));

  // Link payments to the bank deposit (payout) that carried them.
  const todo = await env.DB.prepare(`SELECT id FROM payouts WHERE location_id=? AND mapped=0 AND (status IS NULL OR status='paid') ORDER BY arrival_at DESC LIMIT ?`).bind(loc, MAX_PAYOUTS_MAPPED).all<{ id: string }>();
  for (const { id } of todo.results) {
    const ids: string[] = []; let start: string | undefined;
    for (let i = 0; i < 3; i++) {
      const p: Record<string, string> = { limit: '100', payout: id };
      if (start) p.starting_after = start;
      const d = await stripeGet<{ data: { id: string; type: string }[]; has_more: boolean }>(key, '/v1/balance_transactions', p);
      for (const t of d.data) if (t.type !== 'payout') ids.push(t.id);
      if (!d.has_more) break;
      start = d.data.at(-1)?.id;
    }
    const stmts = ids.map((t) => env.DB.prepare('UPDATE payments SET payout_id=? WHERE location_id=? AND id=?').bind(id, loc, t));
    stmts.push(env.DB.prepare('UPDATE payouts SET mapped=1 WHERE location_id=? AND id=?').bind(loc, id));
    await env.DB.batch(stmts);
  }
  return `stripe ${rows} rows in ${pages} pages${backfillDone ? '' : ' (backfill)'}, ${todo.results.length} payouts linked`;
}

// ---------------------------------------------------------------- orchestration

export async function syncLocation(env: Env, loc: string): Promise<string[]> {
  const out: string[] = [];
  const cfg = await env.DB.prepare('SELECT stripe_key_enc FROM location_config WHERE location_id=?').bind(loc).first<{ stripe_key_enc: string | null }>();
  if (cfg?.stripe_key_enc) {
    try { const m = await syncStripe(env, loc, await unseal(cfg.stripe_key_enc, env.ENC_KEY!)); out.push(m); await log(env, loc, 'stripe', true, m); }
    catch (e) { const m = String(e); out.push(m); await log(env, loc, 'stripe', false, m); }
  }
  try { const m = await syncCrm(env, loc); out.push(m); await log(env, loc, 'crm', true, m); }
  catch (e) { const m = String(e); out.push(m); await log(env, loc, 'crm', false, m); }
  await setState(env, loc, 'last_sync', String(now()));
  return out;
}

export async function syncAll(env: Env): Promise<void> {
  const locs = await env.DB.prepare('SELECT location_id FROM location_config').all<{ location_id: string }>();
  // One location per run keeps each invocation inside the subrequest budget; rotate.
  const list = locs.results.map((r) => r.location_id);
  if (!list.length) return;
  const slot = Math.floor(Date.now() / (15 * 60 * 1000)) % list.length;
  await syncLocation(env, list[slot]);
}
