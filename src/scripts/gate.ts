/**
 * Password gate. POSTs to /api/pastes/:id/verify; on 200 the unlock cookie is
 * set by the server and a reload renders the paste.
 */

const form = document.getElementById('gate-form') as HTMLFormElement | null;
const input = document.getElementById('gate-password') as HTMLInputElement | null;
const button = document.getElementById('gate-submit') as HTMLButtonElement | null;
const error = document.getElementById('gate-error');
const errorText = document.getElementById('gate-error-text');

const id = form?.dataset['pasteId'] ?? '';

function fail(message: string): void {
  if (errorText) errorText.textContent = message;
  if (error) error.hidden = false;
  input?.focus();
  input?.select();
}

form?.addEventListener('submit', (event) => {
  event.preventDefault();
  if (error) error.hidden = true;

  const password = input?.value ?? '';
  if (password.length === 0) {
    fail('Enter the password first.');
    return;
  }
  if (button) button.disabled = true;

  void fetch(`/api/pastes/${encodeURIComponent(id)}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
    .then((response) => {
      if (response.ok) {
        location.reload();
        return;
      }
      if (button) button.disabled = false;
      if (response.status === 401) fail('Wrong password.');
      else if (response.status === 429) fail('Too many attempts — wait a minute, then try again.');
      else if (response.status === 404) fail('That paste no longer exists.');
      else if (response.status === 410) fail('That paste is gone.');
      else fail(`Could not check that password (HTTP ${response.status}).`);
    })
    .catch(() => {
      if (button) button.disabled = false;
      fail('Network error — the password was not checked.');
    });
});

input?.focus();
