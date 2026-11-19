import { describe, expect, it } from 'vitest';
import { locationsFor, looksLikeEmail, normaliseEmail, randomToken, sha256Hex, signInEmail } from '../src/signin';
import type { LocationConfig } from '../src/types';

const cfg = (viewers: string[]) => ({ viewers } as unknown as LocationConfig);

describe('email sign-in', () => {
  it('finds the report an address may open, ignoring case', () => {
    const configs = [{ location_id: 'a', config: cfg(['owner@example.com']) }, { location_id: 'b', config: cfg(['Accountant@Example.com']) }];
    expect(locationsFor(normaliseEmail(' accountant@example.com '), configs)).toEqual(['b']);
    expect(locationsFor('stranger@example.com', configs)).toEqual([]);
  });
  it('rejects things that are not email addresses', () => {
    expect(looksLikeEmail('name@company.com')).toBe(true);
    expect(looksLikeEmail('name@company')).toBe(false);
    expect(looksLikeEmail('not an email')).toBe(false);
  });
  it('makes long unguessable links and stores only a hash', async () => {
    const t = randomToken();
    expect(t.length).toBeGreaterThanOrEqual(40);
    expect(t).not.toEqual(randomToken());
    expect(await sha256Hex(t)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('puts the link in the email and escapes the business name', () => {
    const m = signInEmail('Main <Street>', 'https://example.workers.dev/?signin=abc');
    expect(m.html).toContain('https://example.workers.dev/?signin=abc');
    expect(m.html).toContain('Main &lt;Street&gt;');
    expect(m.text).toContain('expires in 30 minutes');
    expect(m.html + m.text).not.toMatch(/\u2014/);
  });
});
