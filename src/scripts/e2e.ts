/**
 * End-to-end encryption envelope — browser side only.
 *
 * Envelope shape (CONTRACTS.md; the server treats it as opaque content):
 *   { v: 1, alg: "AES-GCM", kdf: "raw" | "PBKDF2-SHA-256",
 *     iter: 300000, salt?: b64url(16B), iv: b64url(12B), ct: b64url }
 *
 * kdf "raw"             — random 32-byte key, shared through the URL fragment #k=
 * kdf "PBKDF2-SHA-256"  — key stretched from a passphrase, 300 000 iterations
 *
 * Self-contained on purpose: nothing here may import from src/lib (server only).
 */

export const PBKDF2_ITERATIONS = 300_000;

export interface Envelope {
  v: 1;
  alg: 'AES-GCM';
  kdf: 'raw' | 'PBKDF2-SHA-256';
  iter: number;
  salt?: string;
  iv: string;
  ct: string;
}

/* ---------------------------------------------------------------- base64url */

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  // chunked: String.fromCharCode(...big) blows the call stack
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(text: string): Uint8Array<ArrayBuffer> {
  const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ------------------------------------------------------------------- crypto */

/** Allocate first, fill in place: keeps the buffer type concrete for BufferSource. */
function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(n));
  crypto.getRandomValues(bytes);
  return bytes;
}

function utf8(text: string): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(text);
  const out = new Uint8Array(new ArrayBuffer(encoded.length));
  out.set(encoded);
  return out;
}

async function importRawKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', utf8(passphrase), { name: 'PBKDF2' }, false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function seal(
  key: CryptoKey,
  plaintext: string,
): Promise<{ iv: Uint8Array<ArrayBuffer>; ct: Uint8Array<ArrayBuffer> }> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, utf8(plaintext));
  return { iv, ct: new Uint8Array(ct) };
}

/** Random 32-byte key. The key is returned separately for the #k= fragment. */
export async function encryptWithRandomKey(
  plaintext: string,
): Promise<{ envelope: Envelope; keyB64: string }> {
  const raw = randomBytes(32);
  const key = await importRawKey(raw);
  const { iv, ct } = await seal(key, plaintext);
  return {
    envelope: {
      v: 1,
      alg: 'AES-GCM',
      kdf: 'raw',
      iter: PBKDF2_ITERATIONS,
      iv: b64urlEncode(iv),
      ct: b64urlEncode(ct),
    },
    keyB64: b64urlEncode(raw),
  };
}

/** Passphrase-derived key: PBKDF2-SHA-256, 300 000 iterations, 16-byte salt. */
export async function encryptWithPassphrase(plaintext: string, passphrase: string): Promise<Envelope> {
  const salt = randomBytes(16);
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  const { iv, ct } = await seal(key, plaintext);
  return {
    v: 1,
    alg: 'AES-GCM',
    kdf: 'PBKDF2-SHA-256',
    iter: PBKDF2_ITERATIONS,
    salt: b64urlEncode(salt),
    iv: b64urlEncode(iv),
    ct: b64urlEncode(ct),
  };
}

export class DecryptError extends Error {}

export async function decryptEnvelope(
  envelope: Envelope,
  secret: { keyB64?: string; passphrase?: string },
): Promise<string> {
  if (envelope.alg !== 'AES-GCM') throw new DecryptError('Unsupported cipher.');

  let key: CryptoKey;
  if (envelope.kdf === 'raw') {
    if (!secret.keyB64) throw new DecryptError('Missing key.');
    let raw: Uint8Array<ArrayBuffer>;
    try {
      raw = b64urlDecode(secret.keyB64);
    } catch {
      throw new DecryptError('That key is not valid base64url.');
    }
    if (raw.length !== 32) throw new DecryptError('That key is the wrong length.');
    key = await importRawKey(raw);
  } else if (envelope.kdf === 'PBKDF2-SHA-256') {
    if (!secret.passphrase) throw new DecryptError('Missing passphrase.');
    if (!envelope.salt) throw new DecryptError('Envelope is missing its salt.');
    key = await deriveKey(
      secret.passphrase,
      b64urlDecode(envelope.salt),
      envelope.iter || PBKDF2_ITERATIONS,
    );
  } else {
    throw new DecryptError('Unsupported key derivation.');
  }

  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64urlDecode(envelope.iv) },
      key,
      b64urlDecode(envelope.ct),
    );
  } catch {
    throw new DecryptError(
      envelope.kdf === 'raw'
        ? 'That key does not open this paste.'
        : 'Wrong passphrase — nothing was sent anywhere, try again.',
    );
  }
  return new TextDecoder().decode(plain);
}

/** Narrow untrusted JSON into an Envelope. Returns null when it isn't one. */
export function parseEnvelope(text: string): Envelope | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const e = raw as Record<string, unknown>;
  const kdf = e['kdf'];
  const iv = e['iv'];
  const ct = e['ct'];
  const iter = e['iter'];
  const salt = e['salt'];
  if (e['alg'] !== 'AES-GCM') return null;
  if (kdf !== 'raw' && kdf !== 'PBKDF2-SHA-256') return null;
  if (typeof iv !== 'string' || typeof ct !== 'string') return null;
  return {
    v: 1,
    alg: 'AES-GCM',
    kdf,
    iter: typeof iter === 'number' ? iter : PBKDF2_ITERATIONS,
    salt: typeof salt === 'string' ? salt : undefined,
    iv,
    ct,
  };
}

/** Read `#k=<b64url>` off the current URL. */
export function keyFromHash(hash: string = location.hash): string | null {
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!h) return null;
  const params = new URLSearchParams(h);
  const k = params.get('k');
  return k && k.length > 0 ? k : null;
}
