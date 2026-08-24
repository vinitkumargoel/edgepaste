import type { ExpirationOption, PasteMeta } from './types';

/** Seconds to live for each selectable expiration window. */
export const EXPIRATION_TTLS: Record<Exclude<ExpirationOption, 'never'>, number> = {
  '10m': 600,
  '1h': 3600,
  '1d': 86400,
  '1w': 604800,
  '1mo': 2592000,
};

const EXPIRATION_OPTIONS: readonly string[] = ['never', ...Object.keys(EXPIRATION_TTLS)];

export function isExpirationOption(v: string): v is ExpirationOption {
  return EXPIRATION_OPTIONS.includes(v);
}

/** `null` means "never expires". `now` is unix seconds. */
export function computeExpiresAt(opt: ExpirationOption, now: number): number | null {
  if (opt === 'never') return null;
  return now + EXPIRATION_TTLS[opt];
}

export function isExpired(meta: PasteMeta, now: number): boolean {
  return meta.expires_at !== null && meta.expires_at <= now;
}
