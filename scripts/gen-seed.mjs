// Generates scripts/seed-dev.sql: an invented property business for local preview.
// No real names or amounts. Shape mirrors a live tenant: monthly rents across suites,
// a single large lease elsewhere, coaching income, hand-recorded cheques, Stripe fees,
// payouts that bundle several payments, a bounced bank debit, and rows needing review.
import { writeFileSync } from 'node:fs';

const LOC = 'dev_location';
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const q = (s) => (s === null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);
const out = [];

const config = {
  displayName: 'Example Holdings',
  timezone: 'America/Chicago',
  viewers: ['preview@example.com'],
  segments: ['Main Street Building', 'Oak Lane Property', 'New property', 'Coaching', 'Agency services', 'Software'],
  incomeTypes: [
    { any: ['loan'], type: 'Loan repayment' },
    { any: ['lease', 'rent', 'suite', 'deposit'], type: 'Rent' },
    { any: ['parking'], type: 'Parking' },
    { any: ['coaching'], type: 'Coaching' },
    { any: ['agency', 'website'], type: 'Agency services' },
  ],
  rules: [
    { when: { typeIn: ['Loan repayment'] }, set: { segment: 'Loans (not income)' }, flag: 'Loan repayment, not sales income' },
    { when: { originIs: 'dev_events' }, set: { segment: 'Events', type: 'Sponsorship' }, flag: 'Not one of the named businesses, confirm where it belongs' },
    { when: { typeIn: ['Rent'], titleAny: ['oak lane'] }, set: { segment: 'Oak Lane Property', space: '7 Oak Lane, Unit B' } },
    { when: { typeIn: ['Rent', 'Parking'], addressFrom: { tag: 'tenant main street', addressAny: ['main st'] } }, set: { segment: 'Main Street Building', space: '$address' } },
    { when: { typeIn: ['Rent', 'Parking'] }, set: { segment: 'Main Street Building', space: 'Space not on record' }, flag: 'Confirm property and suite' },
    { when: { typeIn: ['Coaching'] }, set: { segment: 'Coaching' } },
    { when: { typeIn: ['Agency services'] }, set: { segment: 'Agency services' } },
  ],
  fallback: { segment: 'Other income', flag: 'Needs a category' },
  ownCompanies: ['example holdings'],
};
out.push(`INSERT OR REPLACE INTO location_config (location_id,config_json,updated_at) VALUES (${q(LOC)},${q(JSON.stringify(config))},${Math.floor(Date.now() / 1000)});`);

const tenants = [
  ['t1', 'Morgan Ellis', 'Ellis Counseling', '120 Main St, Suite 2', 925],
  ['t2', 'Priya Natarajan', 'Natarajan Tax', '120 Main St, Suite 4', 780],
  ['t3', 'Diego Alvarez', 'Alvarez Barber Co', '18 Second St', 1050],
  ['t4', 'Hannah Brooks', 'Brooks Massage', '120 Main St, Suite 6', 625],
  ['t5', 'Owen Gallagher', 'Gallagher Insurance', '120 Main St, Suite 8', 930],
  ['t6', 'Lena Fischer', 'Fischer Studio', '116 Main St', 2950],
  ['t7', 'Marcus Reed', null, null, 640],
];
for (const [id, name, company, address, _] of tenants) {
  out.push(`INSERT OR REPLACE INTO contacts VALUES (${q(LOC)},${q(id)},${q(name)},${q(company)},${q(address)},${q(JSON.stringify(address ? ['tenant main street'] : []))},0);`);
}

const rows = [];
const add = (r) => rows.push(r);
const day = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d, 16) / 1000);
let n = 0;
const months = [];
for (let y = 2025, m = 10; y < 2026 || m <= 9; m++) { if (m > 12) { m = 1; y++; } months.push([y, m]); if (y === 2026 && m === 9) break; }

for (const [y, m] of months) {
  for (const [cid, name, , , rent] of tenants) {
    if (rnd() < 0.04) continue;
    const manual = rnd() < 0.35;
    const cents = rent * 100;
    const t = day(y, m, 1 + Math.floor(rnd() * 5));
    const title = `${name} Lease Payment`;
    if (manual) {
      add({ id: `crm:${++n}`, source: 'crm', kind: 'crm_manual', status: 'succeeded', t, cents, fee: 0, method: rnd() < 0.8 ? 'Cheque' : 'Bank transfer', payer: name, contact: cid, title });
    } else {
      const pi = `pi_dev_${++n}`;
      const fee = 500;
      add({ id: `txn_dev_${n}`, source: 'stripe', kind: 'payment', status: 'succeeded', t, cents, fee, method: 'Stripe, bank debit', payer: null, contact: null, title: 'Payment for invoice', pi, origin: LOC });
      add({ id: `crm:${n}s`, source: 'crm', kind: 'crm_stripe', status: 'succeeded', t, cents, fee: 0, method: 'Stripe', payer: name, contact: cid, title, pi });
    }
  }
  // One large lease on another property, invoiced by title
  add({ id: `crm:${++n}`, source: 'crm', kind: 'crm_manual', status: 'succeeded', t: day(y, m, 6), cents: 7000_00 + Math.floor(rnd() * 200_00), fee: 0, method: 'Other, recorded by hand', payer: 'Example Logistics LLC', contact: null, title: `Oak Lane rent invoice ${y}-${String(m).padStart(2, '0')}` });
  // Coaching by card
  if (rnd() < 0.8) { const pi = `pi_dev_${++n}`; add({ id: `txn_dev_${n}`, source: 'stripe', kind: 'payment', status: 'succeeded', t: day(y, m, 15), cents: 750_00, fee: 2205, method: 'Stripe, card', payer: 'Jordan Pike', contact: null, title: 'Jordan Pike Coaching', pi, origin: LOC }); }
  // Events income from another sub-account settling into the same Stripe
  if (rnd() < 0.5) add({ id: `txn_dev_${++n}`, source: 'stripe', kind: 'payment', status: 'succeeded', t: day(y, m, 20), cents: 250_00, fee: 755, method: 'Stripe, card', payer: 'Example Sponsor Inc', contact: null, title: 'Payment for invoice 000' + (30 + n % 60), origin: 'dev_events' });
}
add({ id: `crm:${++n}`, source: 'crm', kind: 'crm_manual', status: 'succeeded', t: day(2026, 7, 11), cents: 515_58, fee: 0, method: 'Cheque', payer: 'Morgan Ellis', contact: 't1', title: 'Loan Pmt - Ellis' });
add({ id: `txn_dev_${++n}`, source: 'stripe', kind: 'reversal', status: 'succeeded', t: day(2026, 4, 3), cents: -725_00, fee: 0, method: 'Stripe', payer: null, contact: null, title: 'Bank payment returned' });
add({ id: `txn_dev_${++n}`, source: 'stripe', kind: 'fee', status: 'succeeded', t: day(2026, 7, 1), cents: -150, fee: 0, method: 'Stripe', payer: 'Stripe', contact: null, title: 'Connections Verification' });

// Payouts: bundle Stripe payments every ~3 days
const stripeRows = rows.filter((r) => r.source === 'stripe').sort((a, b) => a.t - b.t);
let bucket = []; let pn = 0;
const flush = () => {
  if (!bucket.length) return;
  const po = `po_dev_${++pn}`; const arrival = bucket.at(-1).t + 2 * 86400;
  const net = bucket.reduce((a, r) => a + r.cents - r.fee, 0);
  out.push(`INSERT OR REPLACE INTO payouts VALUES (${q(po)},${q(LOC)},${arrival},${net},'paid',1);`);
  for (const r of bucket) r.payout = po;
  bucket = [];
};
for (const r of stripeRows) { if (bucket.length && r.t - bucket[0].t > 3 * 86400) flush(); bucket.push(r); }
// Leave the newest few unpaid, as in real life
const last = bucket.splice(-2); flush(); bucket = last;

for (const r of rows) {
  out.push(`INSERT OR REPLACE INTO payments VALUES (${q(r.id)},${q(LOC)},${q(r.source)},${q(r.kind)},${q(r.status)},${r.t},${r.cents},${r.fee},${r.cents - r.fee},${q(r.method)},${q(r.payer)},${q(r.contact)},${q(r.title)},${q(r.pi ?? null)},${q(r.origin ?? null)},${q(r.payout ?? null)});`);
}
out.push(`INSERT OR REPLACE INTO sync_state VALUES (${q(LOC)},'last_sync','${Math.floor(Date.now() / 1000) - 540}');`);
writeFileSync(new URL('./seed-dev.sql', import.meta.url), out.join('\n') + '\n');
console.log(`seed: ${rows.length} payment rows, ${pn} payouts`);
