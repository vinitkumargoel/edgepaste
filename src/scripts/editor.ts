/**
 * Editor screen: live stats + gutter, option wiring, optional in-browser
 * encryption, POST /api/pastes, the result panel and `?fork=<id>` prefill.
 */
import { byteLength, countLines, formatBytes, formatCount } from './format';
import {
  decryptEnvelope,
  DecryptError,
  encryptWithPassphrase,
  encryptWithRandomKey,
  keyFromHash,
  parseEnvelope,
} from './e2e';
import './qr';

// Unconstrained on purpose: worker-configuration.d.ts merges Cloudflare's
// HTMLRewriter `Element` into the DOM `Element`, so `T extends HTMLElement`
// rejects HTMLSelectElement (its remove() signature no longer lines up).
const $ = <T>(id: string): T | null => document.getElementById(id) as T | null;

const content = $<HTMLTextAreaElement>('f-content');
const titleInput = $<HTMLInputElement>('f-title');
const languageSel = $<HTMLSelectElement>('f-language');
const expirationSel = $<HTMLSelectElement>('f-expiration');
const passwordInput = $<HTMLInputElement>('f-password');
const passphraseInput = $<HTMLInputElement>('f-passphrase');
const burnBox = $<HTMLInputElement>('f-burn');
const createBtn = $<HTMLButtonElement>('f-create');
const gutter = $<HTMLElement>('ed-gutter');
const stats = $<HTMLElement>('ed-stats');
const stLines = $<HTMLElement>('st-lines');
const stChars = $<HTMLElement>('st-chars');
const stBytes = $<HTMLElement>('st-bytes');
const stBar = $<HTMLElement>('st-bar');
const langChip = $<HTMLElement>('lang-chip');
const pwField = $<HTMLElement>('pw-field');
const encField = $<HTMLElement>('enc-field');
const encPassWrap = $<HTMLElement>('enc-pass-wrap');
const errorBox = $<HTMLElement>('ed-error');
const errorText = $<HTMLElement>('ed-error-text');
const forkNotice = $<HTMLElement>('fork-notice');
const forkNoticeText = $<HTMLElement>('fork-notice-text');
const edMain = $<HTMLElement>('ed-main');
const result = $<HTMLElement>('result');

const MAX_BYTES = Number(stats?.dataset['maxBytes'] ?? '10485760') || 10485760;
const GUTTER_CAP = 20000;

/* ------------------------------------------------------------------ helpers */

function radio(name: string): string {
  const checked = document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`);
  return checked?.value ?? '';
}

function showError(message: string): void {
  if (!errorBox || !errorText) return;
  errorText.textContent = message;
  errorBox.hidden = false;
}

function clearError(): void {
  if (errorBox) errorBox.hidden = true;
}

function showNotice(message: string): void {
  if (!forkNotice || !forkNoticeText) return;
  forkNoticeText.textContent = message;
  forkNotice.hidden = false;
}

/* -------------------------------------------------------------- live stats */

let statsQueued = false;

function paintStats(): void {
  statsQueued = false;
  if (!content) return;
  const text = content.value;
  const lines = countLines(text);
  const bytes = byteLength(text);

  if (stLines) stLines.textContent = `${formatCount(lines)} ${lines === 1 ? 'line' : 'lines'}`;
  if (stChars) stChars.textContent = `${formatCount(text.length)} chars`;
  if (stBytes) stBytes.textContent = formatBytes(bytes);
  if (stBar) stBar.style.width = `${Math.max(2, Math.min(100, (bytes / MAX_BYTES) * 100))}%`;

  const over = bytes > MAX_BYTES;
  stats?.classList.toggle('over', over);
  if (createBtn) createBtn.disabled = over;

  if (gutter) {
    const rows = Math.min(Math.max(1, lines), GUTTER_CAP);
    const wanted = String(rows);
    if (gutter.dataset['rows'] !== wanted) {
      gutter.dataset['rows'] = wanted;
      gutter.textContent = Array.from({ length: rows }, (_, i) => String(i + 1)).join('\n');
    }
  }
}

function queueStats(): void {
  if (statsQueued) return;
  statsQueued = true;
  requestAnimationFrame(paintStats);
}

content?.addEventListener('input', queueStats);
content?.addEventListener('scroll', () => {
  if (gutter && content) gutter.scrollTop = content.scrollTop;
});

/* ------------------------------------------------------------ option wiring */

function syncLangChip(): void {
  if (!langChip || !languageSel) return;
  const opt = languageSel.selectedOptions[0];
  langChip.textContent = opt ? opt.label : 'Plain text';
}
languageSel?.addEventListener('change', syncLangChip);

function syncProtection(): void {
  const mode = radio('protection');
  if (pwField) pwField.hidden = mode !== 'password';
  if (encField) encField.hidden = mode !== 'encrypt';
  if (mode !== 'password' && passwordInput) passwordInput.value = '';
  if (mode !== 'encrypt' && passphraseInput) passphraseInput.value = '';
  syncEncKey();
}

function syncEncKey(): void {
  if (!encPassWrap) return;
  encPassWrap.hidden = radio('protection') !== 'encrypt' || radio('enckey') !== 'passphrase';
}

for (const input of document.querySelectorAll<HTMLInputElement>('input[name="protection"]')) {
  input.addEventListener('change', syncProtection);
}
for (const input of document.querySelectorAll<HTMLInputElement>('input[name="enckey"]')) {
  input.addEventListener('change', syncEncKey);
}

/* Burn pastes are always unlisted — the server forces it, so say so up front. */
function syncBurn(): void {
  const burning = burnBox?.checked === true;
  for (const input of document.querySelectorAll<HTMLInputElement>('input[name="visibility"]')) {
    const isPublic = input.value === 'public';
    input.disabled = burning && isPublic;
    const label = input.closest('label');
    if (label) {
      label.title = burning && isPublic ? 'Burn-after-reading pastes are always unlisted' : '';
    }
    if (burning && isPublic && input.checked) {
      const unlisted = document.querySelector<HTMLInputElement>('input[name="visibility"][value="unlisted"]');
      if (unlisted) unlisted.checked = true;
    }
  }
}
burnBox?.addEventListener('change', syncBurn);

/* ----------------------------------------------------------------- creation */

interface CreatePayload {
  content: string;
  language: string;
  title: string | null;
  expiration: string;
  visibility: string;
  burn_after_read: boolean;
  password: string | null;
  encrypted: boolean;
}

interface CreateResponse {
  id: string;
  url: string;
  raw_url: string;
  delete_token: string;
  expires_at: string | null;
}

function humanizeApiError(status: number, code: string | null): string {
  if (status === 413) return `Too large — the cap is ${formatBytes(MAX_BYTES)}.`;
  switch (code) {
    case 'content_required':
    case 'empty_content':
      return 'There is nothing to paste yet.';
    case 'too_large':
      return `Too large — the cap is ${formatBytes(MAX_BYTES)}.`;
    case 'invalid_language':
      return 'That language is not one we know how to store.';
    case 'invalid_expiration':
      return 'That expiry option is not valid.';
    case 'invalid_visibility':
      return 'That visibility option is not valid.';
    case 'title_too_long':
      return 'The title is longer than 200 characters.';
    case 'password_too_long':
      return 'The password is longer than 256 characters.';
    case 'too_many_attempts':
      return 'Too many requests — wait a moment and try again.';
    case 'storage_failed':
    case 'create_failed':
      return "The server couldn't store that paste. Nothing was saved — try again.";
    case 'invalid_json':
    case 'invalid_body':
      return 'The browser sent something the server could not read. Reload and try again.';
    default:
      break;
  }
  if (code) return code.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) + '.';
  if (status >= 500) return "The server couldn't store that paste. Try again.";
  return `Create failed (HTTP ${status}).`;
}

let busy = false;

function setBusy(state: boolean, label?: string): void {
  busy = state;
  if (!createBtn) return;
  createBtn.disabled = state;
  if (state) {
    if (createBtn.dataset['label'] === undefined) createBtn.dataset['label'] = createBtn.innerHTML;
    createBtn.textContent = label ?? 'Creating…';
  } else {
    const original = createBtn.dataset['label'];
    if (original !== undefined) createBtn.innerHTML = original;
  }
}

function showResult(data: CreateResponse, fragment: string, encrypted: boolean): void {
  const shareUrl = `${location.origin}/p/${data.id}${fragment}`;
  const rawUrl = `${location.origin}/raw/${data.id}`;

  const urlOut = $<HTMLInputElement>('res-url');
  if (urlOut) urlOut.value = shareUrl;
  const tokenOut = $<HTMLElement>('res-token');
  if (tokenOut) tokenOut.textContent = data.delete_token;
  const openLink = $<HTMLAnchorElement>('res-open');
  if (openLink) openLink.href = shareUrl;
  const rawLink = $<HTMLAnchorElement>('res-raw');
  if (rawLink) {
    rawLink.href = rawUrl;
    rawLink.title = encrypted ? 'Serves the encrypted envelope, not the plaintext' : '';
  }
  const qrBtn = $<HTMLElement>('res-qr');
  qrBtn?.setAttribute('data-qr', shareUrl);
  const keyNote = $<HTMLElement>('res-keynote');
  if (keyNote) keyNote.hidden = fragment === '';

  const sub = $<HTMLElement>('res-sub');
  if (sub) {
    const bits: string[] = [];
    bits.push(radio('visibility') === 'public' ? 'Public' : 'Unlisted');
    if (burnBox?.checked) bits.push('burns on first view');
    if (encrypted) bits.push('encrypted in your browser');
    else if (radio('protection') === 'password') bits.push('password protected');
    bits.push(
      data.expires_at
        ? `expires ${new Date(data.expires_at).toLocaleString()}`
        : 'never expires',
    );
    sub.textContent = bits.join(' · ') + '.';
  }

  if (edMain) edMain.hidden = true;
  if (result) {
    result.hidden = false;
    result.scrollIntoView({ block: 'nearest' });
  }
  urlOut?.focus();
  urlOut?.select();
}

async function create(): Promise<void> {
  if (busy || !content) return;
  clearError();

  const text = content.value;
  if (text.length === 0) {
    showError('There is nothing to paste yet.');
    content.focus();
    return;
  }
  const bytes = byteLength(text);
  if (bytes > MAX_BYTES) {
    showError(`That is ${formatBytes(bytes)} — the cap is ${formatBytes(MAX_BYTES)}.`);
    return;
  }

  const protection = radio('protection');
  const payload: CreatePayload = {
    content: text,
    language: languageSel?.value ?? 'plaintext',
    title: titleInput?.value.trim() ? titleInput.value.trim() : null,
    expiration: expirationSel?.value ?? 'never',
    visibility: radio('visibility') || 'unlisted',
    burn_after_read: burnBox?.checked === true,
    password: protection === 'password' ? (passwordInput?.value ?? '') : null,
    encrypted: false,
  };

  if (protection === 'password' && !payload.password) {
    showError('Set a password, or switch protection back to None.');
    passwordInput?.focus();
    return;
  }

  let fragment = '';
  if (protection === 'encrypt') {
    const usePassphrase = radio('enckey') === 'passphrase';
    const passphrase = passphraseInput?.value ?? '';
    if (usePassphrase && passphrase.length === 0) {
      showError('Choose a passphrase, or switch to a random key.');
      passphraseInput?.focus();
      return;
    }
    setBusy(true, 'Encrypting…');
    try {
      if (usePassphrase) {
        payload.content = JSON.stringify(await encryptWithPassphrase(text, passphrase));
      } else {
        const { envelope, keyB64 } = await encryptWithRandomKey(text);
        payload.content = JSON.stringify(envelope);
        fragment = `#k=${keyB64}`;
      }
    } catch {
      setBusy(false);
      showError('Your browser could not encrypt this paste. WebCrypto needs a secure (https) page.');
      return;
    }
    payload.encrypted = true;
    payload.password = null;
  }

  setBusy(true, 'Creating…');
  try {
    const response = await fetch('/api/pastes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (response.status !== 201) {
      let code: string | null = null;
      try {
        const body = (await response.json()) as { error?: unknown };
        if (typeof body.error === 'string') code = body.error;
      } catch {
        /* non-JSON error body */
      }
      setBusy(false);
      showError(humanizeApiError(response.status, code));
      return;
    }
    const data = (await response.json()) as CreateResponse;
    showResult(data, fragment, payload.encrypted);
    setBusy(false);
  } catch {
    setBusy(false);
    showError('Network error — the paste was not created.');
  }
}

createBtn?.addEventListener('click', (event) => {
  event.preventDefault();
  void create();
});

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    if (result && !result.hidden) return;
    event.preventDefault();
    void create();
  }
});

/* --------------------------------------------------------------------- fork */

interface PasteResponse {
  content: string;
  language: string;
  title: string | null;
  is_encrypted: boolean;
}

function forkFailure(status: number): string {
  switch (status) {
    case 403:
      return 'That paste is password-protected — open it and unlock it first, then fork from there.';
    case 409:
      return 'That paste burns after reading, so it cannot be forked.';
    case 410:
      return 'That paste is gone — it expired or was already burned.';
    case 404:
      return 'That paste does not exist.';
    default:
      return `Could not load that paste to fork (HTTP ${status}).`;
  }
}

async function prefillFork(id: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`/api/pastes/${encodeURIComponent(id)}`, {
      headers: { Accept: 'application/json' },
    });
  } catch {
    showNotice('Could not reach the server to load that paste.');
    return;
  }
  if (!response.ok) {
    showNotice(forkFailure(response.status));
    return;
  }

  const data = (await response.json()) as PasteResponse;
  let body = data.content;

  if (data.is_encrypted) {
    const envelope = parseEnvelope(body);
    const key = keyFromHash();
    if (!envelope) {
      showNotice('That paste is encrypted and its envelope could not be read.');
      return;
    }
    if (envelope.kdf !== 'raw' || !key) {
      showNotice(
        'That paste is encrypted. Open it first, decrypt it there, then fork — the key never travels with a plain /?fork link.',
      );
      return;
    }
    try {
      body = await decryptEnvelope(envelope, { keyB64: key });
    } catch (error) {
      showNotice(error instanceof DecryptError ? error.message : 'Could not decrypt that paste.');
      return;
    }
  }

  if (content) content.value = body;
  if (titleInput && data.title) titleInput.value = data.title;
  if (languageSel && data.language) {
    languageSel.value = data.language;
    syncLangChip();
  }
  paintStats();
  content?.focus();
}

/* ------------------------------------------------------------------ startup */

syncLangChip();
syncProtection();
syncBurn();
paintStats();

const forkId = new URLSearchParams(location.search).get('fork');
if (forkId) void prefillFork(forkId);
