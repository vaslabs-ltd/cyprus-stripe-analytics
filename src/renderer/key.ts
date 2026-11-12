import type { StripeAnalyticsApi } from '../shared/types';
import { $ } from './ui.js';
import { unlockAndRestore } from './session.js';

/**
 * Stripe key dialog. Opens by itself at startup when no usable key is configured, and from the
 * "Stripe key…" button to replace one. The key goes to the main process once and is never read back.
 */
export async function initKeyDialog(api: StripeAnalyticsApi): Promise<void> {
  const dialog = $<HTMLDialogElement>('#key-dialog');
  const form = $<HTMLFormElement>('#key-form');
  const input = $<HTMLInputElement>('#key-input');
  const reason = $<HTMLElement>('#key-reason');
  const error = $<HTMLElement>('#key-error');
  const fileEl = $<HTMLElement>('#key-file');
  const save = $<HTMLButtonElement>('#key-save');

  const open = async (why: string) => {
    const status = await api.keyStatus();
    fileEl.textContent = status.configFile;
    $<HTMLElement>('#key-locked').hidden = status.state !== 'locked';
    reason.textContent = why;
    error.textContent = '';
    input.value = '';
    dialog.showModal();
    input.focus();
  };

  $<HTMLButtonElement>('#key-open').addEventListener('click', () => void open(''));
  $<HTMLButtonElement>('#key-cancel').addEventListener('click', () => dialog.close());
  $<HTMLButtonElement>('#key-unlock').addEventListener('click', async () => {
    dialog.close();
    if (!(await unlockAndRestore()) && (await api.keyStatus()).state !== 'ok') await open('');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    save.disabled = true;
    error.textContent = 'Checking with Stripe…';
    error.classList.remove('error');
    const res = await api.saveKey(input.value);
    save.disabled = false;
    error.classList.add('error');
    if (!res.ok) {
      error.textContent = res.error;
      return;
    }
    input.value = '';
    dialog.close();
    // The main process reloads the window next, so the new key's mode shows from a clean page.
  });

  const status = await api.keyStatus();
  if (status.state === 'demo') showDemoMode();
  if (status.state === 'missing') await open('No Stripe key found. Enter one to load reports.');
  else if (status.state === 'locked') await open('The Stripe key is locked.');
  else if (status.state === 'invalid') await open('The configured Stripe key is not a restricted (rk_…) key. Enter a restricted key instead.');
}

/** Make demo mode impossible to miss: banner, window title and button labels. */
function showDemoMode(): void {
  $<HTMLElement>('#demo-banner').hidden = false;
  document.title = `${document.title} — DEMO`;
  for (const id of ['#load', '#vat-load']) $<HTMLButtonElement>(id).textContent = 'Load demo data';
}
