import type { APIRoute } from 'astro';
import type { PasteMeta } from '../../../lib/types';
import { parseCreateRequest } from '../../../lib/validate';
import { newPasteId, newDeleteToken } from '../../../lib/ids';
import { hashPassword, sha256Hex } from '../../../lib/crypto';
import { computeExpiresAt } from '../../../lib/expiry';
import { insertPaste } from '../../../lib/db';
import { bodyKey, putBody, deleteBody } from '../../../lib/storage';
import { json, jsonError, pasteUrl, rawUrl, isoOrNull } from '../../../lib/http';

export const prerender = false;

/** How many (id, putBody, insertPaste) attempts before giving up on a PK collision. */
const MAX_INSERT_ATTEMPTS = 3;

export const POST: APIRoute = async ({ request }) => {
  const parsed = await parseCreateRequest(request);
  if (!parsed.ok) return jsonError(parsed.status, parsed.error);

  const { input, sizeBytes, lineCount } = parsed;
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = computeExpiresAt(input.expiration, now);

  let passwordHash: string | null = null;
  let passwordSalt: string | null = null;
  if (input.password) {
    const derived = await hashPassword(input.password);
    passwordHash = derived.hash;
    passwordSalt = derived.salt;
  }

  // Shown to the creator exactly once; only its SHA-256 is persisted.
  const deleteToken = newDeleteToken();
  const deleteTokenHash = await sha256Hex(deleteToken);

  let created: PasteMeta | null = null;

  for (let attempt = 0; attempt < MAX_INSERT_ATTEMPTS; attempt++) {
    const id = newPasteId();
    const key = bodyKey(id);

    // Body first: a row is never allowed to point at a missing object.
    try {
      await putBody(key, input.content);
    } catch {
      return jsonError(500, 'storage_failed');
    }

    const meta: PasteMeta = {
      id,
      title: input.title,
      language: input.language,
      visibility: input.visibility,
      created_at: now,
      expires_at: expiresAt,
      burn_after_read: input.burn_after_read ? 1 : 0,
      is_encrypted: input.encrypted ? 1 : 0,
      password_hash: passwordHash,
      password_salt: passwordSalt,
      delete_token_hash: deleteTokenHash,
      r2_key: key,
      size_bytes: sizeBytes,
      line_count: lineCount,
      view_count: 0,
    };

    try {
      await insertPaste(meta);
      created = meta;
      break;
    } catch {
      // PK collision (or a failed insert): abandon this object and retry with a fresh id.
      try {
        await deleteBody(key);
      } catch {
        /* best effort — the cron orphan sweep will collect it */
      }
    }
  }

  if (!created) return jsonError(500, 'create_failed');

  return json(
    {
      id: created.id,
      url: pasteUrl(created.id),
      raw_url: rawUrl(created.id),
      delete_token: deleteToken,
      expires_at: isoOrNull(created.expires_at),
    },
    201,
    { 'Cache-Control': 'no-store' },
  );
};
