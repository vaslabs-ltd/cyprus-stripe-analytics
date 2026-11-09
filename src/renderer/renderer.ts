import type { CountryCurrencyRevenue, CountryTotal, ReportView, RevenueReport, StripeAnalyticsApi } from '../shared/types';

declare global {
  interface Window {
    stripeAnalytics: StripeAnalyticsApi;
  }
}

const api = window.stripeAnalytics;
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const form = $<HTMLFormElement>('#query');
const fromInput = $<HTMLInputElement>('#from');
const toInput = $<HTMLInputElement>('#to');
const currencySelect = $<HTMLSelectElement>('#currency');
const loadBtn = $<HTMLButtonElement>('#load');
const exportBtn = $<HTMLButtonElement>('#export');
const statusEl = $<HTMLSpanElement>('#status');
const totalsEl = $<HTMLElement>('#totals');
const table = $<HTMLTableElement>('#table');
const tbody = table.querySelector('tbody')!;
const baseTh = table.querySelector<HTMLTableCellElement>('th[data-sort="base"]')!;
const metaEl = $<HTMLElement>('#meta');
const eurViewBtn = $<HTMLButtonElement>('#eur-view');
const eurTable = $<HTMLTableElement>('#eur-table');
const eurTbody = eurTable.querySelector('tbody')!;
const eurTfoot = eurTable.querySelector('tfoot')!;

type SortKey = 'country' | 'currency' | 'amount' | 'base' | 'share' | 'invoices' | 'customers';
let report: RevenueReport | null = null;
let sortKey: SortKey = 'amount';
let sortAsc = false;
let view: ReportView = 'currency';

type EurSortKey = 'country' | 'base' | 'share' | 'invoices' | 'customers' | 'currencies';
let eurSortKey: EurSortKey = 'base';
let eurSortAsc = false;

const countryNames = new Intl.DisplayNames(undefined, { type: 'region' });
function countryName(code: string): string {
  if (code === '??') return 'Unknown';
  try {
    return countryNames.of(code) ?? code;
  } catch {
    return code;
  }
}

function formatMoney(amountMinor: number, currency: string, exponent: number): string {
  const amount = amountMinor / 10 ** exponent;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    }).format(amount);
  } catch {
    return `${amount.toFixed(exponent)} ${currency.toUpperCase()}`;
  }
}

function setStatus(text: string, error = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', error);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function formatBase(r: RevenueReport, amount: number): string {
  return formatMoney(Math.round(amount * 100), r.baseCurrency, 2);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const pctFmt = new Intl.NumberFormat(undefined, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });

function renderTotals(r: RevenueReport, currency: string): void {
  const cards = el('div', 'cards');
  for (const t of r.totalsByCurrency) {
    if (currency && t.currency !== currency) continue;
    const countries = r.rows.filter((row) => row.currency === t.currency).length;
    const card = el('div', 'card');
    card.append(
      el('div', 'k', `Total ${t.currency.toUpperCase()}`),
      el('div', 'v', formatMoney(t.amountMinor, t.currency, t.exponent)),
      el('div', 'share-line', `${pctFmt.format(t.share)} of revenue`),
      el('div', 'n', `≈ ${formatBase(r, t.baseAmount)} · ${plural(t.invoiceCount, 'invoice')} · ${plural(countries, 'country', 'countries')}`),
    );
    cards.append(card);
  }

  // Currency mix: share of all revenue, measured in the base currency.
  const mix = el('div', 'mix');
  const bar = el('div', 'mix-bar');
  const legend = el('div', 'mix-legend');
  r.totalsByCurrency.forEach((t, i) => {
    const seg = el('div', `seg c${i % 4}`);
    seg.style.width = `${t.share * 100}%`;
    seg.title = `${t.currency.toUpperCase()} ${pctFmt.format(t.share)}`;
    bar.append(seg);
    const item = el('span', 'item');
    item.append(el('span', `swatch c${i % 4}`), document.createTextNode(`${t.currency.toUpperCase()} ${pctFmt.format(t.share)}`));
    legend.append(item);
  });
  mix.append(
    el('div', 'k', `Currency mix · total ≈ ${formatBase(r, r.baseTotal)}`),
    bar,
    legend,
  );
  totalsEl.replaceChildren(mix, cards);
}

function shareCell(fraction: number): HTMLTableCellElement {
  const td = el('td', 'num share');
  const bar = el('div', 'bar');
  bar.style.width = `${(fraction * 100).toFixed(1)}%`;
  td.append(bar, el('span', undefined, pctFmt.format(fraction)));
  return td;
}

function countryCell(code: string): HTMLTableCellElement {
  const td = el('td', undefined, countryName(code));
  td.append(el('span', 'code', code));
  return td;
}

function markSorted(t: HTMLTableElement, key: string, asc: boolean): void {
  for (const th of t.querySelectorAll<HTMLTableCellElement>('th[data-sort]')) {
    th.classList.toggle('sorted', th.dataset.sort === key);
    th.classList.toggle('asc', th.dataset.sort === key && asc);
  }
}

/** EUR view: one row per country, every currency converted to the base currency. */
function renderEurTable(r: RevenueReport): void {
  const rows = [...r.countries];
  const cmp: Record<EurSortKey, (a: CountryTotal, b: CountryTotal) => number> = {
    country: (a, b) => countryName(a.country).localeCompare(countryName(b.country)),
    base: (a, b) => a.baseAmount - b.baseAmount,
    share: (a, b) => a.share - b.share,
    invoices: (a, b) => a.invoiceCount - b.invoiceCount,
    customers: (a, b) => a.customerCount - b.customerCount,
    currencies: (a, b) => a.currencies.join().localeCompare(b.currencies.join()),
  };
  rows.sort((a, b) => cmp[eurSortKey](a, b) * (eurSortAsc ? 1 : -1));

  eurTbody.replaceChildren(
    ...rows.map((c) => {
      const tr = el('tr');
      tr.append(
        countryCell(c.country),
        el('td', 'num', formatBase(r, c.baseAmount)),
        shareCell(c.share),
        el('td', 'num', String(c.invoiceCount)),
        el('td', 'num', String(c.customerCount)),
        el('td', undefined, c.currencies.map((x) => x.toUpperCase()).join(', ')),
      );
      return tr;
    }),
  );

  const foot = el('tr');
  foot.append(
    el('td', undefined, `Total · ${plural(r.countries.length, 'country', 'countries')}`),
    el('td', 'num', formatBase(r, r.baseTotal)),
    el('td', 'num', pctFmt.format(r.baseTotal > 0 ? 1 : 0)),
    el('td', 'num', String(r.countries.reduce((n, c) => n + c.invoiceCount, 0))),
    el('td'),
    el('td'),
  );
  eurTfoot.replaceChildren(foot);

  const baseLabel = `≈ ${r.baseCurrency.toUpperCase()}`;
  eurTable.querySelector<HTMLTableCellElement>('th[data-sort="base"]')!.textContent = baseLabel;
  markSorted(eurTable, eurSortKey, eurSortAsc);
}

function render(): void {
  if (!report) return;
  const eur = view === 'eur';
  eurViewBtn.setAttribute('aria-pressed', String(eur));
  // The currency filter only applies to the per-currency view.
  currencySelect.disabled = eur;
  table.hidden = eur;
  eurTable.hidden = !eur;
  if (eur) {
    renderEurTable(report);
    renderTotals(report, '');
  } else renderTable();
}

function renderTable(): void {
  if (!report) return;
  const currency = currencySelect.value;
  const totalByCur = new Map(report.totalsByCurrency.map((t) => [t.currency, t.amountMinor]));
  const share = (r: CountryCurrencyRevenue) => (totalByCur.get(r.currency) ? r.amountMinor / totalByCur.get(r.currency)! : 0);

  const rows = report.rows.filter((r) => !currency || r.currency === currency);
  const cmp: Record<SortKey, (a: CountryCurrencyRevenue, b: CountryCurrencyRevenue) => number> = {
    country: (a, b) => countryName(a.country).localeCompare(countryName(b.country)),
    currency: (a, b) => a.currency.localeCompare(b.currency),
    // Amounts in different currencies aren't comparable, so group by currency first.
    amount: (a, b) => a.currency.localeCompare(b.currency) * (sortAsc ? 1 : -1) || a.amountMinor - b.amountMinor,
    base: (a, b) => a.baseAmount - b.baseAmount,
    share: (a, b) => share(a) - share(b),
    invoices: (a, b) => a.invoiceCount - b.invoiceCount,
    customers: (a, b) => a.customerCount - b.customerCount,
  };
  rows.sort((a, b) => cmp[sortKey](a, b) * (sortAsc ? 1 : -1));

  tbody.replaceChildren(
    ...rows.map((r) => {
      const tr = el('tr');
      const shareTd = shareCell(share(r));
      tr.append(
        countryCell(r.country),
        el('td', undefined, r.currency.toUpperCase()),
        el('td', 'num', formatMoney(r.amountMinor, r.currency, r.exponent)),
        el('td', 'num muted', formatBase(report!, r.baseAmount)),
        shareTd,
        el('td', 'num', String(r.invoiceCount)),
        el('td', 'num', String(r.customerCount)),
      );
      return tr;
    }),
  );

  markSorted(table, sortKey, sortAsc);
  baseTh.textContent = `≈ ${report.baseCurrency.toUpperCase()}`;
  table.hidden = false;
  renderTotals(report, currency);
}

function renderMeta(r: RevenueReport): void {
  const s = r.countrySources;
  metaEl.textContent =
    `${r.invoicesScanned} paid invoices scanned at ${new Date(r.generatedAt).toLocaleString()}. ` +
    `Country from customer address: ${s.customerAddress}, invoice snapshot: ${s.invoiceSnapshot}, ` +
    `shipping: ${s.shipping}, unknown: ${s.unknown}. ` +
    `Conversion to ${r.baseCurrency.toUpperCase()}: ${r.fxSource}.`;
}

function populateCurrencies(r: RevenueReport): void {
  const prev = currencySelect.value;
  currencySelect.replaceChildren(el('option', undefined, 'All'));
  (currencySelect.firstChild as HTMLOptionElement).value = '';
  for (const t of r.totalsByCurrency) {
    const o = el('option', undefined, t.currency.toUpperCase());
    o.value = t.currency;
    currencySelect.append(o);
  }
  currencySelect.value = r.totalsByCurrency.some((t) => t.currency === prev) ? prev : '';
}

// Reports cover complete past days only (UTC), ending yesterday at the latest.
const yesterdayUtc = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
fromInput.max = yesterdayUtc;
toInput.max = yesterdayUtc;
toInput.placeholder = yesterdayUtc;

// Quarter shortcut: picks complete calendar quarters only (UTC). A quarter that hasn't
// ended yet (the current one) and anything in the future are disabled.
const quarterSelect = $<HTMLSelectElement>('#quarter');
const yearSelect = $<HTMLSelectElement>('#year');
const QUARTER_YEARS_BACK = 10;

function quarterRange(year: number, q: number): { from: string; to: string } {
  const start = new Date(Date.UTC(year, (q - 1) * 3, 1));
  const end = new Date(Date.UTC(year, q * 3, 0)); // day 0 of the next quarter = last day of this one
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

const isQuarterComplete = (year: number, q: number) => quarterRange(year, q).to <= yesterdayUtc;

function populateYears(): void {
  const current = new Date().getUTCFullYear();
  for (let y = current + 1; y > current - QUARTER_YEARS_BACK; y--) {
    const o = el('option', undefined, String(y));
    o.value = String(y);
    o.disabled = !isQuarterComplete(y, 1);
    yearSelect.append(o);
  }
  // Default to the latest year with at least one complete quarter.
  yearSelect.value = String(isQuarterComplete(current, 1) ? current : current - 1);
}

function updateQuarterOptions(): void {
  const year = Number(yearSelect.value);
  for (const o of quarterSelect.options) {
    if (o.value) o.disabled = !isQuarterComplete(year, Number(o.value));
  }
  if (quarterSelect.selectedOptions[0]?.disabled) quarterSelect.value = '';
}

function applyQuarter(): void {
  if (!quarterSelect.value) return;
  const { from, to } = quarterRange(Number(yearSelect.value), Number(quarterSelect.value));
  fromInput.value = from;
  toInput.value = to;
}

populateYears();
updateQuarterOptions();
quarterSelect.addEventListener('change', applyQuarter);
yearSelect.addEventListener('change', () => {
  updateQuarterOptions();
  applyQuarter();
});
// Editing the dates by hand means they no longer describe a quarter.
for (const input of [fromInput, toInput]) input.addEventListener('input', () => (quarterSelect.value = ''));

api.onProgress((p) => setStatus(`Fetching… ${p.invoicesScanned} invoices`));

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  loadBtn.disabled = true;
  exportBtn.disabled = true;
  eurViewBtn.disabled = true;
  setStatus('Fetching…');
  const res = await api.revenueByCountry({ from: fromInput.value || undefined, to: toInput.value || undefined });
  loadBtn.disabled = false;
  if (!res.ok) {
    setStatus(res.error, true);
    // Keep the previous report usable.
    exportBtn.disabled = eurViewBtn.disabled = !report;
    return;
  }
  report = res.value;
  populateCurrencies(report);
  render();
  renderMeta(report);
  exportBtn.disabled = false;
  eurViewBtn.disabled = false;
  setStatus(`Loaded ${report.invoicesScanned} invoices`);
});

currencySelect.addEventListener('change', renderTable);

eurViewBtn.addEventListener('click', () => {
  view = view === 'eur' ? 'currency' : 'eur';
  render();
});

eurTable.querySelector('thead')!.addEventListener('click', (e) => {
  const th = (e.target as HTMLElement).closest<HTMLTableCellElement>('th[data-sort]');
  if (!th) return;
  const key = th.dataset.sort as EurSortKey;
  if (key === eurSortKey) eurSortAsc = !eurSortAsc;
  else {
    eurSortKey = key;
    eurSortAsc = key === 'country' || key === 'currencies';
  }
  renderEurTable(report!);
});

table.querySelector('thead')!.addEventListener('click', (e) => {
  const th = (e.target as HTMLElement).closest<HTMLTableCellElement>('th[data-sort]');
  if (!th) return;
  const key = th.dataset.sort as SortKey;
  if (key === sortKey) sortAsc = !sortAsc;
  else {
    sortKey = key;
    sortAsc = key === 'country' || key === 'currency';
  }
  renderTable();
});

exportBtn.addEventListener('click', async () => {
  if (!report) return;
  const res = await api.exportCsv(report, view);
  if (!res.ok) setStatus(res.error, true);
  else if (res.value) setStatus(`Exported to ${res.value}`);
});
