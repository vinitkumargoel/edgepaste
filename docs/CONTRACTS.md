# edgepaste — shared contracts (binding for all implementation agents)

Product: **edgepaste** — a pastebin on Cloudflare Workers. Astro 7 SSR (`output: 'server'`,
`@astrojs/cloudflare` v14), metadata in D1 (binding `DB`), bodies in R2 (binding `BUCKET`).
Deployed at `https://edgepaste.vinitk.dev`. Brand wordmark: **edgepaste** (the design mock
says "edgebin.dev" — replace with "edgepaste" everywhere; everything else in the mock is
the approved visual spec).

Every agent MUST follow this document exactly. Where it pins a signature, implement that
signature. Do not rename, do not "improve" the shapes. Do not run `npm install` or builds —
write code only. You MAY read `node_modules/` to verify real import paths and API signatures
(especially `shiki`, `@astrojs/cloudflare`, `astro`, `nanoid`, `uqr`).

## Runtime access pattern

- Bindings/vars/secrets: `import { env } from 'cloudflare:workers'` — works at module scope
  in this adapter version (proven pattern from a sibling project on this machine). Types come
  from the generated `worker-configuration.d.ts` (already generated at repo root; read it for
  the exact `Env` shape). Env has: `DB: D1Database`, `BUCKET: R2Bucket`,
  `MAX_PASTE_BYTES: string`, `PUBLIC_ORIGIN: string`, `SESSION_SECRET: string`.
- `waitUntil`: in pages/endpoints use, defensively:
  `const wu = (p: Promise<unknown>) => { try { locals.runtime.ctx.waitUntil(p) } catch { /* dev */ } }`
  If `locals.runtime` is unavailable in this adapter version, fall back to fire-and-forget
  with `.catch(() => {})`.
- All timestamps: unix **seconds** (`Math.floor(Date.now() / 1000)`).

## File ownership (do not touch files outside your area)

- **AGENT CORE**: `src/lib/*.ts`, `src/worker.ts`
- **AGENT API**: `src/pages/api/**/*.ts`, `src/pages/raw/[id].ts`, `src/pages/download/[id].ts`
- **AGENT UI**: `src/layouts/*.astro`, `src/components/*.astro`, `src/styles/global.css`,
  `src/pages/index.astro`, `src/pages/p/[id].astro`, `src/pages/recent.astro`,
  `src/pages/404.astro`, `src/scripts/*.ts` (client-side)

## src/lib — exact module surface (AGENT CORE implements; others import)

### `src/lib/types.ts`
```ts
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
  content: string;            // plaintext, or the E2E envelope JSON string
  language: string;           // must be a key of LANGUAGES
  title: string | null;       // trimmed, max 200 chars
  expiration: ExpirationOption;
  visibility: Visibility;
  burn_after_read: boolean;
  password: string | null;    // plain password to hash, or null
  encrypted: boolean;         // content is an E2E envelope
}
```

### `src/lib/validate.ts`
```ts
export interface LanguageDef { id: string; label: string; ext: string; shiki: string | null }
export const LANGUAGES: readonly LanguageDef[]; // see registry below
export function isLanguage(id: string): boolean;
export function extFor(language: string): string; // 'txt' fallback
export function maxPasteBytes(): number;          // parseInt(env.MAX_PASTE_BYTES), fallback 10485760
// Parses BOTH application/json and multipart/form-data (fields mirror CreateInput;
// multipart also accepts a `file` part whose text becomes content when `content` absent;
// booleans arrive as 'true'/'1'/'on'). Enforces: content non-empty, size cap (byte length
// of content), whitelists, title cap. Burn forces visibility 'unlisted'.
// Encrypted forces language to stay but content is the envelope. password max 256 chars.
export function parseCreateRequest(request: Request): Promise<
  { ok: true; input: CreateInput; sizeBytes: number; lineCount: number } |
  { ok: false; status: number; error: string }>;
```

Language registry (id / label / ext / shiki grammar): plaintext/Plain text/txt/null,
javascript/JavaScript/js, typescript/TypeScript/ts, jsx/JSX/jsx, tsx/TSX/tsx,
python/Python/py, go/Go/go, rust/Rust/rs, json/JSON/json, yaml/YAML/yml, toml/TOML/toml,
markdown/Markdown/md, html/HTML/html, css/CSS/css, sql/SQL/sql, bash/Bash/sh.
(shiki id equals the language id for all non-null entries.)

### `src/lib/ids.ts`
```ts
export function newPasteId(): string;      // nanoid customAlphabet, 8 chars, alphabet
                                           // '23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ'
export function newDeleteToken(): string;  // 32 random bytes -> 64 lowercase hex chars
```

### `src/lib/crypto.ts` (WebCrypto only — no Node crypto imports)
```ts
export function sha256Hex(input: string): Promise<string>;
export function hashPassword(password: string): Promise<{ hash: string; salt: string }>; // PBKDF2-SHA-256, 100_000 iter (Workers cap), 16-byte salt, 32-byte derived key, base64
export function verifyPassword(password: string, hash: string, salt: string): Promise<boolean>; // constant-time compare
// Unlock cookie: name `ep_unlock_${id}`, value `${exp}.${sigHex}` where exp = unix seconds
// (now + 3600) and sigHex = hex(HMAC-SHA-256(SESSION_SECRET, `${id}.${exp}`)).
export function makeUnlockCookie(id: string): Promise<string>;  // full Set-Cookie value: `ep_unlock_${id}=${exp}.${sig}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600; Secure`
export function checkUnlockCookie(request: Request, id: string): Promise<boolean>;
```

### `src/lib/expiry.ts`
```ts
export const EXPIRATION_TTLS: Record<Exclude<ExpirationOption, 'never'>, number>; // 600, 3600, 86400, 604800, 2592000
export function isExpirationOption(v: string): v is ExpirationOption;
export function computeExpiresAt(opt: ExpirationOption, now: number): number | null;
export function isExpired(meta: PasteMeta, now: number): boolean;
```

### `src/lib/db.ts` (typed D1; the only SQL in the app)
```ts
export function insertPaste(meta: PasteMeta): Promise<void>;              // throws on PK conflict
export function getPaste(id: string): Promise<PasteMeta | null>;
export function deletePaste(id: string): Promise<void>;
export function claimBurn(id: string): Promise<PasteMeta | null>;         // DELETE ... RETURNING *; null = already claimed/missing
export function incrementViews(id: string): Promise<void>;
export function listPublic(limit: number, before?: { created_at: number; id: string }): Promise<PasteMeta[]>; // excludes expired (expires_at <= now) and burn pastes
export function listExpiredBatch(now: number, limit: number): Promise<Array<{ id: string; r2_key: string }>>;
```
(Uses `env.DB` internally via `cloudflare:workers` — no db parameter.)

### `src/lib/storage.ts`
```ts
export function bodyKey(id: string): string;                    // `pastes/${id}.txt`
export function putBody(key: string, content: string): Promise<void>;
export function getBody(key: string): Promise<string | null>;
export function deleteBody(key: string | string[]): Promise<void>;
```

### `src/lib/highlight.ts`
```ts
// shiki fine-grained core + JS regex engine (createJavaScriptRegexEngine), lazy
// module-scope singleton, ONLY the grammars in LANGUAGES, themes vitesse-light +
// vitesse-dark via `themes: { light, dark }` dual output with defaultColor 'light'.
// If lang is 'plaintext'/unknown OR content > 512_000 bytes OR > 10_000 lines:
// return escaped plain output. html ALWAYS includes the `.shiki` <pre> wrapper
// (hand-build it for the plain path) so UI styling is uniform.
export function highlight(code: string, language: string): Promise<{ html: string; highlighted: boolean }>;
```

### `src/lib/gauntlet.ts` — the shared read path (pages AND endpoints use this; never inline it)
```ts
export type Resolution =
  | { status: 'not_found' }                                   // no row -> 404
  | { status: 'gone' }                                        // expired (purged lazily) or burn already claimed -> 410
  | { status: 'locked'; meta: PasteMeta }                     // password required, no valid cookie -> 403 / gate UI
  | { status: 'burn_pending'; meta: PasteMeta }               // burn paste, not yet claimed -> interstitial / 409
  | { status: 'ok'; meta: PasteMeta; content: string };

// Looks up the row; if expired: waitUntil-purges row+body, returns 'gone'.
// If password-protected and no valid unlock cookie: 'locked'.
// If burn && !opts.claimBurn: 'burn_pending' (do NOT fetch the body).
// If burn && opts.claimBurn: atomically claim via claimBurn(); loser gets 'gone';
//   winner fetches the body from R2 FIRST, then waitUntil-deletes the R2 object.
// Otherwise: fetch body; missing body => 'gone' (+ waitUntil purge of the row).
// On 'ok' for non-burn pastes the caller decides whether to count the view.
export function resolvePaste(
  id: string,
  opts: { claimBurn?: boolean; waitUntil?: (p: Promise<unknown>) => void }
): Promise<Resolution>;
```

### `src/lib/http.ts`
```ts
export function json(data: unknown, status?: number, headers?: HeadersInit): Response;
export function jsonError(status: number, error: string): Response;       // body { "error": string }
export function pasteUrl(id: string): string;      // `${env.PUBLIC_ORIGIN}/p/${id}`
export function rawUrl(id: string): string;        // `${env.PUBLIC_ORIGIN}/raw/${id}`
export function isoOrNull(unixSeconds: number | null): string | null;     // ISO 8601 Z
```

### `src/worker.ts` (AGENT CORE) — custom Worker entry
```ts
import { handle } from '@astrojs/cloudflare/handler';
// default export { fetch: handle-based, scheduled: sweep }
// scheduled sweep: loop listExpiredBatch(now, 500) -> deleteBody(keys) -> DELETE rows
//   (batched IN (...)) until empty. Then orphan sweep: BUCKET.list (up to 1000 keys,
//   prefix 'pastes/'), for objects uploaded > 24h ago check row existence (single
//   SELECT id IN (...)), delete keyless objects.
```
Verify the exact `handle` signature against `node_modules/@astrojs/cloudflare` — the sibling
project uses `handle(request, env, ctx)` inside `fetch`.

## Burn / lock / raw policy (uniform everywhere)

- Burn claim happens ONLY via `POST /p/:id` with form field `action=burn` (the interstitial
  button). GET of page shows the interstitial; GET raw/download/API on an unclaimed burn
  paste → **409** with error `"burn_after_read"` (plain-text message for raw/download:
  `This paste burns after reading. Open /p/:id to view it once.`). After the claim the paste
  is gone everywhere (410).
- Locked pastes: page shows the gate; raw/download/API GET without valid cookie → **403**
  (`"password_required"`). `POST /api/pastes/:id/verify` body `{ "password": "..." }`:
  correct → 200 `{ "ok": true }` + `Set-Cookie` unlock cookie; wrong → 401
  (`"wrong_password"`). Best-effort throttle: module-scope Map, 5 failures/60s per
  `${id}` + CF-Connecting-IP → 429 (`"too_many_attempts"`).
- Expired → **410** everywhere (`"expired"` / page state).
- Encrypted pastes: raw serves the envelope as text/plain; download uses extension `.json.enc`... no:
  use plain `.txt`; page handles client-side decryption. API GET returns the envelope string
  in `content` with `is_encrypted: true`.

## API shapes (AGENT API)

`POST /api/pastes` → 201:
```json
{ "id": "Vq3xN7pA", "url": "...", "raw_url": "...",
  "delete_token": "64-hex — shown exactly once",
  "expires_at": "2026-08-25T13:00:00Z" }
```
Create flow: parseCreateRequest → newPasteId (retry insert up to 3× on PK conflict, new id
each time) → hashPassword if password → putBody FIRST → insertPaste; if insert throws after
retries, deleteBody (compensating) and 500. Errors: 400 bad fields, 413 too large.

`GET /api/pastes/:id` → 200:
```json
{ "id": "...", "title": null, "language": "javascript", "visibility": "unlisted",
  "created_at": "ISO", "expires_at": "ISO|null", "burn_after_read": false,
  "is_encrypted": false, "size_bytes": 22, "line_count": 1, "view_count": 3,
  "content": "...", "url": "...", "raw_url": "..." }
```
(404 / 410 / 403 / 409 per the policy above. A successful GET counts a view via
incrementViews + waitUntil.)

`DELETE /api/pastes/:id`: `Authorization: Bearer <delete_token>` (also accept
`?token=`); sha256Hex(token) must equal `delete_token_hash` (compare constant-time-ish).
204 on success (delete row + body), 401 bad/missing token, 404 unknown id.

`GET /raw/:id` → `text/plain; charset=utf-8`, `X-Content-Type-Options: nosniff`,
`Cache-Control: no-store`. `GET /download/:id` → same + `Content-Disposition:
attachment; filename="<title-or-id>.<ext>"` (sanitize filename to `[A-Za-z0-9._-]`).
Raw/download also count views (waitUntil), EXCEPT burn pastes (they 409 pre-claim).

## E2E envelope (UI encrypts/decrypts; server treats as opaque)

```json
{ "v": 1, "alg": "AES-GCM", "kdf": "raw" | "PBKDF2-SHA-256",
  "iter": 300000, "salt": "b64url (kdf=PBKDF2 only)",
  "iv": "b64url 12 bytes", "ct": "b64url" }
```
- `kdf: "raw"`: random 32-byte key, shared via URL fragment `#k=<b64url key>`.
- `kdf: "PBKDF2-SHA-256"`: key derived in-browser from a passphrase (300k iterations).
- View page for `is_encrypted`: fetch envelope (embedded by server in a `<script type="application/json">` tag), read `location.hash` key or prompt for passphrase, decrypt with WebCrypto, render as PLAIN text (client-side, escaped, with line numbers) — no client-side shiki.
- Create page: encrypt before POST; send `encrypted: true`; language field still set; show the share link WITH `#k=` fragment appended when kdf=raw.

## UI spec (AGENT UI)

The approved visual design is `docs/design-mock.html` — open it and replicate it faithfully
(tokens, spacing, type: Bricolage Grotesque / Instrument Sans / JetBrains Mono via Google
Fonts; light default; dark via `data-theme="dark"` on `<html>`; toggle persisted to
localStorage + pre-paint inline head script). Wordmark: **edgepaste**. Keep the mock's
inline SVG icon symbol set. Screens: editor `/`, view `/p/:id`, recent `/recent`, gate and
burn interstitial as states of `/p/:id`, plus `404.astro` styled like the mock's cards.
- Editor submits via client-side `fetch` to `POST /api/pastes` (JSON); on success show a
  result panel: share link (with fragment for E2E), copy buttons, QR (uqr `renderSVG`,
  client-side), and the one-time delete token with a "store this" warning. Fork:
  `/?fork=<id>` prefills via `GET /api/pastes/:id` client-side.
- View page (server-rendered): highlight() output, dual-theme shiki CSS
  (`[data-theme="dark"] .shiki, [data-theme="dark"] .shiki span { color: var(--shiki-dark) !important; background-color: var(--shiki-dark-bg) !important; }`),
  line numbers + wrap toggles (CSS-based), action bar (Copy/Raw/Download/Fork/QR/Copy link),
  meta line, view counter. POST handling in the page frontmatter for `action=burn`
  (claimBurn via resolvePaste) and the destroyed-banner final render.
- Stats strip on editor: live lines/chars/bytes vs cap (client JS).
- Tailwind 4 is available via the Vite plugin, but the mock's token CSS is the source of
  truth — port it into `src/styles/global.css` (with `@import "tailwindcss";` at top) and
  prefer the mock's classes; use Tailwind utilities only where convenient.
- Every interactive control keyboard-accessible; `prefers-reduced-motion` respected.

## Acceptance (integration will run these; write code that passes)

1. `npm run build` and `npm run check` (tsc --noEmit) exit 0.
2. `wrangler d1 migrations apply edgepaste --local` applies.
3. `wrangler dev`: curl create → JSON → `/raw/:id` byte-identical; burn second read 410;
   expired 410; password gate 403→verify→200; DELETE with token 204; 10MB+1 → 413.
