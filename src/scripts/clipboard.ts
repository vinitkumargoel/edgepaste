/**
 * Delegated copy-to-clipboard with a brief "Copied" state on the button itself.
 *
 * Triggers (any clickable element):
 *   data-copy="<css selector>"  copy that element's value / textContent
 *   data-copy-text="<literal>"  copy the attribute value verbatim
 *   data-copy-url               copy location.href (share link, fragment included)
 *   data-copy-code              copy the rendered paste body
 */

const RESET_MS = 1500;
const originals = new WeakMap<HTMLElement, string>();
const timers = new WeakMap<HTMLElement, number>();

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* insecure context, denied permission, or no async clipboard */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Swap a button's label for a transient confirmation. */
export function flash(btn: HTMLElement, ok: boolean): void {
  if (!originals.has(btn)) originals.set(btn, btn.innerHTML);
  const prev = timers.get(btn);
  if (prev !== undefined) window.clearTimeout(prev);

  btn.innerHTML = ok
    ? '<svg class="ic" aria-hidden="true" focusable="false"><use href="#i-check"></use></svg>Copied'
    : '<svg class="ic" aria-hidden="true" focusable="false"><use href="#i-alert"></use></svg>Copy failed';
  btn.classList.toggle('is-copied', ok);

  timers.set(
    btn,
    window.setTimeout(() => {
      const original = originals.get(btn);
      if (original !== undefined) btn.innerHTML = original;
      btn.classList.remove('is-copied');
      timers.delete(btn);
    }, RESET_MS),
  );
}

/** The rendered body text: works for shiki output, the plain path and decrypted output. */
export function pasteText(): string {
  const card = document.getElementById('code-card');
  if (!card) return '';
  const pre = card.querySelector<HTMLElement>('pre.shiki, pre.codepane');
  const source = pre?.querySelector('code') ?? pre;
  return source?.textContent ?? '';
}

function resolve(trigger: HTMLElement): string | null {
  if (trigger.hasAttribute('data-copy-url')) return location.href;
  if (trigger.hasAttribute('data-copy-code')) return pasteText();

  const literal = trigger.getAttribute('data-copy-text');
  if (literal !== null) return literal;

  const selector = trigger.getAttribute('data-copy');
  if (selector) {
    const el = document.querySelector(selector);
    if (!el) return null;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
    return el.textContent ?? '';
  }
  return null;
}

document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const trigger = target.closest<HTMLElement>(
    '[data-copy],[data-copy-text],[data-copy-url],[data-copy-code]',
  );
  if (!trigger) return;

  event.preventDefault();
  const text = resolve(trigger);
  if (text === null) {
    flash(trigger, false);
    return;
  }
  void copyText(text).then((ok) => flash(trigger, ok));
});
