import { describe, expect, it } from 'vitest';
import { buildLedger, normaliseSpace, toCsv } from '../src/classify';
import type { ContactRow, LocationConfig, PaymentRow } from '../src/types';

// Synthetic tenant, invented names only.
const LOC = 'loc_main';
const cfg: LocationConfig = {
  displayName: 'Example Property Co',
  timezone: 'America/Chicago',
  viewers: ['owner@example.com'],
  segments: ['Main Street Building', 'Oak Lane Property', 'Coaching', 'Events'],
  incomeTypes: [
    { any: ['loan'], type: 'Loan repayment' },
    { any: ['lease', 'rent', 'suite'], type: 'Rent' },
    { any: ['coaching'], type: 'Coaching' },
  ],
  rules: [
    { when: { typeIn: ['Loan repayment'] }, set: { segment: 'Loans (not income)' }, flag: 'Loan repayment, not sales income' },
    { when: { originIs: 'loc_events' }, set: { segment: 'Events', type: 'Sponsorship' } },
    { when: { typeIn: ['Rent'], titleAny: ['oak lane'] }, set: { segment: 'Oak Lane Property', space: '7 Oak Lane' } },
    { when: { typeIn: ['Rent'], addressFrom: { tag: 'tenant main', addressAny: ['main st'] } }, set: { segment: 'Main Street Building', space: '$address' } },
    { when: { typeIn: ['Rent'] }, set: { segment: 'Main Street Building', space: 'Space not on record' }, flag: 'Confirm property and suite' },
    { when: { typeIn: ['Coaching'] }, set: { segment: 'Coaching' } },
  ],
  fallback: { segment: 'Other income', flag: 'Needs a category' },
  ownCompanies: ['example property co'],
};

const base = (o: Partial<PaymentRow>): PaymentRow => ({
  id: 'x', location_id: LOC, source: 'stripe', kind: 'payment', status: 'succeeded', occurred_at: 1790000000,
  gross_cents: 10000, fee_cents: 500, net_cents: 9500, method: 'Stripe, bank debit', payer: null, contact_id: null,
  title: '', payment_intent: null, origin_location: LOC, payout_id: null, ...o,
});

const contacts = new Map<string, ContactRow>([
  ['c1', { contact_id: 'c1', name: 'Pat Doe', company: null, address: '12 sw main st, suite 4', tags_json: '["tenant main"]' }],
  ['c2', { contact_id: 'c2', name: 'Sam Roe', company: null, address: null, tags_json: '[]' }],
]);

describe('buildLedger', () => {
  const rows: PaymentRow[] = [
    // Stripe row enriched from its CRM twin (same payment intent)
    base({ id: 'txn_1', payment_intent: 'pi_1', payout_id: 'po_1' }),
    base({ id: 'crm:a', source: 'crm', kind: 'crm_stripe', payment_intent: 'pi_1', title: 'Pat Doe Lease Payment', payer: 'Pat Doe', contact_id: 'c1', fee_cents: 0 }),
    // Hand-recorded cheque
    base({ id: 'crm:b', source: 'crm', kind: 'crm_manual', method: 'Cheque', title: 'Oak Lane rent June', payer: 'Acme', fee_cents: 0, net_cents: 10000 }),
    // Failed CRM row must not appear
    base({ id: 'crm:c', source: 'crm', kind: 'crm_manual', status: 'failed', title: 'Pat Doe Lease Payment' }),
    // Rent with no address on file
    base({ id: 'crm:d', source: 'crm', kind: 'crm_manual', title: 'Sam Roe Lease Payment', payer: 'Sam Roe', contact_id: 'c2' }),
    // Another sub-account's payment settling into the same Stripe
    base({ id: 'txn_2', origin_location: 'loc_events', title: 'Payment for invoice 000033' }),
    base({ id: 'crm:e', source: 'crm', kind: 'crm_manual', title: 'Loan Pmt - Pat' }),
    base({ id: 'txn_3', kind: 'reversal', gross_cents: -10000, fee_cents: 0, net_cents: -10000 }),
    base({ id: 'crm:f', source: 'crm', kind: 'crm_manual', title: 'Example Property Co coaching' }),
  ];
  const lines = buildLedger(LOC, cfg, rows, contacts, new Map([['po_1', 1790100000]]));
  const byId = Object.fromEntries(lines.map((l) => [l.id, l]));

  it('shows each payment once and hides the CRM twin and failed rows', () => {
    expect(lines.map((l) => l.id).sort()).toEqual(['crm:b', 'crm:d', 'crm:e', 'crm:f', 'txn_1', 'txn_2', 'txn_3']);
  });
  it('places rent by the tenant address and tidies the space label', () => {
    expect(byId.txn_1).toMatchObject({ segment: 'Main Street Building', space: '12 SW main St, Suite 4', payer: 'Pat Doe', fee: 500, depositDate: '2026-09-22' });
  });
  it('places rent by invoice title', () => {
    expect(byId['crm:b']).toMatchObject({ segment: 'Oak Lane Property', space: '7 Oak Lane', method: 'Cheque' });
  });
  it('flags rent it cannot place instead of guessing', () => {
    expect(byId['crm:d']).toMatchObject({ space: 'Space not on record', flag: 'Confirm property and suite' });
  });
  it('uses the origin sub-account for payments raised elsewhere', () => {
    expect(byId.txn_2).toMatchObject({ segment: 'Events', type: 'Sponsorship' });
  });
  it('keeps loans and reversals apart from income', () => {
    expect(byId['crm:e'].segment).toBe('Loans (not income)');
    expect(byId.txn_3).toMatchObject({ segment: 'Reversals and refunds', gross: -10000 });
  });
  it('flags possible payments between the owner companies', () => {
    expect(byId['crm:f']).toMatchObject({ segment: 'Coaching', flag: 'Possibly one of your own companies' });
  });
  it('treats a rule-confirmed own company as settled, not as something to confirm', () => {
    const own = { ...cfg, rules: [{ when: { typeIn: ['Coaching'] }, set: { segment: 'Coaching' }, own: true }, ...cfg.rules] };
    const l = buildLedger(LOC, own, rows, contacts, new Map()).find((x) => x.id === 'crm:f')!;
    expect(l).toMatchObject({ segment: 'Coaching', flag: '', own: true });
  });
  it('lets a manual override win', () => {
    const l = buildLedger(LOC, { ...cfg, overrides: { 'crm:d': { segment: 'Oak Lane Property', space: '7 Oak Lane', note: 'confirmed by owner' } } }, rows, contacts, new Map());
    expect(l.find((x) => x.id === 'crm:d')).toMatchObject({ segment: 'Oak Lane Property', flag: 'Set by hand: confirmed by owner' });
  });
  it('exports CSV with quoted cells', () => {
    const csv = toCsv([{ ...byId['crm:b'], title: 'Rent, "June"' }]);
    expect(csv.split('\r\n')[1]).toContain('"Rent, ""June"""');
  });
});

describe('normaliseSpace', () => {
  it('produces one label for differently typed addresses', () => {
    expect(normaliseSpace('120  main st, suite 6')).toBe('120 main St, Suite 6');
    expect(normaliseSpace('120 Main ST, Suite 3')).toBe('120 Main St, Suite 3');
    expect(normaliseSpace('40 sw Oak Ave')).toBe('40 SW Oak Ave');
  });
  it('applies the per-location aliases from config', () => {
    const aliases = { '\\bmain\\b(\\s+st\\b)?': 'Main St' };
    expect(normaliseSpace('120 Main, Suite 7', aliases)).toBe('120 Main St, Suite 7');
    expect(normaliseSpace('120 main st, Suite 7', aliases)).toBe('120 Main St, Suite 7');
  });
});

describe('CSV export safety', () => {
  it('neutralises text that a spreadsheet would run as a formula, but keeps negative amounts numeric', async () => {
    const { csvCell } = await import('../src/classify');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1 555')).toBe("'+1 555");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell(-17)).toBe('-17');
    expect(csvCell('-725.00')).toBe('-725.00');
    expect(csvCell('-cheat')).toBe("'-cheat");
    expect(csvCell('Example Salon')).toBe('Example Salon');
  });
});
