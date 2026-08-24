import { createHighlighterCore } from 'shiki/core';
import type { HighlighterCore, LanguageInput } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

/**
 * Fine-grained shiki bundle: core + the JavaScript RegExp engine (no WASM, so
 * nothing extra has to be shipped to or compiled by the Worker), the two
 * vitesse themes, and only the grammars in the LANGUAGES registry.
 *
 * The highlighter is a lazy module-scope singleton; grammars load on first use
 * so a cold request never parses all fifteen TextMate grammars.
 */

const THEME_LIGHT = 'vitesse-light';
const THEME_DARK = 'vitesse-dark';

/** Beyond these, tokenizing costs more CPU than the result is worth. */
const MAX_HIGHLIGHT_BYTES = 512_000;
const MAX_HIGHLIGHT_LINES = 10_000;

/**
 * Mirrors the non-null `shiki` ids in `LANGUAGES` (src/lib/validate.ts). The
 * import specifiers are static so the bundler can see exactly which grammars
 * are reachable.
 */
const LANGUAGE_LOADERS: Record<string, LanguageInput> = {
  javascript: () => import('@shikijs/langs/javascript'),
  typescript: () => import('@shikijs/langs/typescript'),
  jsx: () => import('@shikijs/langs/jsx'),
  tsx: () => import('@shikijs/langs/tsx'),
  python: () => import('@shikijs/langs/python'),
  go: () => import('@shikijs/langs/go'),
  rust: () => import('@shikijs/langs/rust'),
  json: () => import('@shikijs/langs/json'),
  yaml: () => import('@shikijs/langs/yaml'),
  toml: () => import('@shikijs/langs/toml'),
  markdown: () => import('@shikijs/langs/markdown'),
  html: () => import('@shikijs/langs/html'),
  css: () => import('@shikijs/langs/css'),
  sql: () => import('@shikijs/langs/sql'),
  bash: () => import('@shikijs/langs/bash'),
};

/**
 * Byte-for-byte the root element shiki emits for these two themes with
 * `defaultColor: 'light'`, so the plain fallback inherits the same CSS
 * (including the `--shiki-dark*` variables the dark-mode override reads).
 */
const PLAIN_PRE_OPEN =
  '<pre class="shiki shiki-themes vitesse-light vitesse-dark" ' +
  'style="background-color:#ffffff;--shiki-dark-bg:#121212;color:#393a34;--shiki-dark:#dbd7caee" ' +
  'tabindex="0"><code>';
const PLAIN_PRE_CLOSE = '</code></pre>';

const encoder = new TextEncoder();

let highlighterPromise: Promise<HighlighterCore> | null = null;
const loadedLanguages = new Map<string, Promise<void>>();

function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      engine: createJavaScriptRegexEngine(),
      themes: [import('@shikijs/themes/vitesse-light'), import('@shikijs/themes/vitesse-dark')],
      langs: [],
    }).catch((err: unknown) => {
      highlighterPromise = null;
      throw err;
    });
  }
  return highlighterPromise;
}

function ensureLanguage(highlighter: HighlighterCore, lang: string): Promise<void> {
  let pending = loadedLanguages.get(lang);
  if (!pending) {
    const loader = LANGUAGE_LOADERS[lang];
    if (!loader) return Promise.reject(new Error(`unknown grammar: ${lang}`));
    pending = highlighter.loadLanguage(loader).catch((err: unknown) => {
      loadedLanguages.delete(lang);
      throw err;
    });
    loadedLanguages.set(lang, pending);
  }
  return pending;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function plainHtml(code: string): string {
  const lines = code
    .split('\n')
    .map((line) => `<span class="line">${escapeHtml(line)}</span>`)
    .join('\n');
  return `${PLAIN_PRE_OPEN}${lines}${PLAIN_PRE_CLOSE}`;
}

function tooBigToHighlight(code: string): boolean {
  // `code.length` is a lower bound on the UTF-8 byte length, so an early exit
  // here avoids encoding multi-megabyte pastes just to reject them.
  if (code.length > MAX_HIGHLIGHT_BYTES) return true;
  if (encoder.encode(code).length > MAX_HIGHLIGHT_BYTES) return true;

  let lines = 1;
  for (let i = 0; i < code.length; i++) {
    if (code.charCodeAt(i) === 10 && ++lines > MAX_HIGHLIGHT_LINES) return true;
  }
  return false;
}

export async function highlight(
  code: string,
  language: string,
): Promise<{ html: string; highlighted: boolean }> {
  if (!(language in LANGUAGE_LOADERS) || tooBigToHighlight(code)) {
    return { html: plainHtml(code), highlighted: false };
  }

  try {
    const highlighter = await getHighlighter();
    await ensureLanguage(highlighter, language);
    const html = highlighter.codeToHtml(code, {
      lang: language,
      themes: { light: THEME_LIGHT, dark: THEME_DARK },
      defaultColor: 'light',
    });
    return { html, highlighted: true };
  } catch {
    // A grammar or tokenizer failure must never take the page down.
    return { html: plainHtml(code), highlighted: false };
  }
}
