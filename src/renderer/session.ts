import type { SavedSession, StripeAnalyticsApi } from '../shared/types';
import { $ } from './ui.js';

/**
 * The last session: what each tab showed, saved (encrypted, by the main process) after every load
 * and view change, and restored at startup once the PIN is entered.
 */
type Parts = Omit<SavedSession, 'version' | 'savedAt'>;
let api: StripeAnalyticsApi;
let parts: Parts = {};
let timer: ReturnType<typeof setTimeout> | undefined;

export function initSessionSaving(a: StripeAnalyticsApi): void {
  api = a;
}

/** Saves now. Only a session with a report in it is saved, so a tab click can't replace a real one. */
export function flushSession(): void {
  clearTimeout(timer);
  timer = undefined;
  if (!parts.revenue && !parts.vat) return;
  void api.saveSession({ version: 1, savedAt: new Date().toISOString(), ...parts });
}

/** Records part of the session and saves it shortly after (changes in quick succession are saved once). */
export function remember(update: Parts): void {
  parts = { ...parts, ...update };
  clearTimeout(timer);
  timer = setTimeout(flushSession, 400);
}

/** Starts from a restored session, so loading one tab keeps the other tab's part. */
export function seedSession(saved: SavedSession): void {
  const { version: _v, savedAt: _s, ...rest } = saved;
  parts = rest;
}

/**
 * At startup: asks for the PIN when there's a saved session or an encrypted Stripe key, and returns
 * the session to restore (or the one still unlocked from before a window reload).
 */
export async function unlockAtStartup(): Promise<SavedSession | null> {
  const status = await api.sessionStatus();
  if (status.unlocked) return api.restoreSession();
  if (!status.pinSet || (!status.hasSession && !status.encryptsKey)) return null;
  return askForPin();
}

/** The PIN prompt. Resolves with the session once unlocked, or null when skipped or reset. */
export async function askForPin(): Promise<SavedSession | null> {
  const status = await api.sessionStatus();
  const dialog = $<HTMLDialogElement>('#unlock-dialog');
  const form = $<HTMLFormElement>('#unlock-form');
  const input = $<HTMLInputElement>('#unlock-pin');
  const error = $<HTMLElement>('#unlock-error');
  const submit = $<HTMLButtonElement>('#unlock-submit');
  const skip = $<HTMLButtonElement>('#unlock-skip');
  const forgot = $<HTMLButtonElement>('#unlock-forgot');

  const what = status.hasSession && status.encryptsKey ? 'the Stripe key and the last session' : status.encryptsKey ? 'the Stripe key' : 'the last session';
  $<HTMLElement>('#unlock-reason').textContent = `Enter your PIN to unlock ${what}.`;
  error.textContent = '';
  input.value = '';

  return new Promise((resolve) => {
    const done = (session: SavedSession | null) => {
      form.removeEventListener('submit', onSubmit);
      skip.removeEventListener('click', onSkip);
      forgot.removeEventListener('click', onForgot);
      dialog.removeEventListener('cancel', onCancel);
      dialog.close();
      resolve(session);
    };
    const onSubmit = async (e: Event) => {
      e.preventDefault();
      submit.disabled = true;
      error.textContent = 'Unlocking…';
      const res = await api.unlockSession(input.value);
      submit.disabled = false;
      if (!res.ok) {
        error.textContent = res.error;
        input.select();
        return;
      }
      done(res.value);
    };
    const onSkip = () => done(null);
    const onCancel = (e: Event) => {
      e.preventDefault();
      done(null);
    };
    const onForgot = async () => {
      const lose = status.encryptsKey
        ? 'This deletes the saved session and the encrypted Stripe key: you will need to enter the key again.'
        : 'This deletes the saved session.';
      if (!confirm(`Forget the PIN? ${lose}`)) return;
      const res = await api.resetPin();
      if (!res.ok) {
        error.textContent = res.error;
        return;
      }
      done(null);
    };
    form.addEventListener('submit', onSubmit);
    skip.addEventListener('click', onSkip);
    forgot.addEventListener('click', onForgot);
    dialog.addEventListener('cancel', onCancel);
    dialog.showModal();
    input.focus();
  });
}

let restoreHandler: (s: SavedSession) => void = () => {};
/** What restoring a session does (set up by the report tabs). */
export function setRestoreHandler(fn: (s: SavedSession) => void): void {
  restoreHandler = fn;
}
export function restoreSession(s: SavedSession): void {
  seedSession(s);
  restoreHandler(s);
}

/** The PIN prompt, then the session restored (from Options or the key dialog, after skipping it at startup). */
export async function unlockAndRestore(): Promise<boolean> {
  const s = await askForPin();
  if (s) restoreSession(s);
  return (await api.sessionStatus()).unlocked;
}
