import { checkUnlockCookie } from './crypto';
import { claimBurn, deletePaste, getPaste } from './db';
import { isExpired } from './expiry';
import { deleteBody, getBody } from './storage';
import type { PasteMeta } from './types';

/**
 * The single shared read path. Pages and endpoints both go through
 * `resolvePaste` so expiry, password gating and burn semantics can never drift
 * between them.
 */
export type Resolution =
  | { status: 'not_found' }
  | { status: 'gone' }
  | { status: 'locked'; meta: PasteMeta }
  | { status: 'burn_pending'; meta: PasteMeta }
  | { status: 'ok'; meta: PasteMeta; content: string };

export interface ResolveOptions {
  /** Only `POST /p/:id` with `action=burn` may claim; every other read peeks. */
  claimBurn?: boolean;
  waitUntil?: (p: Promise<unknown>) => void;
  /** Needed to read the unlock cookie; without it a locked paste stays locked. */
  request?: Request;
  /** Escape hatch for callers that already verified the password this request. */
  unlocked?: boolean;
}

/** Background cleanup must never fail the request it rode in on. */
function schedule(work: Promise<unknown>, waitUntil?: (p: Promise<unknown>) => void): void {
  const settled = work.catch(() => undefined);
  if (waitUntil) {
    try {
      waitUntil(settled);
      return;
    } catch {
      // `waitUntil` is unavailable outside a request context (e.g. astro dev):
      // fall through to fire-and-forget.
    }
  }
  void settled;
}

async function purge(id: string, key: string): Promise<void> {
  await Promise.all([deletePaste(id), deleteBody(key)]);
}

export async function resolvePaste(
  id: string,
  opts: ResolveOptions,
): Promise<Resolution> {
  const meta = await getPaste(id);
  if (!meta) return { status: 'not_found' };

  const now = Math.floor(Date.now() / 1000);
  if (isExpired(meta, now)) {
    schedule(purge(meta.id, meta.r2_key), opts.waitUntil);
    return { status: 'gone' };
  }

  if (meta.password_hash !== null) {
    const unlocked =
      opts.unlocked === true ||
      (opts.request !== undefined && (await checkUnlockCookie(opts.request, id)));
    if (!unlocked) return { status: 'locked', meta };
  }

  if (meta.burn_after_read === 1) {
    if (!opts.claimBurn) return { status: 'burn_pending', meta };

    // The DELETE ... RETURNING is the claim: at most one caller gets the row.
    const claimed = await claimBurn(id);
    if (!claimed) return { status: 'gone' };

    // Read the body BEFORE scheduling its deletion — once the row is gone the
    // object is unreachable, so losing it here would lose the paste entirely.
    let content: string | null = null;
    try {
      content = await getBody(claimed.r2_key);
    } catch {
      content = null;
    }
    schedule(deleteBody(claimed.r2_key), opts.waitUntil);

    if (content === null) return { status: 'gone' };
    return { status: 'ok', meta: claimed, content };
  }

  const content = await getBody(meta.r2_key);
  if (content === null) {
    schedule(purge(meta.id, meta.r2_key), opts.waitUntil);
    return { status: 'gone' };
  }

  return { status: 'ok', meta, content };
}
