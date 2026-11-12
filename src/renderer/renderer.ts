import type { ContractorBreakdown, CountryCurrencyRevenue, CountryTotal, GroupTotal, ReportGrouping, ReportView, RevenueReport, SavedRevenue, StripeAnalyticsApi } from '../shared/types';
import { $, countryCell, countryName, el, formatMoney, pctFmt, plural, setStatus as setStatusOn, yesterdayUtc } from './ui.js';
import { initKeyDialog } from './key.js';
import { initVatTab } from './vat.js';
import { initOptionsTab } from './options.js';
import { initSessionSaving, remember, restoreSession, setRestoreHandler, unlockAtStartup } from './session.js';

declare global {
  interface Window {
    stripeAnalytics: StripeAnalyticsApi;
  }
}

const api = window.stripeAnalytics;

// Tabs: each report lives in its own panel; the tab bar only toggles visibility.
const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
function selectTab(tab: HTMLButtonElement): void {
  for (const t of tabs) {
    const selected = t === tab;
    t.setAttribute('aria-selected', String(selected));
    t.tabIndex = selected ? 0 : -1;
    document.getElementById(t.getAttribute('aria-controls')!)!.hidden = !selected;
  }
  // Only the report tabs are worth coming back to.
  if (tab.id !== 'tab-options') remember({ tab: tab.id });
}
for (const t of tabs) t.addEventListener('click', () => selectTab(t));
$<HTMLElement>('[role="tablist"]').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const i = tabs.indexOf(document.activeElement as HTMLButtonElement);
  if (i < 0) return;
  const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
  selectTab(next);
  next.focus();
});

initSessionSaving(api);
const vatTab = initVatTab(api);
void initOptionsTab(api);

// ---- Revenue tab ----

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
const vatBtn = $<HTMLButtonElement>('#vat-toggle');
const eurTable = $<HTMLTableElement>('#eur-table');
const eurTbody = eurTable.querySelector('tbody')!;
const eurTfoot = eurTable.querySelector('tfoot')!;
const groupBySelect = $<HTMLSelectElement>('#group-by');
const breakdownSelect = $<HTMLSelectElement>('#breakdown');
const breakdownLabel = $<HTMLElement>('#breakdown-label');
const titleEl = $<HTMLElement>('#revenue-title');
const subEl = $<HTMLElement>('#revenue-sub');
const countrySub = subEl.textContent;
const groupTable = $<HTMLTableElement>('#group-table');
const groupTbody = groupTable.querySelector('tbody')!;
const groupTfoot = groupTable.querySelector('tfoot')!;
const groupCurTable = $<HTMLTableElement>('#group-cur-table');
const groupCurTbody = groupCurTable.querySelector('tbody')!;
const groupCurTfoot = groupCurTable.querySelector('tfoot')!;

type SortKey = 'country' | 'currency' | 'amount' | 'base' | 'share' | 'invoices' | 'customers';
/** The report as loaded: without VAT, with the VAT-included version inside it (`withVat`). */
let loaded: RevenueReport | null = null;
/** The report on screen: `loaded`, or its VAT-included version. */
let report: RevenueReport | null = null;
/** Include VAT in the amounts (off by default: revenue is shown without VAT). */
let vatOn = false;

/** Reports saved by older versions have no `vat` and include VAT, with no version without it. */
const onlyWithVat = (r: RevenueReport) => !r.vat && !r.withVat;

/** Sets the loaded report; returns the one to show. */
function showLoaded(r: RevenueReport): RevenueReport {
  loaded = r;
  return (report = onlyWithVat(r) ? r : vatOn ? (r.withVat ?? r) : r);
}
let sortKey: SortKey = 'amount';
let sortAsc = false;
// Two independent choices: EUR (convert and sum, or keep invoice currencies) and what to group by
// (country, service, product or client). Together they pick one of eight views.
let eurOn = false;
let grouping: ReportGrouping = 'country';
/** What each contractor is broken down by underneath (contractor view only). */
let breakdown: 'country' | ContractorBreakdown = 'product';
const currentView = (): ReportView =>
  grouping === 'country' ? (eurOn ? 'eur' : 'currency') : eurOn ? `${grouping}-eur` : grouping;

/** How each breakdown other than country is labelled. */
interface GroupKind {
  groups: (r: RevenueReport) => GroupTotal[];
  /** Singular and plural, e.g. "tax code" / "tax codes". */
  one: string;
  many: string;
  /** First column header. */
  label: string;
  /** Countries under a group only when there's more than one row to show (a client is usually in one country). */
  collapseSingle: boolean;
  /** Show the "% of <group>" column (meaningless for a client, who is usually one row). */
  groupShare: boolean;
  /** Show the key next to the name when it's a Stripe ID with this prefix. */
  idPrefix: string;
}
const GROUPS: Record<Exclude<ReportGrouping, 'country'>, GroupKind> = {
  service: { groupShare: true, groups: (r) => r.services, one: 'tax code', many: 'tax codes', label: 'Tax code · country', collapseSingle: false, idPrefix: 'txcd_' },
  product: { groupShare: true, groups: (r) => r.products, one: 'product', many: 'products', label: 'Product · country', collapseSingle: false, idPrefix: 'prod_' },
  client: { groupShare: false, groups: (r) => r.clients, one: 'client', many: 'clients', label: 'Client · country', collapseSingle: true, idPrefix: '' },
  contractor: { groupShare: true, groups: (r) => r.contractors, one: 'contractor', many: 'contractors', label: 'Contractor · country', collapseSingle: false, idPrefix: '' },
};

type EurSortKey = 'country' | 'base' | 'share' | 'invoices' | 'customers' | 'currencies';
let eurSortKey: EurSortKey = 'base';
let eurSortAsc = false;

const setStatus = (text: string, error = false) => setStatusOn(statusEl, text, error);

function formatBase(r: RevenueReport, amount: number): string {
  return formatMoney(Math.round(amount * 100), r.baseCurrency, 2);
}

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

/** A contractor's breakdown by product or client, when one is picked (and the report has it). */
function subGroups(g: GroupTotal, kind: GroupKind): GroupTotal[] | null {
  if (kind !== GROUPS.contractor || breakdown === 'country') return null;
  return g.sub?.[breakdown] ?? null;
}

/** First cell of a breakdown row: the product or client, indented like a country. */
function subNameCell(s: GroupTotal): HTMLTableCellElement {
  return el('td', undefined, s.name);
}

/** Mix: each group's share of all revenue, in the base currency. Past the top three, the rest are "Other". */
function renderGroupTotals(r: RevenueReport, kind: GroupKind): void {
  const groups = kind.groups(r);
  const top = groups.length > 4 ? groups.slice(0, 3) : groups;
  const parts = top.map((g) => ({ name: g.name, share: g.share }));
  if (top.length < groups.length) {
    const rest = groups.slice(top.length);
    parts.push({ name: `${plural(rest.length, `other ${kind.one}`, `other ${kind.many}`)}`, share: rest.reduce((n, g) => n + g.share, 0) });
  }
  const mix = el('div', 'mix');
  const bar = el('div', 'mix-bar');
  const legend = el('div', 'mix-legend');
  parts.forEach((p, i) => {
    const seg = el('div', `seg c${i % 4}`);
    seg.style.width = `${p.share * 100}%`;
    seg.title = `${p.name} ${pctFmt.format(p.share)}`;
    bar.append(seg);
    const item = el('span', 'item');
    item.append(el('span', `swatch c${i % 4}`), document.createTextNode(`${p.name} ${pctFmt.format(p.share)}`));
    legend.append(item);
  });
  mix.append(el('div', 'k', `Mix by ${kind.one} · ${plural(groups.length, kind.one, kind.many)} · total ≈ ${formatBase(r, r.baseTotal)}`), bar, legend);
  totalsEl.replaceChildren(mix);
}

function shareCell(fraction: number): HTMLTableCellElement {
  const td = el('td', 'num share');
  const bar = el('div', 'bar');
  bar.style.width = `${(fraction * 100).toFixed(1)}%`;
  td.append(bar, el('span', undefined, pctFmt.format(fraction)));
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

function groupNameCell(g: GroupTotal, kind: GroupKind, collapsed: string | null): HTMLTableCellElement {
  const name = el('td', undefined, g.name);
  if (kind.idPrefix && g.key.startsWith(kind.idPrefix) && g.name !== g.key) name.append(el('span', 'tag', g.key));
  // A collapsed group has no country rows: say the country here.
  const items = collapsed ? [countryName(collapsed), ...g.items] : g.items;
  if (items.length) name.append(el('div', 'items', items.join(' · ')));
  return name;
}

/** The one country of a group shown without country rows, or null when its rows are shown. */
function collapsedCountry(g: GroupTotal, kind: GroupKind, rows: number): string | null {
  return kind.collapseSingle && rows === 1 && g.countries.length === 1 ? g.countries[0].country : null;
}

/** One line per currency in a cell, e.g. "€1,200.00" and "£6.67" stacked. */
function moneyLinesCell(amounts: Array<{ amountMinor: number; currency: string; exponent: number }>): HTMLTableCellElement {
  const td = el('td', 'num');
  td.append(...amounts.map((a) => el('div', undefined, formatMoney(a.amountMinor, a.currency, a.exponent))));
  return td;
}

function labelGroupTable(t: HTMLTableElement, r: RevenueReport, kind: GroupKind, baseCol: number): void {
  t.querySelector<HTMLTableCellElement>('th.group-label')!.textContent =
    kind === GROUPS.contractor && breakdown !== 'country' ? `Contractor · ${breakdown}` : kind.label;
  const share = t.querySelector<HTMLTableCellElement>('th.group-share')!;
  share.textContent = `% of ${kind.one}`;
  // Every row has a cell in each column, so the column hides by its index.
  for (const row of t.rows) if (row.cells[share.cellIndex]) row.cells[share.cellIndex].hidden = !kind.groupShare;
  t.querySelector<HTMLTableCellElement>(`th:nth-child(${baseCol})`)!.textContent = `≈ ${r.baseCurrency.toUpperCase()}`;
}

/**
 * A breakdown in invoice currencies: one group per tax code, product or client, with a row per
 * country and currency. Amounts in different currencies are never added up; ≈ EUR is for comparison only.
 */
function renderGroupCurrencyTable(r: RevenueReport, kind: GroupKind, currency: string): void {
  const rows: HTMLTableRowElement[] = [];
  let shown = 0;
  // Every share is measured in EUR: amounts in different currencies can only be compared once
  // converted. Shares are of all revenue and of the whole group, whatever the currency filter.
  const baseOf = (amounts: Array<{ baseAmount: number }>) => amounts.reduce((n, a) => n + a.baseAmount, 0);
  const ofTotal = (amounts: Array<{ baseAmount: number }>) => (r.baseTotal > 0 ? baseOf(amounts) / r.baseTotal : 0);
  for (const g of kind.groups(r)) {
    const totals = g.byCurrency.filter((t) => !currency || t.currency === currency);
    if (!totals.length) continue;
    shown++;
    const sub = g.rows.filter((x) => !currency || x.currency === currency);
    const collapsed = collapsedCountry(g, kind, sub.length);
    const head = el('tr', 'group');
    head.append(
      groupNameCell(g, kind, collapsed),
      el('td', undefined, totals.map((t) => t.currency.toUpperCase()).join(', ')),
      moneyLinesCell(totals),
      el('td', 'num muted', formatBase(r, totals.reduce((n, t) => n + t.baseAmount, 0))),
      shareCell(ofTotal(totals)),
      el('td', 'num', pctFmt.format(g.baseAmount > 0 ? baseOf(totals) / g.baseAmount : 0)),
      el('td', 'num', String(totals.reduce((n, t) => n + t.invoiceCount, 0))),
      el('td', 'num', currency ? String(totals[0].customerCount) : String(g.customerCount)),
    );
    rows.push(head);
    const subs = subGroups(g, kind);
    if (subs) {
      for (const s of subs) {
        for (const t of s.byCurrency) {
          if (currency && t.currency !== currency) continue;
          const tr = el('tr', 'group-country');
          tr.append(
            subNameCell(s),
            el('td', undefined, t.currency.toUpperCase()),
            el('td', 'num', formatMoney(t.amountMinor, t.currency, t.exponent)),
            el('td', 'num muted', formatBase(r, t.baseAmount)),
            el('td', 'num muted', pctFmt.format(ofTotal([t]))),
            shareCell(g.baseAmount > 0 ? t.baseAmount / g.baseAmount : 0),
            el('td', 'num', String(t.invoiceCount)),
            el('td', 'num', String(t.customerCount)),
          );
          rows.push(tr);
        }
      }
      continue;
    }
    if (collapsed) continue;
    for (const x of sub) {
      const tr = el('tr', 'group-country');
      tr.append(
        countryCell(x.country),
        el('td', undefined, x.currency.toUpperCase()),
        el('td', 'num', formatMoney(x.amountMinor, x.currency, x.exponent)),
        el('td', 'num muted', formatBase(r, x.baseAmount)),
        el('td', 'num muted', pctFmt.format(ofTotal([x]))),
        shareCell(g.baseAmount > 0 ? x.baseAmount / g.baseAmount : 0),
        el('td', 'num', String(x.invoiceCount)),
        el('td', 'num', String(x.customerCount)),
      );
      rows.push(tr);
    }
  }
  groupCurTbody.replaceChildren(...rows);

  const totals = r.totalsByCurrency.filter((t) => !currency || t.currency === currency);
  const foot = el('tr');
  foot.append(
    el('td', undefined, `Total · ${plural(shown, kind.one, kind.many)}`),
    el('td', undefined, totals.map((t) => t.currency.toUpperCase()).join(', ')),
    moneyLinesCell(totals),
    el('td', 'num muted', formatBase(r, totals.reduce((n, t) => n + t.baseAmount, 0))),
    el('td', 'num', pctFmt.format(ofTotal(totals))),
    el('td'),
    el('td', 'num', String(totals.reduce((n, t) => n + t.invoiceCount, 0))),
    el('td'),
  );
  groupCurTfoot.replaceChildren(foot);
  labelGroupTable(groupCurTable, r, kind, 4);
}

/** A breakdown in EUR: one group per tax code, product or client (largest first), with its countries underneath. */
function renderGroupTable(r: RevenueReport, kind: GroupKind): void {
  const rows: HTMLTableRowElement[] = [];
  const groups = kind.groups(r);
  for (const g of groups) {
    const collapsed = collapsedCountry(g, kind, g.countries.length);
    const head = el('tr', 'group');
    head.append(
      groupNameCell(g, kind, collapsed),
      el('td', 'num', formatBase(r, g.baseAmount)),
      shareCell(g.share),
      el('td', 'num', pctFmt.format(1)),
      el('td', 'num', String(g.invoiceCount)),
      el('td', 'num', String(g.customerCount)),
    );
    rows.push(head);
    const subs = subGroups(g, kind);
    for (const s of subs ?? []) {
      const tr = el('tr', 'group-country');
      tr.append(
        subNameCell(s),
        el('td', 'num', formatBase(r, s.baseAmount)),
        el('td', 'num muted', pctFmt.format(r.baseTotal > 0 ? s.baseAmount / r.baseTotal : 0)),
        shareCell(s.share),
        el('td', 'num', String(s.invoiceCount)),
        el('td', 'num', String(s.customerCount)),
      );
      rows.push(tr);
    }
    if (subs || collapsed) continue;
    for (const c of g.countries) {
      const tr = el('tr', 'group-country');
      tr.append(
        countryCell(c.country),
        el('td', 'num', formatBase(r, c.baseAmount)),
        el('td', 'num muted', pctFmt.format(r.baseTotal > 0 ? c.baseAmount / r.baseTotal : 0)),
        shareCell(c.share),
        el('td', 'num', String(c.invoiceCount)),
        el('td', 'num', String(c.customerCount)),
      );
      rows.push(tr);
    }
  }
  groupTbody.replaceChildren(...rows);

  const foot = el('tr');
  foot.append(
    el('td', undefined, `Total · ${plural(groups.length, kind.one, kind.many)}`),
    el('td', 'num', formatBase(r, r.baseTotal)),
    el('td', 'num', pctFmt.format(r.baseTotal > 0 ? 1 : 0)),
    el('td'),
    // An invoice split across two groups counts once in each, so count invoices, not rows.
    el('td', 'num', String(r.countries.reduce((n, c) => n + c.invoiceCount, 0))),
    el('td'),
  );
  groupTfoot.replaceChildren(foot);
  labelGroupTable(groupTable, r, kind, 2);
}

/** Remembers the Revenue tab for the last session. */
function rememberRevenue(): void {
  if (!loaded) return;
  const form = { from: fromInput.value, to: toInput.value, quarter: quarterSelect.value, year: yearSelect.value, currency: currencySelect.value, grouping, eur: eurOn, breakdown, vat: vatOn };
  remember({ revenue: { form, report: loaded } });
}

function render(): void {
  const kind = grouping === 'country' ? null : GROUPS[grouping];
  titleEl.textContent = `Revenue by ${grouping}`;
  breakdownLabel.hidden = grouping !== 'contractor';
  subEl.textContent = kind ? `Paid invoices, per ${kind.one}, split by customer country and invoice currency.` : countrySub;
  if (!report) return;
  const view = currentView();
  eurViewBtn.setAttribute('aria-pressed', String(eurOn));
  const vatShown = report.vat !== 'excluded';
  vatBtn.setAttribute('aria-pressed', String(vatShown));
  vatBtn.disabled = onlyWithVat(loaded ?? report);
  vatBtn.title = vatBtn.disabled
    ? 'This report was saved by an older version, with VAT included: load it again to see it without VAT'
    : 'Include the VAT paid on invoices in the amounts';
  subEl.textContent = `${subEl.textContent?.replace(/ (VAT included|Excluding VAT)\.$/, '')} ${vatShown ? 'VAT included.' : 'Excluding VAT.'}`;
  // The currency filter applies whenever amounts are in invoice currencies.
  currencySelect.disabled = eurOn;
  table.hidden = view !== 'currency';
  eurTable.hidden = view !== 'eur';
  groupCurTable.hidden = !kind || eurOn;
  groupTable.hidden = !kind || !eurOn;
  if (!kind) {
    if (eurOn) {
      renderEurTable(report);
      renderTotals(report, '');
    } else renderTable();
  } else if (eurOn) {
    renderGroupTable(report, kind);
    renderGroupTotals(report, kind);
  } else {
    renderGroupCurrencyTable(report, kind, currencySelect.value);
    renderTotals(report, currencySelect.value);
  }
  rememberRevenue();
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
    `Conversion to ${r.baseCurrency.toUpperCase()}: ${r.fxSource}. ` +
    (r.vat === 'excluded'
      ? `Amounts exclude VAT: each invoice's paid amount times its net share of the invoice total. `
      : `Amounts include the VAT paid. `) +
    `Services and products: each invoice is split across its line items by net amount; services by the product's tax code (else the account default). ` +
    `Clients: whole invoices per customer. Contractors: the products assigned to them in Options.` +
    (r.servicesNote ? ` ${r.servicesNote}` : '');
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

let loading = false;
api.onProgress((p) => {
  if (loading) setStatus(`Fetching… ${p.invoicesScanned} invoices`);
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  loadBtn.disabled = true;
  exportBtn.disabled = true;
  eurViewBtn.disabled = vatBtn.disabled = true;
  setStatus('Fetching…');
  loading = true;
  const res = await api.revenueByCountry({ from: fromInput.value || undefined, to: toInput.value || undefined });
  loading = false;
  loadBtn.disabled = false;
  if (!res.ok) {
    setStatus(res.error, true);
    // Keep the previous report usable.
    exportBtn.disabled = eurViewBtn.disabled = vatBtn.disabled = !report;
    return;
  }
  report = showLoaded(res.value);
  populateCurrencies(report);
  render();
  renderMeta(report);
  exportBtn.disabled = false;
  eurViewBtn.disabled = false;
  setStatus(`Loaded ${report.invoicesScanned} invoices`);
});

currencySelect.addEventListener('change', render);

vatBtn.addEventListener('click', () => {
  if (!loaded) return;
  vatOn = !vatOn;
  const shown = showLoaded(loaded);
  populateCurrencies(shown);
  render();
  renderMeta(shown);
});
eurViewBtn.addEventListener('click', () => {
  eurOn = !eurOn;
  render();
});
breakdownSelect.addEventListener('change', () => {
  breakdown = breakdownSelect.value as typeof breakdown;
  render();
});
groupBySelect.addEventListener('change', () => {
  grouping = groupBySelect.value as ReportGrouping;
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

/** Puts back the Revenue tab from the last session: the form, the view and the report. */
function restoreRevenue(saved: SavedRevenue): void {
  const f = saved.form;
  fromInput.value = f.from;
  toInput.value = f.to;
  if ([...yearSelect.options].some((o) => o.value === f.year)) yearSelect.value = f.year;
  updateQuarterOptions();
  quarterSelect.value = f.quarter;
  if (quarterSelect.value !== f.quarter) quarterSelect.value = '';
  grouping = f.grouping in GROUPS || f.grouping === 'country' ? f.grouping : 'country';
  groupBySelect.value = grouping;
  breakdown = f.breakdown === 'country' || f.breakdown === 'client' ? f.breakdown : 'product';
  breakdownSelect.value = breakdown;
  eurOn = !!f.eur;
  vatOn = !!f.vat;
  report = showLoaded(saved.report);
  populateCurrencies(report);
  currencySelect.value = report.totalsByCurrency.some((t) => t.currency === f.currency) ? f.currency : '';
  render();
  renderMeta(report);
  exportBtn.disabled = eurViewBtn.disabled = false;
  setStatus(`Restored the last session: ${report.invoicesScanned} invoices loaded ${new Date(report.generatedAt).toLocaleString()}`);
}

/** Contractors worked out again for the current assignments, on the report already loaded. */
async function regroupContractors(): Promise<void> {
  const before = loaded;
  if (!before) return;
  const res = await api.regroupContractors(before);
  // A newer load replaced the report meanwhile: keep that one.
  if (!res.ok || loaded !== before) return;
  showLoaded(res.value);
  render();
}
window.addEventListener('settings-saved', () => void regroupContractors());

setRestoreHandler((saved) => {
  try {
    if (saved.revenue) {
      restoreRevenue(saved.revenue);
      // Assignments may have changed since the session was saved.
      void regroupContractors();
    }
    if (saved.vat) vatTab.restore(saved.vat);
    const tab = tabs.find((t) => t.id === saved.tab);
    if (tab) selectTab(tab);
  } catch (e) {
    setStatus(`The last session could not be restored: ${e instanceof Error ? e.message : String(e)}`, true);
  }
});

// Startup: the PIN first (it may unlock the Stripe key), then the key dialog if there's still no key.
void (async () => {
  const saved = await unlockAtStartup();
  if (saved) restoreSession(saved);
  await initKeyDialog(api);
})();

exportBtn.addEventListener('click', async () => {
  if (!report) return;
  const res = await api.exportCsv(report, currentView(), breakdown);
  if (!res.ok) setStatus(res.error, true);
  else if (res.value) setStatus(`Exported to ${res.value}`);
});
