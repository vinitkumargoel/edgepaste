/**
 * Shared domain types for edgepaste.
 *
 * `PasteMeta` mirrors the `pastes` table in migrations/0001_init.sql one-to-one:
 * SQLite has no boolean, so flag columns are the integers 0 | 1, and every
 * timestamp is unix **seconds**.
 */

export type Visibility = 'public' | 'unlisted';

export type ExpirationOption = 'never' | '10m' | '1h' | '1d' | '1w' | '1mo';

export interface PasteMeta {
  id: string;
  title: string | null;
  language: string;
  visibility: Visibility;
  created_at: number;
  expires_at: number | null;
  burn_after_read: 0 | 1;
  is_encrypted: 0 | 1;
  password_hash: string | null;
  password_salt: string | null;
  delete_token_hash: string;
  r2_key: string;
  size_bytes: number;
  line_count: number;
  view_count: number;
}

export interface CreateInput {
  content: string;
  language: string;
  title: string | null;
  expiration: ExpirationOption;
  visibility: Visibility;
  burn_after_read: boolean;
  password: string | null;
  encrypted: boolean;
}
