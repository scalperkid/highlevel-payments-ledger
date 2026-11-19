/// <reference types="node" />
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptCryptoJs, seal, signToken, unseal, verifyToken, type Md5 } from '../src/crypto';

const nodeMd5: Md5 = async (d) => new Uint8Array(createHash('md5').update(d).digest());

/** Produces exactly what CryptoJS.AES.encrypt(text, passphrase).toString() produces. */
function cryptoJsEncrypt(text: string, pass: string): string {
  const salt = randomBytes(8);
  let derived = Buffer.alloc(0); let block = Buffer.alloc(0);
  while (derived.length < 48) {
    block = createHash('md5').update(Buffer.concat([block, Buffer.from(pass), salt])).digest();
    derived = Buffer.concat([derived, block]);
  }
  const c = createCipheriv('aes-256-cbc', derived.subarray(0, 32), derived.subarray(32, 48));
  return Buffer.concat([Buffer.from('Salted__'), salt, c.update(text, 'utf8'), c.final()]).toString('base64');
}

describe('HighLevel SSO payload', () => {
  it('decrypts a CryptoJS AES payload', async () => {
    const user = { userId: 'u1', email: 'owner@example.com', activeLocation: 'loc123', role: 'admin' };
    const payload = cryptoJsEncrypt(JSON.stringify(user), 'shared-secret-from-portal');
    expect(JSON.parse(await decryptCryptoJs(payload, 'shared-secret-from-portal', nodeMd5))).toEqual(user);
  });

  it('rejects a payload encrypted with a different secret', async () => {
    const payload = cryptoJsEncrypt('{"email":"x"}', 'right-secret');
    await expect(decryptCryptoJs(payload, 'wrong-secret', nodeMd5)).rejects.toThrow();
  });

  it('rejects something that is not a CryptoJS payload', async () => {
    await expect(decryptCryptoJs(Buffer.from('hello world, not salted').toString('base64'), 's', nodeMd5)).rejects.toThrow(/salted/);
  });
});

describe('sessions and sealed credentials', () => {
  it('round-trips a signed session and refuses a tampered one', async () => {
    const t = await signToken({ loc: 'a', email: 'b', exp: 1 }, 'k');
    expect(await verifyToken(t, 'k')).toEqual({ loc: 'a', email: 'b', exp: 1 });
    const [body, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ loc: 'other', email: 'b', exp: 1 })).toString('base64url');
    expect(await verifyToken(`${forged}.${sig}`, 'k')).toBeNull();
    expect(await verifyToken(`${body}.${sig}`, 'different-key')).toBeNull();
  });

  it('seals and unseals a credential', async () => {
    const key = Buffer.from(randomBytes(32)).toString('base64');
    const sealed = await seal('rk_test_not_a_real_key', key);
    expect(sealed).not.toContain('rk_test');
    expect(await unseal(sealed, key)).toBe('rk_test_not_a_real_key');
  });
});
