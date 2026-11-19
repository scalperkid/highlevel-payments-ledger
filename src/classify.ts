import type { ContactRow, LedgerLine, LocationConfig, PaymentRow, RuleWhen } from './types';

const lc = (s: string | null | undefined) => (s ?? '').toLowerCase();
const anyIn = (hay: string, needles?: string[]) => !!needles?.some((n) => hay.includes(n.toLowerCase()));

export function dayIn(tz: string, unix: number): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(unix * 1000));
}

export function incomeType(cfg: LocationConfig, title: string): string {
  const t = lc(title);
  for (const it of cfg.incomeTypes) if (anyIn(t, it.any)) return it.type;
  return 'Unclassified';
}

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

/**
 * Tidies a street address into a stable space label, e.g. "120 Main St, Suite 3".
 * Typed addresses drift ("120 main st, suite 3", "120 Main ST, Suite 3"), so the label is
 * normalised before payments are grouped by it. `aliases` comes from the location config
 * (case-insensitive pattern to replacement) for fixes that only make sense for one portfolio.
 */
export function normaliseSpace(address: string, aliases: Record<string, string> = {}): string {
  let s = address
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\b(ne|nw|se|sw|n|s|e|w)\b(?=\s)/gi, (d) => d.toUpperCase())
    .replace(/\bsuite\b/gi, 'Suite')
    .replace(/\bunit\b/gi, 'Unit');
  for (const [pattern, replacement] of Object.entries(aliases)) s = s.replace(new RegExp(pattern, 'gi'), replacement);
  return s.replace(/\b(st|ave|rd|ln|dr|blvd)\b(?=,|$)/gi, cap);
}

function matches(when: RuleWhen, ctx: { type: string; title: string; payer: string; origin: string; contact?: ContactRow }): boolean {
  if (when.typeIn && !when.typeIn.includes(ctx.type)) return false;
  if (when.titleAny && !anyIn(lc(ctx.title), when.titleAny)) return false;
  if (when.payerAny && !anyIn(lc(ctx.payer), when.payerAny)) return false;
  if (when.originIs && when.originIs !== ctx.origin) return false;
  if (when.addressFrom) {
    const tags: string[] = ctx.contact?.tags_json ? JSON.parse(ctx.contact.tags_json) : [];
    const byTag = !!when.addressFrom.tag && tags.map(lc).includes(lc(when.addressFrom.tag));
    const byAddr = anyIn(lc(ctx.contact?.address), when.addressFrom.addressAny);
    if (!(byTag || byAddr) || !ctx.contact?.address) return false;
  }
  return true;
}

/**
 * Turns raw Stripe and CRM rows into ledger lines.
 * - Stripe rows are the record for anything paid through Stripe (they carry fee, net and payout).
 * - CRM rows paid through Stripe are used only to enrich the matching Stripe row (payer, title, contact).
 * - CRM rows recorded by hand (cheque, cash, transfer) appear on their own; they have no fee or deposit.
 */
export function buildLedger(
  locationId: string,
  cfg: LocationConfig,
  rows: PaymentRow[],
  contacts: Map<string, ContactRow>,
  payoutArrival: Map<string, number>,
): LedgerLine[] {
  const crmByPi = new Map<string, PaymentRow>();
  for (const r of rows) if (r.source === 'crm' && r.kind === 'crm_stripe' && r.payment_intent) crmByPi.set(r.payment_intent, r);

  const lines: LedgerLine[] = [];
  for (const r of rows) {
    if (r.source === 'crm' && (r.kind !== 'crm_manual' || r.status !== 'succeeded')) continue;

    const crm = r.source === 'stripe' && r.payment_intent ? crmByPi.get(r.payment_intent) : undefined;
    const title = crm?.title ?? r.title ?? '';
    const payer = crm?.payer ?? r.payer ?? '';
    const contactId = crm?.contact_id ?? r.contact_id ?? undefined;
    const contact = contactId ? contacts.get(contactId) : undefined;
    const origin = r.source === 'crm' ? locationId : (r.origin_location ?? 'external');

    let segment = cfg.fallback.segment;
    let space = '';
    let type = incomeType(cfg, title);
    let flag = cfg.fallback.flag ?? '';
    let own = false;

    if (r.kind === 'reversal') {
      segment = 'Reversals and refunds'; type = 'Reversal'; flag = 'Reverses an earlier payment';
    } else if (r.kind === 'fee') {
      segment = 'Stripe account fees'; type = 'Fee'; flag = '';
    } else {
      for (const rule of cfg.rules) {
        if (!matches(rule.when, { type, title, payer, origin, contact })) continue;
        segment = rule.set.segment;
        type = rule.set.type ?? type;
        space = rule.set.space === '$address' ? normaliseSpace(contact?.address ?? '', cfg.spaceAliases) : (rule.set.space ?? '');
        flag = rule.flag ?? '';
        own = !!rule.own;
        break;
      }
      if (!flag && !own && cfg.ownCompanies && anyIn(lc(`${title} ${payer}`), cfg.ownCompanies)) {
        flag = 'Possibly one of your own companies';
        own = true;
      }
    }

    const ov = cfg.overrides?.[r.id];
    if (ov) {
      segment = ov.segment ?? segment; space = ov.space ?? space; type = ov.type ?? type;
      flag = ov.note ? `Set by hand: ${ov.note}` : '';
    }

    const arrival = r.payout_id ? payoutArrival.get(r.payout_id) : undefined;
    lines.push({
      id: r.id,
      date: dayIn(cfg.timezone, r.occurred_at),
      segment, space, type, payer, title,
      method: r.method ?? '',
      gross: r.gross_cents, fee: r.fee_cents, net: r.net_cents,
      payoutId: r.payout_id,
      depositDate: arrival ? dayIn(cfg.timezone, arrival) : null,
      flag,
      ...(own ? { own } : {}),
      source: r.source,
    });
  }
  lines.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id.localeCompare(b.id)));
  return lines;
}

/** Text cells that a spreadsheet would read as a formula get a leading apostrophe; numbers pass through. */
export const csvCell = (v: string | number | null) => {
  let s = v === null ? '' : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const money = (c: number) => (c / 100).toFixed(2);

export function toCsv(lines: LedgerLine[]): string {
  const head = ['Date', 'Business', 'Space', 'Income type', 'Payer', 'Invoice or description', 'How paid', 'Gross', 'Stripe fee', 'Net', 'Bank deposit date', 'Stripe payout', 'Check'];
  const body = lines.map((l) => [l.date, l.segment, l.space, l.type, l.payer, l.title, l.method, money(l.gross), money(l.fee), money(l.net), l.depositDate, l.payoutId, l.flag].map(csvCell).join(','));
  return [head.join(','), ...body].join('\r\n') + '\r\n';
}
