import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  output: 'server',
  trailingSlash: 'ignore',
  // No sessions: without this the adapter auto-provisions a SESSION KV binding.
  session: false,
  // The JSON API must accept non-browser POSTs (curl, CLI); Astro's
  // origin-header CSRF check would 403 them. Burn/delete are protected by
  // explicit tokens and POST-only semantics instead.
  security: { checkOrigin: false },
  devToolbar: { enabled: false },
  adapter: cloudflare({ imageService: 'passthrough' }),
  vite: { plugins: [tailwindcss()] },
});
