import { env } from 'cloudflare:workers';

/**
 * All hashing/signing runs on WebCrypto — the Workers runtime has no Node
 * `crypto` module available to us here, and `crypto.subtle` is the only
 * primitive that is constant-time by construction.
 */

const encoder = new TextEncoder();

/**
 * Workers caps PBKDF2 at 100_000 iterations; asking for more throws
 * `NotSupportedError` at derive time. Do not raise this number.
 */
const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const DERIVED_KEY_BITS = 256;

const UNLOCK_TTL_SECONDS = 3600;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

async function sha256Bytes(input: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(input)));
}

/**
 * Compares the SHA-256 digests of both inputs rather than the strings
 * themselves: digests are fixed length and the loop never exits early, so
 * neither the length nor the position of the first difference leaks.
 */
async function constantTimeEquals(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([sha256Bytes(a), sha256Bytes(b)]);
  let diff = da.length ^ db.length;
  for (let i = 0; i < da.length; i++) diff |= (da[i] ?? 0) ^ (db[i] ?? 0);
  return diff === 0;
}

export async function sha256Hex(input: string): Promise<string> {
  return toHex(await sha256Bytes(input));
}

async function deriveKeyBase64(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    keyMaterial,
    DERIVED_KEY_BITS,
  );
  return toBase64(new Uint8Array(bits));
}

export async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  return { hash: await deriveKeyBase64(password, salt), salt: toBase64(salt) };
}

export async function verifyPassword(
  password: string,
  hash: string,
  salt: string,
): Promise<boolean> {
  let saltBytes: Uint8Array<ArrayBuffer>;
  try {
    saltBytes = fromBase64(salt);
  } catch {
    return false;
  }
  const candidate = await deriveKeyBase64(password, saltBytes);
  return constantTimeEquals(candidate, hash);
}

let hmacKey: Promise<CryptoKey> | null = null;

function unlockSigningKey(): Promise<CryptoKey> {
  if (!hmacKey) {
    hmacKey = crypto.subtle
      .importKey(
        'raw',
        encoder.encode(env.SESSION_SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      )
      .catch((err: unknown) => {
        hmacKey = null;
        throw err;
      });
  }
  return hmacKey;
}

async function signUnlock(id: string, exp: number): Promise<string> {
  const key = await unlockSigningKey();
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${id}.${exp}`));
  return toHex(new Uint8Array(sig));
}

function cookieName(id: string): string {
  return `ep_unlock_${id}`;
}

export async function makeUnlockCookie(id: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + UNLOCK_TTL_SECONDS;
  const sig = await signUnlock(id, exp);
  return `${cookieName(id)}=${exp}.${sig}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${UNLOCK_TTL_SECONDS}; Secure`;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return null;
}

export async function checkUnlockCookie(request: Request, id: string): Promise<boolean> {
  const value = readCookie(request, cookieName(id));
  if (!value) return false;

  const dot = value.indexOf('.');
  if (dot === -1) return false;

  const expRaw = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!/^\d+$/.test(expRaw) || sig.length === 0) return false;

  const exp = Number.parseInt(expRaw, 10);
  if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) return false;

  return constantTimeEquals(sig, await signUnlock(id, exp));
}
