import type { APIRoute } from 'astro';
import { getPaste } from '../../../../lib/db';
import { verifyPassword, makeUnlockCookie } from '../../../../lib/crypto';
import { json, jsonError } from '../../../../lib/http';

export const prerender = false;

const WINDOW_MS = 60_000;
const MAX_FAILURES = 5;

/**
 * Best-effort throttle. Module scope, so it is per-isolate only — a real
 * attacker can spread across isolates; this just blunts casual guessing.
 */
const failures = new Map<string, { count: number; resetAt: number }>();

function throttleKey(id: string, request: Request): string {
  return `${id}:${request.headers.get('CF-Connecting-IP') ?? 'local'}`;
}

function isThrottled(key: string, now: number): boolean {
  const entry = failures.get(key);
  if (!entry) return false;
  if (now >= entry.resetAt) {
    failures.delete(key);
    return false;
  }
  return entry.count >= MAX_FAILURES;
}

function recordFailure(key: string, now: number): void {
  const entry = failures.get(key);
  if (!entry || now >= entry.resetAt) {
    failures.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  entry.count += 1;
}

/** Keeps the isolate-local map from growing without bound. */
function prune(now: number): void {
  if (failures.size < 512) return;
  for (const [key, entry] of failures) {
    if (now >= entry.resetAt) failures.delete(key);
  }
}

export const POST: APIRoute = async ({ params, request }) => {
  const id = params.id;
  if (!id) return jsonError(404, 'not_found');

  let password: unknown;
  try {
    const body: unknown = await request.json();
    if (typeof body !== 'object' || body === null) return jsonError(400, 'bad_request');
    password = (body as Record<string, unknown>).password;
  } catch {
    return jsonError(400, 'bad_request');
  }
  if (typeof password !== 'string' || password.length === 0 || password.length > 256) {
    return jsonError(400, 'bad_request');
  }

  const now = Date.now();
  const key = throttleKey(id, request);
  prune(now);
  if (isThrottled(key, now)) return jsonError(429, 'too_many_attempts');

  const meta = await getPaste(id);
  if (!meta) return jsonError(404, 'not_found');
  if (!meta.password_hash || !meta.password_salt) return jsonError(400, 'no_password');

  const ok = await verifyPassword(password, meta.password_hash, meta.password_salt);
  if (!ok) {
    recordFailure(key, now);
    return jsonError(401, 'wrong_password');
  }

  failures.delete(key);
  return json({ ok: true }, 200, {
    'Set-Cookie': await makeUnlockCookie(id),
    'Cache-Control': 'no-store',
  });
};
