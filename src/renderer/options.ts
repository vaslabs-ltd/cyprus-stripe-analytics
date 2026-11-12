import type { Contractor, InvoiceStatus, ProductInfo, Settings, StripeAnalyticsApi } from '../shared/types';
import { $, el, plural, setStatus as setStatusOn } from './ui.js';
import { flushSession, unlockAndRestore } from './session.js';

/** Same as DEFAULT_SETTINGS in the main process (the renderer can't import main-process code). */
const DEFAULT_VAT_FETCH: Settings['vatFetch'] = { statuses: ['paid', 'open', 'uncollectible'], lookbackDays: 0, includeCreatedAfter: false };
const DEFAULTS: Settings = { vatFetch: DEFAULT_VAT_FETCH, contractors: [], productContractors: {}, productNames: {} };

const newContractorId = () => `ctr_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

/** Options tab: every change is saved straight away. */
export async function initOptionsTab(api: StripeAnalyticsApi): Promise<void> {
  const form = $<HTMLFormElement>('#options-form');
  const lookback = $<HTMLSelectElement>('#opt-lookback');
  const after = $<HTMLInputElement>('#opt-after');
  const statusBoxes = [...document.querySelectorAll<HTMLInputElement>('#opt-statuses input[type="checkbox"]')];
  const statusEl = $<HTMLElement>('#options-status');
  const setStatus = (text: string, error = false) => setStatusOn(statusEl, text, error);

  const cForm = $<HTMLFormElement>('#contractors-form');
  const cList = $<HTMLUListElement>('#contractor-list');
  const cName = $<HTMLInputElement>('#contractor-name');
  const productTable = $<HTMLTableElement>('#product-table');
  const productBody = productTable.querySelector('tbody')!;
  const productsBtn = $<HTMLButtonElement>('#products-load');
  const cStatusEl = $<HTMLElement>('#contractors-status');
  const setCStatus = (text: string, error = false) => setStatusOn(cStatusEl, text, error);

  let current: Settings = DEFAULTS;
  /** Products loaded from Stripe; until then, only products that are already assigned are listed. */
  let products: ProductInfo[] | null = null;

  function showVat(s: Settings): void {
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

  function showContractors(s: Settings): void {
    const assigned = (c: Contractor) => Object.values(s.productContractors).filter((id) => id === c.id).length;
    cList.replaceChildren(
      ...s.contractors.map((c) => {
        const li = el('li');
        const name = el('input');
        name.type = 'text';
        name.value = c.name;
        name.maxLength = 100;
        name.dataset.contractor = c.id;
        name.setAttribute('aria-label', `Rename ${c.name}`);
        const remove = el('button', undefined, 'Remove');
        remove.type = 'button';
        remove.dataset.remove = c.id;
        li.append(name, el('span', 'count', plural(assigned(c), 'product')), remove);
        return li;
      }),
    );

    // Loaded products, plus assigned ones that aren't in the list (not loaded yet, or deleted in Stripe).
    const rows: ProductInfo[] = [...(products ?? [])];
    const known = new Set(rows.map((p) => p.id));
    for (const id of Object.keys(s.productContractors)) if (!known.has(id)) rows.push({ id, name: s.productNames[id] ?? id, active: true });
    productBody.replaceChildren(
      ...rows.map((p) => {
        const tr = el('tr');
        const name = el('td', undefined, p.name);
        if (p.name !== p.id) name.append(el('span', 'code', p.id));
        if (!p.active) name.append(el('span', 'code', 'archived'));
        const select = el('select');
        select.dataset.product = p.id;
        select.setAttribute('aria-label', `Contractor for ${p.name}`);
        const none = el('option', undefined, 'Unassigned');
        none.value = '';
        select.append(none, ...s.contractors.map((c) => Object.assign(el('option', undefined, c.name), { value: c.id })));
        select.value = s.productContractors[p.id] ?? '';
        const td = el('td');
        td.append(select);
        tr.append(name, td);
        return tr;
      }),
    );
    productTable.hidden = rows.length === 0;
  }

  function show(s: Settings): void {
    current = s;
    showVat(s);
    showContractors(s);
  }

  const readVat = (): Settings['vatFetch'] => ({
    statuses: statusBoxes.filter((b) => b.checked).map((b) => b.value as InvoiceStatus),
    lookbackDays: Number(lookback.value),
    includeCreatedAfter: after.checked,
  });

  async function save(s: Settings, report: (text: string, error?: boolean) => void): Promise<void> {
    const res = await api.saveSettings(s);
    if (!res.ok) return report(res.error, true);
    show(res.value);
    report('Saved');
    // The Revenue tab regroups its contractors straight away.
    window.dispatchEvent(new CustomEvent('settings-saved'));
  }

  const loaded = await api.getSettings();
  if (!loaded.ok) {
    show(DEFAULTS);
    setStatus(loaded.error, true);
  } else {
    show(loaded.value.settings);
    if (loaded.value.file) $<HTMLElement>('#options-file').textContent = loaded.value.file;
    else $<HTMLElement>('#options-sub').textContent = 'Demo mode: changes are kept in memory only, and used the next time a report loads.';
  }

  form.addEventListener('submit', (e) => e.preventDefault());
  form.addEventListener('change', (e) => {
    if (statusBoxes.includes(e.target as HTMLInputElement) && !statusBoxes.some((b) => b.checked)) {
      (e.target as HTMLInputElement).checked = true;
      setStatus('Keep at least one status.', true);
      return;
    }
    void save({ ...current, vatFetch: readVat() }, setStatus);
  });
  // Resets the VAT search only: contractors and assignments stay.
  $<HTMLButtonElement>('#opt-defaults').addEventListener('click', () => void save({ ...current, vatFetch: DEFAULT_VAT_FETCH }, setStatus));

  // Contractors: add, rename, remove; products: assign.
  cForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = cName.value.trim();
    if (!name) return setCStatus('Enter a name first.', true);
    if (current.contractors.some((c) => c.name.toLowerCase() === name.toLowerCase())) return setCStatus(`${name} is already a contractor.`, true);
    cName.value = '';
    void save({ ...current, contractors: [...current.contractors, { id: newContractorId(), name }] }, setCStatus);
  });
  cForm.addEventListener('change', (e) => {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLInputElement && t.dataset.contractor) {
      const name = t.value.trim();
      if (!name) {
        t.value = current.contractors.find((c) => c.id === t.dataset.contractor)?.name ?? '';
        return setCStatus('A contractor needs a name.', true);
      }
      void save({ ...current, contractors: current.contractors.map((c) => (c.id === t.dataset.contractor ? { ...c, name } : c)) }, setCStatus);
    } else if (t instanceof HTMLSelectElement && t.dataset.product) {
      const id = t.dataset.product;
      const productContractors = { ...current.productContractors };
      const productNames = { ...current.productNames };
      const name = products?.find((p) => p.id === id)?.name;
      if (t.value) {
        productContractors[id] = t.value;
        if (name) productNames[id] = name;
      } else {
        delete productContractors[id];
        delete productNames[id];
      }
      void save({ ...current, productContractors, productNames }, setCStatus);
    }
  });
  cList.addEventListener('click', (e) => {
    const id = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-remove]')?.dataset.remove;
    const c = current.contractors.find((x) => x.id === id);
    if (!c) return;
    const n = Object.values(current.productContractors).filter((x) => x === c.id).length;
    if (n && !confirm(`Remove ${c.name}? Their ${plural(n, 'product')} will be unassigned.`)) return;
    // The main process drops assignments to contractors that no longer exist.
    void save({ ...current, contractors: current.contractors.filter((x) => x.id !== c.id) }, setCStatus);
  });
  void initPin(api);

  async function loadProducts(): Promise<void> {
    productsBtn.disabled = true;
    setCStatus('Loading products…');
    const res = await api.listProducts();
    productsBtn.disabled = false;
    if (!res.ok) return setCStatus(res.error, true);
    products = res.value;
    productsBtn.textContent = 'Reload products from Stripe';
    showContractors(current);
    setCStatus(`Loaded ${plural(products.length, 'product')}`);
    // Keep the names of assigned products up to date (renamed in Stripe, or saved before names were kept).
    const productNames = { ...current.productNames };
    let changed = false;
    for (const p of products) {
      if (current.productContractors[p.id] && productNames[p.id] !== p.name) {
        productNames[p.id] = p.name;
        changed = true;
      }
    }
    if (changed) await save({ ...current, productNames }, () => {});
  }
  productsBtn.addEventListener('click', () => void loadProducts());
  // The first time Options is opened with a usable key, load the products by themselves.
  $<HTMLButtonElement>('#tab-options').addEventListener('click', async () => {
    if (products || productsBtn.disabled) return;
    const k = await api.keyStatus();
    if (k.state === 'ok' || k.state === 'demo') await loadProducts();
  });
}

/** Last session: set, change or remove the PIN, encrypt the Stripe key with it, lock now. */
async function initPin(api: StripeAnalyticsApi): Promise<void> {
  const form = $<HTMLFormElement>('#pin-form');
  const fields = $<HTMLFieldSetElement>('#pin-fields');
  const stateEl = $<HTMLElement>('#pin-state');
  const current = $<HTMLInputElement>('#pin-current');
  const pin = $<HTMLInputElement>('#pin-new');
  const repeat = $<HTMLInputElement>('#pin-repeat');
  const encrypt = $<HTMLInputElement>('#pin-encrypt-key');
  const keyNote = $<HTMLElement>('#pin-key-note');
  const saveBtn = $<HTMLButtonElement>('#pin-save');
  const unlockBtn = $<HTMLButtonElement>('#pin-unlock');
  const lockBtn = $<HTMLButtonElement>('#pin-lock');
  const removeBtn = $<HTMLButtonElement>('#pin-remove');
  const statusEl = $<HTMLElement>('#pin-status');
  const setStatus = (text: string, error = false) => setStatusOn(statusEl, text, error);

  async function refresh(): Promise<void> {
    const s = await api.sessionStatus();
    fields.disabled = !s.available;
    $<HTMLElement>('#pin-current-label').hidden = !s.pinSet;
    $<HTMLElement>('#pin-new-text').textContent = s.pinSet ? 'New PIN (leave empty to keep it)' : 'PIN (4–8 digits)';
    saveBtn.textContent = s.pinSet ? 'Save' : 'Set PIN';
    unlockBtn.hidden = !s.pinSet || s.unlocked || !s.hasSession;
    lockBtn.hidden = !s.pinSet || !s.unlocked;
    removeBtn.hidden = !s.pinSet;
    encrypt.checked = s.encryptsKey;
    // A key that can't be encrypted (e.g. from an environment variable) can still be decrypted back.
    encrypt.disabled = !!s.keyNotEncryptable && !s.encryptsKey;
    keyNote.hidden = !encrypt.disabled;
    keyNote.textContent = s.keyNotEncryptable ?? '';
    stateEl.textContent = !s.available
      ? (s.reason ?? '')
      : !s.pinSet
        ? 'No PIN set: the last session isn’t kept.'
        : [
            'PIN set: the last session is saved after every load',
            s.encryptsKey ? 'the Stripe key is encrypted with it' : null,
            s.hasSession ? (s.unlocked ? 'a session is saved' : 'a saved session is locked') : null,
          ]
            .filter(Boolean)
            .join(' · ') + '.';
  }

  const clear = () => {
    for (const i of [current, pin, repeat]) i.value = '';
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const s = await api.sessionStatus();
    if (pin.value || !s.pinSet) {
      if (!/^\d{4,8}$/.test(pin.value)) return setStatus('The PIN must be 4 to 8 digits.', true);
      if (pin.value !== repeat.value) return setStatus('The two PINs don’t match.', true);
    }
    if (s.pinSet && !current.value) return setStatus('Enter the current PIN.', true);
    saveBtn.disabled = true;
    setStatus(encrypt.checked !== s.encryptsKey ? 'Encrypting…' : 'Saving…');
    const res = await api.setPin({ currentPin: s.pinSet ? current.value : undefined, pin: pin.value || undefined, encryptStripeKey: encrypt.checked });
    saveBtn.disabled = false;
    if (!res.ok) return setStatus(res.error, true);
    clear();
    await refresh();
    // Keep what's on screen right away, now that it can be saved.
    flushSession();
    setStatus(s.pinSet ? 'Saved' : 'PIN set');
  });
  removeBtn.addEventListener('click', async () => {
    if (!current.value) return setStatus('Enter the current PIN to remove it.', true);
    if (!confirm('Remove the PIN? The saved session is deleted, and an encrypted Stripe key goes back to the .env file.')) return;
    const res = await api.removePin(current.value);
    if (!res.ok) return setStatus(res.error, true);
    clear();
    await refresh();
    setStatus('PIN removed');
  });
  unlockBtn.addEventListener('click', async () => {
    await unlockAndRestore();
    await refresh();
  });
  lockBtn.addEventListener('click', () => void api.lockNow());
  // Keep the state line current (a load saves a session) whenever the tab is opened.
  $<HTMLButtonElement>('#tab-options').addEventListener('click', () => void refresh());
  await refresh();
}
