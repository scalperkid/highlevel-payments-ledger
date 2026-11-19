import { csvCell } from './classify';
import type { LedgerLine, LocationConfig } from './types';

/** Special segments the engine creates; they are adjustments, not a business. */
export const ADJUSTMENT_SEGMENTS = ['Reversals and refunds', 'Stripe account fees'];

export interface QbConfig {
  prefix: string;              // journal number prefix, keep short (QBO limit is 21 chars)
  bank: string;                // bank account Stripe pays out to
  undeposited: string;         // holding account for cheques, cash, transfers until matched
  stripeFees: string;
  returned: string;            // reversals and refunds
  accountsByType: Record<string, string>;
  fallbackIncome: string;
}

export const DEFAULT_QB: QbConfig = {
  prefix: 'PL',
  bank: 'Operating Checking',
  undeposited: 'Undeposited Funds',
  stripeFees: 'Merchant Fees',
  returned: 'Returned Payments',
  accountsByType: {
    Rent: 'Rental Income', Parking: 'Rental Income', 'Utilities recharge': 'Utility Reimbursements',
    'Repairs recharge': 'Repair Reimbursements', 'Security deposit': 'Security Deposits Held',
    Coaching: 'Coaching Income', 'Agency services': 'Agency Income', Sponsorship: 'Sponsorship Income',
    'Licence fee': 'Licence Fee Income', 'Product sale': 'Product Sales', 'Loan repayment': 'Loans Receivable',
  },
  fallbackIncome: 'Uncategorized Income',
};

export const qbConfig = (cfg: LocationConfig): QbConfig => ({ ...DEFAULT_QB, ...(cfg.quickbooks ?? {}), accountsByType: { ...DEFAULT_QB.accountsByType, ...(cfg.quickbooks?.accountsByType ?? {}) } });

export interface BusinessSummary {
  business: string;
  payments: number;
  thirdParty: number;     // cents, money from outside customers and tenants
  ownCompanies: number;   // cents, money paid by the owner's own companies
  deposits: number;       // cents, security deposits (a liability, not income)
  loans: number;          // cents, loan repayments (not income)
  gross: number;
  fees: number;
  net: number;            // gross less Stripe fees: what to move to that business's account
}

export interface MonthSummary {
  month: string;
  businesses: BusinessSummary[];
  adjustments: { label: string; amount: number }[];
  totals: { gross: number; fees: number; net: number; payments: number };
  basisNote: string;
}

const isOwn = (l: LedgerLine) => !!l.own || /own compan/i.test(l.flag);

export function summariseMonth(month: string, lines: LedgerLine[], cfg: LocationConfig): MonthSummary {
  const inMonth = lines.filter((l) => l.date.startsWith(month));
  const by = new Map<string, BusinessSummary>();
  const adj = new Map<string, number>();
  for (const l of inMonth) {
    if (ADJUSTMENT_SEGMENTS.includes(l.segment)) { adj.set(l.segment, (adj.get(l.segment) ?? 0) + l.net); continue; }
    const b = by.get(l.segment) ?? { business: l.segment, payments: 0, thirdParty: 0, ownCompanies: 0, deposits: 0, loans: 0, gross: 0, fees: 0, net: 0 };
    b.payments++; b.gross += l.gross; b.fees += l.fee; b.net += l.net;
    if (l.type === 'Loan repayment') b.loans += l.gross;
    else if (l.type === 'Security deposit') b.deposits += l.gross;
    else if (isOwn(l)) b.ownCompanies += l.gross;
    else b.thirdParty += l.gross;
    by.set(l.segment, b);
  }
  const order = cfg.segments;
  const businesses = [...by.values()].sort((a, b) => ((order.indexOf(a.business) + 1) || 99) - ((order.indexOf(b.business) + 1) || 99) || a.business.localeCompare(b.business));
  return {
    month,
    businesses,
    adjustments: [...adj.entries()].map(([label, amount]) => ({ label, amount })),
    totals: {
      gross: inMonth.reduce((s, l) => s + l.gross, 0), fees: inMonth.reduce((s, l) => s + l.fee, 0),
      net: inMonth.reduce((s, l) => s + l.net, 0), payments: inMonth.length,
    },
    basisNote: 'Totals are by the date each payment was received. The QuickBooks file is by bank deposit date, so a payment made on the last day of a month can land in the next month\'s deposit.',
  };
}

const $ = (c: number) => (c / 100).toFixed(2);

export function summaryCsv(s: MonthSummary): string {
  const rows: (string | number)[][] = [['Business', 'Payments', 'From customers and tenants', 'From own companies', 'Security deposits', 'Loan repayments', 'Gross received', 'Stripe fees', 'Net to transfer']];
  for (const b of s.businesses) rows.push([b.business, b.payments, $(b.thirdParty), $(b.ownCompanies), $(b.deposits), $(b.loans), $(b.gross), $(b.fees), $(b.net)]);
  for (const a of s.adjustments) rows.push([a.label, '', '', '', '', '', $(a.amount), '', $(a.amount)]);
  rows.push(['Total', s.totals.payments, '', '', '', '', $(s.totals.gross), $(s.totals.fees), $(s.totals.net)]);
  return rows.map((r) => r.map((c) => csvCell(c)).join(',')).join('\r\n') + '\r\n';
}

const mdy = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;

interface JLine { account: string; debit: number; credit: number; description: string; name: string; klass: string }

function accountFor(l: LedgerLine, qb: QbConfig): string {
  if (l.segment === 'Reversals and refunds') return qb.returned;
  if (l.segment === 'Stripe account fees') return qb.stripeFees;
  return qb.accountsByType[l.type] ?? qb.fallbackIncome;
}

/** A credit that comes out negative (a reversal) is booked as a debit instead. */
function creditLine(account: string, cents: number, description: string, name: string, klass: string): JLine {
  return cents >= 0 ? { account, debit: 0, credit: cents, description, name, klass } : { account, debit: -cents, credit: 0, description, name, klass };
}

/**
 * QuickBooks Online journal-entry import for one month, bank-deposit basis:
 * - one journal per Stripe payout that arrived in the month: Dr bank (net), Dr fees, Cr income by account and class
 * - one journal per hand-recorded payment in the month: Dr Undeposited Funds, Cr income
 * Every journal balances; the test suite checks it.
 */
export function quickbooksJournals(month: string, lines: LedgerLine[], cfg: LocationConfig): { journals: { no: string; date: string; lines: JLine[] }[] } {
  const qb = qbConfig(cfg);
  const journals: { no: string; date: string; lines: JLine[] }[] = [];
  let seq = 0;
  const no = () => `${qb.prefix}${month.slice(2, 4)}${month.slice(5, 7)}-${String(++seq).padStart(3, '0')}`;

  const payouts = new Map<string, LedgerLine[]>();
  for (const l of lines) if (l.payoutId && l.depositDate?.startsWith(month)) payouts.set(l.payoutId, [...(payouts.get(l.payoutId) ?? []), l]);
  for (const [po, ls] of [...payouts.entries()].sort((a, b) => (a[1][0].depositDate! < b[1][0].depositDate! ? -1 : 1))) {
    const date = ls[0].depositDate!;
    const net = ls.reduce((s, l) => s + l.net, 0);
    const fees = ls.reduce((s, l) => s + l.fee, 0);
    const jl: JLine[] = [];
    const desc = `Stripe deposit ${po}`;
    if (net >= 0) jl.push({ account: qb.bank, debit: net, credit: 0, description: desc, name: '', klass: '' });
    else jl.push({ account: qb.bank, debit: 0, credit: -net, description: desc, name: '', klass: '' });
    if (fees) jl.push(fees > 0 ? { account: qb.stripeFees, debit: fees, credit: 0, description: 'Stripe processing fees', name: '', klass: '' } : { account: qb.stripeFees, debit: 0, credit: -fees, description: 'Stripe processing fees returned', name: '', klass: '' });
    const grouped = new Map<string, { cents: number; klass: string; account: string }>();
    for (const l of ls) {
      const account = accountFor(l, qb);
      const klass = ADJUSTMENT_SEGMENTS.includes(l.segment) ? '' : l.segment;
      const k = account + '|' + klass;
      const g = grouped.get(k) ?? { cents: 0, klass, account };
      g.cents += l.gross; grouped.set(k, g);
    }
    for (const g of grouped.values()) if (g.cents) jl.push(creditLine(g.account, g.cents, desc, '', g.klass));
    journals.push({ no: no(), date, lines: jl });
  }

  for (const l of lines.filter((x) => x.source === 'crm' && x.date.startsWith(month)).sort((a, b) => (a.date < b.date ? -1 : 1))) {
    const desc = `${l.method}: ${l.title}`.slice(0, 200);
    const klass = ADJUSTMENT_SEGMENTS.includes(l.segment) ? '' : l.segment;
    journals.push({ no: no(), date: l.date, lines: [
      { account: qb.undeposited, debit: l.gross, credit: 0, description: desc, name: l.payer, klass: '' },
      creditLine(accountFor(l, qb), l.gross, desc, l.payer, klass),
    ] });
  }
  return { journals };
}

export function quickbooksCsv(month: string, lines: LedgerLine[], cfg: LocationConfig): string {
  const { journals } = quickbooksJournals(month, lines, cfg);
  const rows: (string | number)[][] = [['Journal No.', 'Journal Date', 'Account Name', 'Debits', 'Credits', 'Description', 'Name', 'Class']];
  for (const j of journals) for (const l of j.lines) rows.push([j.no, mdy(j.date), l.account, l.debit ? $(l.debit) : '', l.credit ? $(l.credit) : '', l.description, l.name, l.klass]);
  return rows.map((r) => r.map((c) => csvCell(c)).join(',')).join('\r\n') + '\r\n';
}

/** The month that has just finished in the location's timezone is the latest one that may be closed. */
export function closableMonth(month: string, todayIso: string): boolean {
  return /^\d{4}-\d{2}$/.test(month) && month < todayIso.slice(0, 7);
}


/** Every month in the ledger, one block of rows per month, same columns as the monthly summary with Month first. */
export function monthlyBreakdownCsv(lines: LedgerLine[], cfg: LocationConfig): string {
  const months = [...new Set(lines.map((l) => l.date.slice(0, 7)))].sort();
  const rows: (string | number)[][] = [['Month', 'Business', 'Payments', 'From customers and tenants', 'From own companies', 'Security deposits', 'Loan repayments', 'Gross received', 'Stripe fees', 'Net to transfer']];
  for (const m of months) {
    const s = summariseMonth(m, lines, cfg);
    for (const b of s.businesses) rows.push([m, b.business, b.payments, $(b.thirdParty), $(b.ownCompanies), $(b.deposits), $(b.loans), $(b.gross), $(b.fees), $(b.net)]);
    for (const a of s.adjustments) rows.push([m, a.label, '', '', '', '', '', $(a.amount), '', $(a.amount)]);
    rows.push([m, 'Month total', s.totals.payments, '', '', '', '', $(s.totals.gross), $(s.totals.fees), $(s.totals.net)]);
  }
  return rows.map((r) => r.map((c) => csvCell(c)).join(',')).join('\r\n') + '\r\n';
}
