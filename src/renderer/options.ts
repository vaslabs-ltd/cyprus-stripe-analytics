import type { InvoiceStatus, Settings, StripeAnalyticsApi } from '../shared/types';
import { $, el, setStatus as setStatusOn } from './ui.js';

/** Same as DEFAULT_SETTINGS in the main process (the renderer can't import main-process code). */
const DEFAULTS: Settings = { vatFetch: { statuses: ['paid', 'open', 'uncollectible'], lookbackDays: 0, includeCreatedAfter: false } };

/** Options tab: every change is saved straight away. */
export async function initOptionsTab(api: StripeAnalyticsApi): Promise<void> {
  const form = $<HTMLFormElement>('#options-form');
  const lookback = $<HTMLSelectElement>('#opt-lookback');
  const after = $<HTMLInputElement>('#opt-after');
  const statusBoxes = [...document.querySelectorAll<HTMLInputElement>('#opt-statuses input[type="checkbox"]')];
  const statusEl = $<HTMLElement>('#options-status');
  const setStatus = (text: string, error = false) => setStatusOn(statusEl, text, error);

  function show(s: Settings): void {
    const days = String(s.vatFetch.lookbackDays);
    // A value set by hand in settings.json that isn't one of the choices still shows up.
    if (![...lookback.options].some((o) => o.value === days)) {
      const o = el('option', undefined, `${days} days before`);
      o.value = days;
      lookback.append(o);
    }
    lookback.value = days;
    after.checked = s.vatFetch.includeCreatedAfter;
    for (const b of statusBoxes) b.checked = s.vatFetch.statuses.includes(b.value as InvoiceStatus);
  }

  const read = (): Settings => ({
    vatFetch: {
      statuses: statusBoxes.filter((b) => b.checked).map((b) => b.value as InvoiceStatus),
      lookbackDays: Number(lookback.value),
      includeCreatedAfter: after.checked,
    },
  });

  async function save(s: Settings): Promise<void> {
    const res = await api.saveSettings(s);
    if (!res.ok) return setStatus(res.error, true);
    show(res.value);
    setStatus('Saved');
  }

  const loaded = await api.getSettings();
  if (!loaded.ok) {
    show(DEFAULTS);
    setStatus(loaded.error, true);
  } else {
    show(loaded.value.settings);
    $<HTMLElement>('#options-file').textContent = loaded.value.file;
  }

  form.addEventListener('submit', (e) => e.preventDefault());
  form.addEventListener('change', (e) => {
    if (statusBoxes.includes(e.target as HTMLInputElement) && !statusBoxes.some((b) => b.checked)) {
      (e.target as HTMLInputElement).checked = true;
      setStatus('Keep at least one status.', true);
      return;
    }
    void save(read());
  });
  $<HTMLButtonElement>('#opt-defaults').addEventListener('click', () => void save(DEFAULTS));
}
