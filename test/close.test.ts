import { describe, expect, it } from 'vitest';
import { closableMonth, monthlyBreakdownCsv, quickbooksCsv, quickbooksJournals, summariseMonth, summaryCsv } from '../src/close';
import type { LedgerLine, LocationConfig } from '../src/types';

const cfg = {
  displayName: 'Example Property Co', timezone: 'America/Chicago', viewers: [], incomeTypes: [], rules: [],
  segments: ['Main Street Building', 'Coaching'], fallback: { segment: 'Other income' },
  quickbooks: { bank: 'Example Checking' },
} as unknown as LocationConfig;

const line = (o: Partial<LedgerLine>): LedgerLine => ({
  id: Math.random().toString(36).slice(2), date: '2026-08-03', segment: 'Main Street Building', space: '', type: 'Rent',
  payer: 'Pat Doe', title: 'Pat Doe Lease Payment', method: 'Stripe, bank debit', gross: 93000, fee: 500, net: 92500,
  payoutId: 'po_1', depositDate: '2026-08-05', flag: '', source: 'stripe', ...o,
});

const lines: LedgerLine[] = [
  line({}),
  line({ gross: 75000, fee: 2205, net: 72795, segment: 'Coaching', type: 'Coaching', method: 'Stripe, card' }),
  line({ gross: 100000, fee: 500, net: 99500, flag: 'Possibly one of your own companies' }),
  line({ gross: 52500, fee: 0, net: 52500, type: 'Security deposit', source: 'crm', method: 'Cheque', payoutId: null, depositDate: null }),
  line({ gross: 51558, fee: 0, net: 51558, type: 'Loan repayment', segment: 'Loans (not income)', source: 'crm', method: 'Cheque', payoutId: null, depositDate: null }),
  line({ gross: -72500, fee: 0, net: -72500, segment: 'Reversals and refunds', type: 'Reversal', method: 'Stripe', payoutId: 'po_1' }),
  // Paid in August, deposited in September: counts in August's summary, September's QuickBooks file
  line({ date: '2026-08-31', payoutId: 'po_2', depositDate: '2026-09-02' }),
];

describe('monthly summary', () => {
  const s = summariseMonth('2026-08', lines, cfg);
  const main = s.businesses.find((b) => b.business === 'Main Street Building')!;
  it('separates tenants, own companies and security deposits', () => {
    expect(main.thirdParty).toBe(93000 * 2);
    expect(main.ownCompanies).toBe(100000);
    expect(main.deposits).toBe(52500);
    expect(main.net).toBe(92500 * 2 + 99500 + 52500);
  });
  it('counts a confirmed own-company payment with no flag as own companies', () => {
    const b = summariseMonth('2026-08', [line({ gross: 206600, fee: 0, net: 206600, own: true })], cfg).businesses[0];
    expect(b).toMatchObject({ ownCompanies: 206600, thirdParty: 0, net: 206600 });
  });
  it('keeps loans and reversals out of the businesses', () => {
    expect(s.businesses.find((b) => b.business === 'Loans (not income)')!.loans).toBe(51558);
    expect(s.adjustments).toEqual([{ label: 'Reversals and refunds', amount: -72500 }]);
  });
  it('totals agree with the lines', () => {
    expect(s.totals.gross).toBe(lines.reduce((a, l) => a + l.gross, 0));
    expect(s.totals.fees).toBe(lines.reduce((a, l) => a + l.fee, 0));
  });
  it('writes negative adjustments as numbers, not guarded text', () => {
    expect(summaryCsv(s)).toContain('Reversals and refunds,,,,,,-725.00,,-725.00');
  });
});

describe('QuickBooks journal entries', () => {
  const { journals } = quickbooksJournals('2026-08', lines, cfg);
  it('balances every journal', () => {
    for (const j of journals) {
      const d = j.lines.reduce((a, l) => a + l.debit, 0);
      const c = j.lines.reduce((a, l) => a + l.credit, 0);
      expect(d).toBe(c);
    }
  });
  it('books a Stripe deposit as bank plus fees against income by class', () => {
    const dep = journals.find((j) => j.lines.some((l) => l.description.includes('po_1')))!;
    const bank = dep.lines.find((l) => l.account === 'Example Checking')!;
    expect(bank.debit).toBe(92500 + 72795 + 99500 - 72500);
    expect(dep.lines.find((l) => l.account === 'Merchant Fees')!.debit).toBe(500 + 2205 + 500);
    expect(dep.lines.find((l) => l.account === 'Rental Income')).toMatchObject({ credit: 193000, klass: 'Main Street Building' });
    expect(dep.lines.find((l) => l.account === 'Returned Payments')).toMatchObject({ debit: 72500 });
  });
  it('books cheques to Undeposited Funds, deposits to a liability, loans to a receivable', () => {
    const crm = journals.filter((j) => j.lines[0].account === 'Undeposited Funds');
    expect(crm).toHaveLength(2);
    expect(crm.flatMap((j) => j.lines).find((l) => l.account === 'Security Deposits Held')!.credit).toBe(52500);
    expect(crm.flatMap((j) => j.lines).find((l) => l.account === 'Loans Receivable')!.credit).toBe(51558);
  });
  it('puts a deposit that lands next month in next month\'s file', () => {
    expect(journals.some((j) => j.lines.some((l) => l.description.includes('po_2')))).toBe(false);
    expect(quickbooksJournals('2026-09', lines, cfg).journals.some((j) => j.lines.some((l) => l.description.includes('po_2')))).toBe(true);
  });
  it('writes the import columns QuickBooks expects, with US dates', () => {
    const csv = quickbooksCsv('2026-08', lines, cfg).split('\r\n');
    expect(csv[0]).toBe('Journal No.,Journal Date,Account Name,Debits,Credits,Description,Name,Class');
    expect(csv[1]).toMatch(/^PL2608-001,08\/0\d\/2026,/);
  });
});

describe('closing rules', () => {
  it('only lets a month close once it has ended', () => {
    expect(closableMonth('2026-08', '2026-09-27')).toBe(true);
    expect(closableMonth('2026-09', '2026-09-27')).toBe(false);
    expect(closableMonth('bad', '2026-09-27')).toBe(false);
  });
});

describe('all-time exports', () => {
  const twoMonths = [...lines, line({ date: '2026-09-04', gross: 93000, fee: 500, net: 92500 })];
  it('breaks every month out and the month totals add up to the all-time total', () => {
    const csv = monthlyBreakdownCsv(twoMonths, cfg);
    const totals = csv.trim().split('\r\n').filter((r) => r.split(',')[1] === 'Month total');
    expect(totals.map((r) => r.split(',')[0])).toEqual(['2026-08', '2026-09']);
    const sumNet = totals.reduce((s, r) => s + Math.round(Number(r.split(',')[9]) * 100), 0);
    expect(sumNet).toBe(summariseMonth('', twoMonths, cfg).totals.net);
  });
  it('an empty period summarises everything', () => {
    expect(summariseMonth('', twoMonths, cfg).totals.payments).toBe(twoMonths.length);
  });
});
