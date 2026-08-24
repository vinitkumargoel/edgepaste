import { env } from 'cloudflare:workers';

/** R2 layout: every body lives at `pastes/{id}.txt`, encrypted ones included. */
export function bodyKey(id: string): string {
  return `pastes/${id}.txt`;
}

export async function putBody(key: string, content: string): Promise<void> {
  await env.BUCKET.put(key, content, {
    httpMetadata: { contentType: 'text/plain; charset=utf-8' },
  });
}

export async function getBody(key: string): Promise<string | null> {
  const object = await env.BUCKET.get(key);
  return object ? await object.text() : null;
}

export async function deleteBody(key: string | string[]): Promise<void> {
  if (Array.isArray(key) && key.length === 0) return;
  await env.BUCKET.delete(key);
}
