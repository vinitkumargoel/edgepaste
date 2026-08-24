import { env } from 'cloudflare:workers';

export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  const merged = new Headers(headers);
  if (!merged.has('Content-Type')) {
    merged.set('Content-Type', 'application/json; charset=utf-8');
  }
  return new Response(JSON.stringify(data), { status, headers: merged });
}

export function jsonError(status: number, error: string): Response {
  return json({ error }, status);
}

function origin(): string {
  return env.PUBLIC_ORIGIN.replace(/\/+$/, '');
}

export function pasteUrl(id: string): string {
  return `${origin()}/p/${id}`;
}

export function rawUrl(id: string): string {
  return `${origin()}/raw/${id}`;
}

/** Unix seconds -> `2026-08-25T13:00:00Z` (no milliseconds). */
export function isoOrNull(unixSeconds: number | null): string | null {
  if (unixSeconds === null) return null;
  return new Date(unixSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
