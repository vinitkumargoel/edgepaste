import { env } from 'cloudflare:workers';
import type { PasteMeta, Visibility } from './types';

/**
 * Every SQL statement in the app lives here. All queries are prepared and
 * bound — no interpolation of user input into SQL text.
 */

const COLUMNS =
  'id, title, language, visibility, created_at, expires_at, burn_after_read, ' +
  'is_encrypted, password_hash, password_salt, delete_token_hash, r2_key, ' +
  'size_bytes, line_count, view_count';

interface PasteRow {
  id: string;
  title: string | null;
  language: string;
  visibility: string;
  created_at: number;
  expires_at: number | null;
  burn_after_read: number;
  is_encrypted: number;
  password_hash: string | null;
  password_salt: string | null;
  delete_token_hash: string;
  r2_key: string;
  size_bytes: number;
  line_count: number;
  view_count: number;
}

function rowToMeta(row: PasteRow): PasteMeta {
  const visibility: Visibility = row.visibility === 'public' ? 'public' : 'unlisted';
  return {
    id: row.id,
    title: row.title,
    language: row.language,
    visibility,
    created_at: row.created_at,
    expires_at: row.expires_at,
    burn_after_read: row.burn_after_read ? 1 : 0,
    is_encrypted: row.is_encrypted ? 1 : 0,
    password_hash: row.password_hash,
    password_salt: row.password_salt,
    delete_token_hash: row.delete_token_hash,
    r2_key: row.r2_key,
    size_bytes: row.size_bytes,
    line_count: row.line_count,
    view_count: row.view_count,
  };
}

/** Throws on primary-key conflict — the create flow retries with a fresh id. */
export async function insertPaste(meta: PasteMeta): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO pastes (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      meta.id,
      meta.title,
      meta.language,
      meta.visibility,
      meta.created_at,
      meta.expires_at,
      meta.burn_after_read,
      meta.is_encrypted,
      meta.password_hash,
      meta.password_salt,
      meta.delete_token_hash,
      meta.r2_key,
      meta.size_bytes,
      meta.line_count,
      meta.view_count,
    )
    .run();
}

export async function getPaste(id: string): Promise<PasteMeta | null> {
  const row = await env.DB.prepare(`SELECT ${COLUMNS} FROM pastes WHERE id = ?`)
    .bind(id)
    .first<PasteRow>();
  return row ? rowToMeta(row) : null;
}

export async function deletePaste(id: string): Promise<void> {
  await env.DB.prepare('DELETE FROM pastes WHERE id = ?').bind(id).run();
}

/**
 * Atomic burn claim: the DELETE is the claim, and `RETURNING *` hands the row
 * to whichever request won. A second concurrent reader deletes zero rows and
 * gets `null`, so exactly one caller can ever read a burn paste's body.
 */
export async function claimBurn(id: string): Promise<PasteMeta | null> {
  const row = await env.DB.prepare(
    'DELETE FROM pastes WHERE id = ? AND burn_after_read = 1 RETURNING *',
  )
    .bind(id)
    .first<PasteRow>();
  return row ? rowToMeta(row) : null;
}

export async function incrementViews(id: string): Promise<void> {
  await env.DB.prepare('UPDATE pastes SET view_count = view_count + 1 WHERE id = ?')
    .bind(id)
    .run();
}

/**
 * Newest-first public feed, keyset-paginated on (created_at, id) so pages stay
 * stable while new pastes arrive. Expired and burn pastes never appear.
 */
export async function listPublic(
  limit: number,
  before?: { created_at: number; id: string },
): Promise<PasteMeta[]> {
  const now = Math.floor(Date.now() / 1000);
  const base =
    `SELECT ${COLUMNS} FROM pastes ` +
    "WHERE visibility = 'public' AND burn_after_read = 0 " +
    'AND (expires_at IS NULL OR expires_at > ?)';
  const order = ' ORDER BY created_at DESC, id DESC LIMIT ?';

  const statement = before
    ? env.DB.prepare(`${base} AND (created_at < ? OR (created_at = ? AND id < ?))${order}`).bind(
        now,
        before.created_at,
        before.created_at,
        before.id,
        limit,
      )
    : env.DB.prepare(`${base}${order}`).bind(now, limit);

  const { results } = await statement.all<PasteRow>();
  return results.map(rowToMeta);
}

export async function listExpiredBatch(
  now: number,
  limit: number,
): Promise<Array<{ id: string; r2_key: string }>> {
  const { results } = await env.DB.prepare(
    'SELECT id, r2_key FROM pastes WHERE expires_at IS NOT NULL AND expires_at <= ? LIMIT ?',
  )
    .bind(now, limit)
    .all<{ id: string; r2_key: string }>();
  return results;
}

/** D1 caps bound parameters per query, so `IN (...)` lists are chunked. */
const MAX_BOUND_PARAMS = 90;

function chunk(ids: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += MAX_BOUND_PARAMS) {
    chunks.push(ids.slice(i, i + MAX_BOUND_PARAMS));
  }
  return chunks;
}

/**
 * Batched row delete for the cron sweep (see src/worker.ts). Kept here so this
 * module stays the only place that writes SQL.
 */
export async function deletePastesByIds(ids: readonly string[]): Promise<void> {
  for (const group of chunk(ids)) {
    const placeholders = group.map(() => '?').join(', ');
    await env.DB.prepare(`DELETE FROM pastes WHERE id IN (${placeholders})`)
      .bind(...group)
      .run();
  }
}

/**
 * Which of the given ids still have a row — the orphan sweep in src/worker.ts
 * deletes R2 objects whose id is absent from this set.
 */
export async function existingPasteIds(ids: readonly string[]): Promise<Set<string>> {
  const alive = new Set<string>();
  for (const group of chunk(ids)) {
    const placeholders = group.map(() => '?').join(', ');
    const { results } = await env.DB.prepare(
      `SELECT id FROM pastes WHERE id IN (${placeholders})`,
    )
      .bind(...group)
      .all<{ id: string }>();
    for (const row of results) alive.add(row.id);
  }
  return alive;
}
