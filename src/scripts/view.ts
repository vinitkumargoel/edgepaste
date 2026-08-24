/**
 * Paste view: the line-number and wrap toggles (pure CSS class flips on
 * #code-card, remembered per viewer) and fragment-preserving fork links.
 */
import './qr';

const LINES_KEY = 'ep-lines';
const WRAP_KEY = 'ep-wrap';

function read(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw === '1';
  } catch {
    return fallback;
  }
}

function write(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* storage blocked — the toggle still holds for this page view */
  }
}

let showLines = read(LINES_KEY, true);
let wrapLines = read(WRAP_KEY, false);

function paintButton(id: string, on: boolean, disabled = false): void {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.setAttribute('aria-pressed', String(on));
  btn.querySelector('.sw')?.classList.toggle('on', on);
  if (disabled) btn.setAttribute('aria-disabled', 'true');
  else btn.removeAttribute('aria-disabled');
}

/** Apply the current preferences to #code-card. Safe to call before it exists. */
export function applyCodePrefs(): void {
  const card = document.getElementById('code-card');
  card?.classList.toggle('lines', showLines);
  card?.classList.toggle('wrap', wrapLines);
  // Wrapped lines and a fixed gutter can't stay in step, so the gutter steps aside.
  paintButton('t-lines', showLines && !wrapLines, wrapLines);
  paintButton('t-wrap', wrapLines);
}

document.getElementById('t-lines')?.addEventListener('click', () => {
  if (wrapLines) return; // gutter is unavailable while wrapping
  showLines = !showLines;
  write(LINES_KEY, showLines);
  applyCodePrefs();
});

document.getElementById('t-wrap')?.addEventListener('click', () => {
  wrapLines = !wrapLines;
  write(WRAP_KEY, wrapLines);
  applyCodePrefs();
});

/* Forking an end-to-end encrypted paste needs the key, which lives in the
   fragment — carry it across to /?fork=<id> so the editor can decrypt. */
for (const link of document.querySelectorAll<HTMLAnchorElement>('a[data-fork]')) {
  link.addEventListener('click', () => {
    if (location.hash && !link.href.includes('#')) link.href += location.hash;
  });
}

applyCodePrefs();
