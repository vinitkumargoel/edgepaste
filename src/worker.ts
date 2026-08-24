import { handle } from '@astrojs/cloudflare/handler';
import { deletePastesByIds, existingPasteIds, listExpiredBatch } from './lib/db';
import { deleteBody } from './lib/storage';

/**
 * Custom Worker entry (wrangler.toml `main`). Astro handles every request via
 * `handle()`; this file exists to add the cron `scheduled` handler on top.
 */

const EXPIRED_BATCH_SIZE = 500;
/** Bounds a single cron run so a pathological backlog can't spin forever. */
const MAX_EXPIRED_ROUNDS = 100;

const ORPHAN_PREFIX = 'pastes/';
const ORPHAN_SUFFIX = '.txt';
const ORPHAN_LIST_LIMIT = 1000;
/**
 * Bodies are written to R2 before the row is inserted, so a just-created paste
 * legitimately has an object with no row for a moment. Only objects older than
 * a day are considered orphans.
 */
const ORPHAN_MIN_AGE_SECONDS = 86_400;

/** Deletes expired rows and their bodies in batches until none are left. */
async function sweepExpired(now: number): Promise<number> {
  let removed = 0;
  for (let round = 0; round < MAX_EXPIRED_ROUNDS; round++) {
    const batch = await listExpiredBatch(now, EXPIRED_BATCH_SIZE);
    if (batch.length === 0) break;

    await deleteBody(batch.map((row) => row.r2_key));
    await deletePastesByIds(batch.map((row) => row.id));
    removed += batch.length;

    if (batch.length < EXPIRED_BATCH_SIZE) break;
  }
  return removed;
}

function idFromKey(key: string): string | null {
  if (!key.startsWith(ORPHAN_PREFIX) || !key.endsWith(ORPHAN_SUFFIX)) return null;
  const id = key.slice(ORPHAN_PREFIX.length, key.length - ORPHAN_SUFFIX.length);
  return id.length > 0 ? id : null;
}

/** Deletes bodies left behind by a create that died between putBody and insert. */
async function sweepOrphans(env: Env, now: number): Promise<number> {
  const listed = await env.BUCKET.list({ prefix: ORPHAN_PREFIX, limit: ORPHAN_LIST_LIMIT });
  const cutoffMs = (now - ORPHAN_MIN_AGE_SECONDS) * 1000;

  const candidates: Array<{ key: string; id: string }> = [];
  for (const object of listed.objects) {
    if (object.uploaded.getTime() >= cutoffMs) continue;
    const id = idFromKey(object.key);
    // Keys we don't recognise aren't ours to delete.
    if (id !== null) candidates.push({ key: object.key, id });
  }
  if (candidates.length === 0) return 0;

  const alive = await existingPasteIds(candidates.map((c) => c.id));
  const orphans = candidates.filter((c) => !alive.has(c.id)).map((c) => c.key);
  if (orphans.length === 0) return 0;

  await deleteBody(orphans);
  return orphans.length;
}

async function sweep(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const expired = await sweepExpired(now);
  const orphans = await sweepOrphans(env, now);
  console.log(`edgepaste sweep: ${expired} expired pastes, ${orphans} orphaned objects`);
}

export default {
  async fetch(request, env, ctx) {
    return handle(request, env, ctx);
  },

  async scheduled(_controller, env, ctx) {
    const running = sweep(env);
    ctx.waitUntil(running);
    await running;
  },
} satisfies ExportedHandler<Env>;
