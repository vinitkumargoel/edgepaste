/**
 * End-to-end decryption on the view page. The server embeds the opaque
 * envelope in <script type="application/json" id="envelope">; the key arrives
 * in the URL fragment (#k=…) or from a passphrase typed here. Nothing typed on
 * this page ever leaves the browser.
 */
import { decryptEnvelope, DecryptError, keyFromHash, parseEnvelope, type Envelope } from './e2e';
import { applyCodePrefs } from './view';

const panel = document.getElementById('enc-panel');
const slot = document.getElementById('code-slot');
const form = document.getElementById('enc-form') as HTMLFormElement | null;
const input = document.getElementById('enc-secret') as HTMLInputElement | null;
const submit = document.getElementById('enc-submit') as HTMLButtonElement | null;
const label = document.getElementById('enc-secret-label');
const hint = document.getElementById('enc-hint-text');
const error = document.getElementById('enc-error');
const errorText = document.getElementById('enc-error-text');
const source = document.getElementById('envelope');

const envelope: Envelope | null = source?.textContent ? parseEnvelope(source.textContent) : null;

/** Reveal the panel with the right affordance for this envelope's kdf. */
function configure(mode: 'key' | 'passphrase'): void {
  if (label) label.textContent = mode === 'key' ? 'Decryption key' : 'Passphrase';
  if (input) {
    input.type = mode === 'key' ? 'text' : 'password';
    input.placeholder = mode === 'key' ? 'paste the key, or the full link' : 'passphrase';
    input.autocomplete = 'off';
    input.spellcheck = false;
  }
  if (hint) {
    hint.textContent =
      mode === 'key'
        ? 'The key lives in the #k= fragment of the share link — the part after the hash, which browsers never send to a server. Paste the complete link, or just the key.'
        : 'The passphrase is stretched with PBKDF2 in your browser. It is never sent to the server.';
  }
  if (panel) panel.hidden = false;
}

function fail(message: string): void {
  if (errorText) errorText.textContent = message;
  if (error) error.hidden = false;
  if (panel) panel.hidden = false;
  if (submit) submit.disabled = false;
  input?.focus();
  input?.select();
}

/** Build the same two-pane code card the server renders, with escaped text. */
function render(plaintext: string): void {
  if (!slot) return;
  const lines = plaintext.length === 0 ? 1 : plaintext.split('\n').length;

  const card = document.createElement('div');
  card.className = 'code-card lines';
  card.id = 'code-card';

  const gutter = document.createElement('pre');
  gutter.className = 'gutter';
  gutter.setAttribute('aria-hidden', 'true');
  gutter.textContent = Array.from({ length: lines }, (_, i) => String(i + 1)).join('\n');

  const pane = document.createElement('pre');
  pane.className = 'codepane';
  // textContent, never innerHTML: the plaintext is attacker-controlled.
  pane.textContent = plaintext;

  // appendChild (not append): worker-configuration.d.ts merges Cloudflare's
  // HTMLRewriter `Element` into the DOM `Element`, which shadows append().
  card.appendChild(gutter);
  card.appendChild(pane);
  slot.replaceChildren(card);
  if (panel) panel.hidden = true;
  if (error) error.hidden = true;
  applyCodePrefs();
}

function attempt(secret: { keyB64?: string; passphrase?: string }, onOk?: () => void): void {
  if (!envelope) return;
  if (submit) submit.disabled = true;
  void decryptEnvelope(envelope, secret)
    .then((plaintext) => {
      onOk?.();
      render(plaintext);
      if (submit) submit.disabled = false;
    })
    .catch((err: unknown) => {
      configure(envelope.kdf === 'raw' ? 'key' : 'passphrase');
      fail(err instanceof DecryptError ? err.message : 'Could not decrypt this paste.');
    });
}

/* ------------------------------------------------------------------ startup */

if (source) {
  if (!envelope) {
    configure('key');
    fail('This paste is marked encrypted, but its envelope could not be read.');
  } else if (envelope.kdf === 'raw') {
    const key = keyFromHash();
    if (key) attempt({ keyB64: key });
    else {
      configure('key');
      if (hint) {
        hint.textContent =
          'This link is missing its #k= fragment — the part after the hash that carries the key. Paste the complete link, or just the key itself.';
      }
    }
  } else {
    configure('passphrase');
  }
}

form?.addEventListener('submit', (event) => {
  event.preventDefault();
  if (error) error.hidden = true;
  if (!envelope) return;

  const value = (input?.value ?? '').trim();
  if (value.length === 0) {
    fail(envelope.kdf === 'raw' ? 'Paste the key or the full link first.' : 'Enter the passphrase first.');
    return;
  }

  if (envelope.kdf === 'raw') {
    // Accept either a bare key or a whole link with the fragment still on it.
    const hashAt = value.indexOf('#');
    const key = hashAt === -1 ? value : (keyFromHash(value.slice(hashAt)) ?? '');
    if (!key) {
      fail('That link has no #k= fragment in it.');
      return;
    }
    attempt({ keyB64: key }, () => {
      // Put the key back on the address bar so reload, QR and Copy link work.
      history.replaceState(null, '', `${location.pathname}${location.search}#k=${key}`);
    });
    return;
  }

  attempt({ passphrase: value });
});
