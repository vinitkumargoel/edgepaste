/**
 * QR overlay. Any element with `data-qr` opens it; the attribute value is the
 * URL to encode (empty = the current URL, fragment and all). Dismissable with
 * Esc, the backdrop, or the close button; focus is parked in the dialog and
 * handed back to the trigger on close.
 */
import { renderSVG } from 'uqr';

const overlay = document.getElementById('qr-overlay');
const box = document.getElementById('qr-box');
const urlOut = document.getElementById('qr-url');
const closeBtn = overlay?.querySelector<HTMLElement>('[data-qr-close]') ?? null;

let lastFocus: HTMLElement | null = null;

function close(): void {
  if (!overlay || overlay.hidden) return;
  overlay.hidden = true;
  if (box) box.innerHTML = '';
  lastFocus?.focus();
  lastFocus = null;
}

export function openQr(url: string): void {
  if (!overlay || !box) return;
  // uqr emits <svg><rect …> only — the URL is encoded as modules, never as markup.
  box.innerHTML = renderSVG(url, {
    ecc: 'M',
    border: 2,
    pixelSize: 8,
    whiteColor: '#ffffff',
    blackColor: '#101010',
  });
  const svg = box.querySelector('svg');
  svg?.setAttribute('role', 'img');
  svg?.setAttribute('aria-label', `QR code for ${url}`);
  if (urlOut) urlOut.textContent = url;

  lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  overlay.hidden = false;
  closeBtn?.focus();
}

document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;

  if (target.closest('[data-qr-close]')) {
    close();
    return;
  }
  if (overlay && !overlay.hidden && target === overlay) {
    close();
    return;
  }
  const trigger = target.closest<HTMLElement>('[data-qr]');
  if (!trigger) return;
  event.preventDefault();
  openQr(trigger.getAttribute('data-qr') || location.href);
});

document.addEventListener('keydown', (event) => {
  if (!overlay || overlay.hidden) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    close();
    return;
  }
  // keep tabbing inside the dialog — it only holds the close button
  if (event.key === 'Tab') {
    event.preventDefault();
    closeBtn?.focus();
  }
});
