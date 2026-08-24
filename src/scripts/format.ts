/**
 * Presentation helpers. Pure, dependency-free and side-effect-free, so the
 * same module is safe in .astro frontmatter (server) and in browser bundles.
 * All timestamps are unix SECONDS, per CONTRACTS.md.
 */

const KB = 1024;
const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

function trim1(n: number): string {
  const s = n.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/** 286 B · 1.8 KB · 24.3 KB · 2.1 MB */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < KB) return `${Math.round(bytes)} B`;
  if (bytes < MB) return `${trim1(bytes / KB)} KB`;
  if (bytes < GB) return `${trim1(bytes / MB)} MB`;
  return `${trim1(bytes / GB)} GB`;
}

/** 1,024 -> "1,024" (thousands separators for the stats strip) */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** "just now" · "4 min ago" · "1 h ago" · "yesterday" · "3 days ago" · "2 mo ago" */
export function humanAge(createdAt: number, now = Math.floor(Date.now() / 1000)): string {
  const d = Math.max(0, now - createdAt);
  if (d < 60) return 'just now';
  if (d < 3600) {
    const m = Math.floor(d / 60);
    return `${m} min ago`;
  }
  if (d < 86400) {
    const h = Math.floor(d / 3600);
    return `${h} h ago`;
  }
  if (d < 172800) return 'yesterday';
  if (d < 2592000) {
    const days = Math.floor(d / 86400);
    return `${days} days ago`;
  }
  if (d < 31536000) {
    const mo = Math.floor(d / 2592000);
    return mo === 1 ? '1 mo ago' : `${mo} mo ago`;
  }
  const y = Math.floor(d / 31536000);
  return y === 1 ? '1 yr ago' : `${y} yr ago`;
}

/** "never expires" · "expires in 22h" · "expires in 9m" */
export function expiresIn(expiresAt: number | null, now = Math.floor(Date.now() / 1000)): string {
  if (expiresAt === null) return 'never expires';
  const d = expiresAt - now;
  if (d <= 0) return 'expired';
  if (d < 60) return 'expires in <1m';
  if (d < 3600) return `expires in ${Math.floor(d / 60)}m`;
  if (d < 86400) return `expires in ${Math.floor(d / 3600)}h`;
  return `expires in ${Math.floor(d / 86400)}d`;
}

/** UTF-8 byte length of a string, without allocating in the common ASCII case. */
export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Line count the same way the server counts it: newlines + 1, empty string = 0. */
export function countLines(s: string): number {
  if (s.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}
