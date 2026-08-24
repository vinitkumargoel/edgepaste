-- edgepaste initial schema
CREATE TABLE pastes (
  id                TEXT PRIMARY KEY,           -- nanoid(8), unambiguous alphabet
  title             TEXT,
  language          TEXT NOT NULL DEFAULT 'plaintext',
  visibility        TEXT NOT NULL DEFAULT 'unlisted'
                    CHECK (visibility IN ('public','unlisted')),
  created_at        INTEGER NOT NULL,           -- unix seconds
  expires_at        INTEGER,                    -- NULL = never
  burn_after_read   INTEGER NOT NULL DEFAULT 0,
  is_encrypted      INTEGER NOT NULL DEFAULT 0, -- body is an E2E envelope
  password_hash     TEXT,                       -- PBKDF2-SHA-256, base64
  password_salt     TEXT,                       -- 16 random bytes, base64
  delete_token_hash TEXT NOT NULL,              -- SHA-256 hex of the one-time token
  r2_key            TEXT NOT NULL,              -- pastes/{id}.txt
  size_bytes        INTEGER NOT NULL,
  line_count        INTEGER NOT NULL,
  view_count        INTEGER NOT NULL DEFAULT 0
);

-- public feed: newest public pastes, keyset-paginated
CREATE INDEX idx_pastes_public_recent
  ON pastes (visibility, created_at DESC);

-- cron sweep: only rows that can expire
CREATE INDEX idx_pastes_expires
  ON pastes (expires_at) WHERE expires_at IS NOT NULL;
