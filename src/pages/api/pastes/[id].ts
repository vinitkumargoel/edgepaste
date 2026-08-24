import type { APIRoute } from 'astro';
import { resolvePaste } from '../../../lib/gauntlet';
import { getPaste, deletePaste, incrementViews } from '../../../lib/db';
import { deleteBody } from '../../../lib/storage';
import { sha256Hex } from '../../../lib/crypto';
import { json, jsonError, pasteUrl, rawUrl, isoOrNull } from '../../../lib/http';

export const prerender = false;

/** Defensive `waitUntil`: the adapter may not expose an ExecutionContext in dev. */
function makeWaitUntil(locals: unknown): (p: Promise<unknown>) => void {
  return (p: Promise<unknown>) => {
    const settled = p.catch(() => {});
    try {
      const l = locals as {
        runtime?: { ctx?: { waitUntil?: (p: Promise<unknown>) => void } };
        cfContext?: { waitUntil?: (p: Promise<unknown>) => void };
      } | null;
      // cfContext first: adapter v14's deprecated `runtime.ctx` getter throws.
      const ctx = l?.cfContext ?? l?.runtime?.ctx;
      if (ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(settled);
        return;
      }
    } catch {
      /* dev / adapter without a request context */
    }
    void settled;
  };
}

/** Constant-time comparison of two hex digests. */
function digestsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const GET: APIRoute = async ({ params, request, locals }) => {
  const id = params.id;
  if (!id) return jsonError(404, 'not_found');

  const waitUntil = makeWaitUntil(locals);
  // Built as a variable so the extra `request` (used for the unlock cookie) is
  // structurally compatible with the pinned opts type.
  const opts = { claimBurn: false, waitUntil, request };
  const res = await resolvePaste(id, opts);

  if (res.status === 'not_found') return jsonError(404, 'not_found');
  if (res.status === 'gone') return jsonError(410, 'expired');
  if (res.status === 'locked') return jsonError(403, 'password_required');
  if (res.status === 'burn_pending') return jsonError(409, 'burn_after_read');

  const meta = res.meta;
  waitUntil(incrementViews(id));

  return json(
    {
      id: meta.id,
      title: meta.title,
      language: meta.language,
      visibility: meta.visibility,
      created_at: isoOrNull(meta.created_at),
      expires_at: isoOrNull(meta.expires_at),
      burn_after_read: meta.burn_after_read === 1,
      is_encrypted: meta.is_encrypted === 1,
      size_bytes: meta.size_bytes,
      line_count: meta.line_count,
      view_count: meta.view_count,
      content: res.content,
      url: pasteUrl(meta.id),
      raw_url: rawUrl(meta.id),
    },
    200,
    { 'Cache-Control': 'no-store' },
  );
};

export const DELETE: APIRoute = async ({ params, request, url }) => {
  const id = params.id;
  if (!id) return jsonError(404, 'not_found');

  const auth = request.headers.get('Authorization') ?? '';
  const bearer = /^Bearer\s+(.+)$/i.exec(auth.trim());
  const token = (bearer ? bearer[1] : url.searchParams.get('token'))?.trim() ?? '';
  if (!token) return jsonError(401, 'unauthorized');

  // Owner override: bypasses the gauntlet so locked, burn-pending and
  // expired-but-not-yet-swept pastes can still be deleted with the token.
  const meta = await getPaste(id);
  if (!meta) return jsonError(404, 'not_found');

  const provided = await sha256Hex(token);
  if (!digestsEqual(provided, meta.delete_token_hash)) return jsonError(401, 'unauthorized');

  await deletePaste(id);
  try {
    await deleteBody(meta.r2_key);
  } catch {
    /* row is gone; the cron orphan sweep collects the object */
  }

  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
};
