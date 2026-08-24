# edgepaste

A production-grade pastebin that runs entirely on Cloudflare's edge — live at
**[edgepaste.vinitk.dev](https://edgepaste.vinitk.dev)**.

Astro SSR on Workers, paste **metadata in D1**, paste **bodies in R2**. One Worker
serves the UI, the JSON API, and a daily cron sweep.

## Features

- **Syntax highlighting** — Shiki (fine-grained core + JS regex engine), 16 languages,
  dual light/dark themes, line numbers + wrap toggles
- **Expiry** — never / 10m / 1h / 1d / 1w / 1mo; enforced on read (410), swept daily by cron
- **Burn after reading** — viewed exactly once; the claim is an atomic
  `DELETE … RETURNING`, so two simultaneous readers can never both see it; link
  previews and crawlers can't trigger it (claim fires on POST, never GET)
- **Password protection** — PBKDF2-SHA-256 via WebCrypto, signed unlock cookies
- **End-to-end encryption** — AES-GCM in the browser; the key travels in the URL
  `#fragment` (never sent to the server) or derives from a passphrase; the server
  stores an envelope it cannot open
- **Public / unlisted** visibility, recent feed, fork, raw + download views, QR sharing,
  one-time delete tokens
- Light theme by default, dark one click away

## API

```bash
# create
curl -X POST https://edgepaste.vinitk.dev/api/pastes \
  -H "Content-Type: application/json" \
  -d '{"content":"console.log(\"hello\");","language":"javascript","expiration":"1h"}'
# → { "id", "url", "raw_url", "delete_token", "expires_at" }

# read           GET    /api/pastes/:id     (also /raw/:id, /download/:id)
# unlock         POST   /api/pastes/:id/verify   {"password":"..."}
# delete         DELETE /api/pastes/:id     Authorization: Bearer <delete_token>
```

Create fields: `content` (required), `language`, `title`, `expiration`
(`never|10m|1h|1d|1w|1mo`), `visibility` (`public|unlisted`), `burn_after_read`,
`password`, `encrypted`. JSON and multipart form-data both accepted. Max paste size 10 MB.

## Stack

Astro 7 (`output: 'server'`) · `@astrojs/cloudflare` v14 · Tailwind 4 · Shiki ·
TypeScript strict · D1 · R2 · Workers cron. No Node-native dependencies — everything
runs in the V8 isolate.

## Develop

```bash
npm install
npx wrangler d1 migrations apply edgepaste --local
npm run dev        # astro dev with real local bindings (workerd)
npm run preview    # astro build && wrangler dev
npm run check      # tsc --noEmit
```

## Deploy

```bash
npx wrangler d1 create <db> && npx wrangler r2 bucket create <bucket>   # once
npx wrangler d1 migrations apply <db> --remote
npx wrangler secret put SESSION_SECRET
npm run deploy     # astro build && wrangler deploy
```

Bindings and the custom-domain route live in `wrangler.toml`. Design + architecture
docs are under [`docs/`](docs/) — `CONTRACTS.md` (module and API contracts) and
`design-mock.html` (the approved visual spec).
