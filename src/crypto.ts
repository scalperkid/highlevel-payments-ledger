// Crypto helpers. Web Crypto only, so the same code runs in Workers and tests.

export type Md5 = (data: Uint8Array<ArrayBuffer>) => Promise<Uint8Array>;

/** Workers support MD5 in subtle.digest (non-standard); Node tests inject their own. */
export const subtleMd5: Md5 = async (data) =>
  new Uint8Array(await crypto.subtle.digest('MD5', data));

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64(bytes: Uint8Array, url = false): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const s = btoa(bin);
  return url ? s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : s;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(parts.reduce((n, p) => n + p.length, 0)));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * Decrypts a CryptoJS.AES.encrypt(text, passphrase) payload, which is what HighLevel
 * sends as the SSO user data: base64("Salted__" + salt8 + AES-256-CBC ciphertext),
 * key and IV derived with OpenSSL EVP_BytesToKey (MD5, one iteration).
 */
export async function decryptCryptoJs(payloadB64: string, passphrase: string, md5: Md5 = subtleMd5): Promise<string> {
  const raw = b64ToBytes(payloadB64);
  const header = dec.decode(raw.slice(0, 8));
  if (header !== 'Salted__') throw new Error('not a CryptoJS salted payload');
  const salt = raw.slice(8, 16);
  const ct = raw.slice(16);
  const pass = enc.encode(passphrase);
  let derived = new Uint8Array(new ArrayBuffer(0));
  let block: Uint8Array = new Uint8Array(0);
  while (derived.length < 48) {
    block = await md5(concat(block, pass, salt));
    derived = concat(derived, block);
  }
  const key = await crypto.subtle.importKey('raw', derived.slice(0, 32), { name: 'AES-CBC' }, false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: derived.slice(32, 48) }, key, ct);
  return dec.decode(pt);
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** Compact signed token: base64url(json).base64url(hmac). */
export async function signToken(data: object, secret: string): Promise<string> {
  const body = bytesToB64(enc.encode(JSON.stringify(data)), true);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body)));
  return `${body}.${bytesToB64(sig, true)}`;
}

export async function verifyToken<T>(token: string, secret: string): Promise<T | null> {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64ToBytes(sig), enc.encode(body));
  if (!ok) return null;
  try { return JSON.parse(dec.decode(b64ToBytes(body))) as T; } catch { return null; }
}

async function aesKey(keyB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', b64ToBytes(keyB64), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Encrypts a credential for storage in D1. Output: base64(iv12 + ciphertext). */
export async function seal(plain: string, keyB64: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(keyB64), enc.encode(plain)));
  return bytesToB64(concat(iv, ct));
}

export async function unseal(sealed: string, keyB64: string): Promise<string> {
  const raw = b64ToBytes(sealed);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, await aesKey(keyB64), raw.slice(12));
  return dec.decode(pt);
}

/** Constant-time string compare for shared secrets. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
