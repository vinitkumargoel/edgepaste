/**
 * Theme toggle. Light is the default, so "light" means *no* data-theme
 * attribute — matching the pre-paint script in Base.astro.
 */

const KEY = 'ep-theme';
type Mode = 'light' | 'dark';

function current(): Mode {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

function apply(mode: Mode): void {
  const root = document.documentElement;
  if (mode === 'dark') root.setAttribute('data-theme', 'dark');
  else root.removeAttribute('data-theme');
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* storage blocked — the toggle still works for this page view */
  }
  for (const btn of document.querySelectorAll<HTMLElement>('[data-theme-toggle]')) {
    btn.setAttribute('title', mode === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    btn.setAttribute('aria-label', mode === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  }
}

for (const btn of document.querySelectorAll<HTMLElement>('[data-theme-toggle]')) {
  btn.addEventListener('click', () => apply(current() === 'dark' ? 'light' : 'dark'));
}

// Reflect the restored state in the button labels on first paint.
apply(current());
