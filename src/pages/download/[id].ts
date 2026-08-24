import type { APIRoute } from 'astro';
import { resolvePaste } from '../../lib/gauntlet';
import { incrementViews } from '../../lib/db';
import { extFor } from '../../lib/validate';

export const prerender = false;

const TEXT_HEADERS: Record<string, string> = {
  'Content-Type': 'text/plain; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
};

function text(body: string, status: number, extra?: Record<string, string>): Response {
  return new Response(body, { status, headers: { ...TEXT_HEADERS, ...extra } });
}

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

/** Filename stem restricted to [A-Za-z0-9._-]; falls back to the paste id. */
function filenameStem(title: string | null, id: string): string {
  const stem = (title ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 100);
  return stem.length > 0 ? stem : id;
}

export const GET: APIRoute = async ({ params, request, locals }) => {
  const id = params.id;
  if (!id) return text('Not found.\n', 404);

  const waitUntil = makeWaitUntil(locals);
  // Built as a variable so the extra `request` (used for the unlock cookie) is
  // structurally compatible with the pinned opts type.
  const opts = { claimBurn: false, waitUntil, request };
  const res = await resolvePaste(id, opts);

  if (res.status === 'not_found') return text('Not found.\n', 404);
  if (res.status === 'gone') return text('This paste is gone: it expired or was destroyed.\n', 410);
  if (res.status === 'locked') {
    return text(`This paste is password protected. Open /p/${id} to unlock it.\n`, 403);
  }
  if (res.status === 'burn_pending') {
    return text(`This paste burns after reading. Open /p/${id} to view it once.\n`, 409);
  }

  const meta = res.meta;
  // E2E envelopes download as plain .txt — the extension describes the file on
  // disk, and the ciphertext is not the source language.
  const ext = meta.is_encrypted === 1 ? 'txt' : extFor(meta.language);
  const filename = `${filenameStem(meta.title, meta.id)}.${ext}`;

  waitUntil(incrementViews(id));
  return text(res.content, 200, {
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
};
