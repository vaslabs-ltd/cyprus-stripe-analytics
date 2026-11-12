import type { FetchScope, SavedVat, StripeAnalyticsApi, VatInvoice, VatReport, ViesMonth } from '../shared/types';
import { remember } from './session.js';
import { $, countryCell, el, formatEurCents, formatMoney, plural, setStatus as setStatusOn, yesterdayUtc } from './ui.js';

/**
 * VAT quarter schemes. Legacy Cyprus VAT quarters start in March: Mar–May, Jun–Aug, Sep–Nov
 * and Dec–Feb (which spans two calendar years). This company files on the legacy scheme.
 */
type Scheme = 'legacy' | 'calendar';
const FIRST_MONTH: Record<Scheme, number> = { legacy: 2, calendar: 0 }; // 0-based month a quarter can start in
const QUARTERS_BACK = 16;

interface Period {
  from: string;
  to: string;
  label: string;
  complete: boolean;
}

const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: 'UTC' });
const monthYearFmt = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
const shortMonth = (y: number, m: number) => monthFmt.format(new Date(Date.UTC(y, m, 1)));

/** Quarters of the scheme, newest first, starting with the one that contains `today`. */
function vatQuarters(scheme: Scheme, today: string, count: number): Period[] {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7)) - 1;
  const offset = (((m - FIRST_MONTH[scheme]) % 3) + 3) % 3;
  const current = y * 12 + m - offset; // months since year 0
  const out: Period[] = [];
  for (let i = 0; i < count; i++) {
    const s = current - 3 * i;
    const sy = Math.floor(s / 12);
    const sm = s % 12;
    const e = s + 2;
    const ey = Math.floor(e / 12);
    const em = e % 12;
    const from = iso(sy, sm, 1);
    const to = iso(sy, sm + 3, 0); // day 0 of the following month = last day of the quarter
    const complete = to <= yesterdayUtc;
    const range = sy === ey ? `${shortMonth(sy, sm)}–${shortMonth(ey, em)} ${sy}` : `${shortMonth(sy, sm)} ${sy} – ${shortMonth(ey, em)} ${ey}`;
    out.push({ from, to, label: complete ? range : `${range} (to date)`, complete });
  }
  // A quarter that starts today has no complete day to report yet.
  return out.filter((p) => p.from <= yesterdayUtc);
}

const STATUS_LABEL: Record<string, string> = { paid: 'Paid', open: 'Unpaid', uncollectible: 'Uncollectible', draft: 'Draft', void: 'Void' };

/** e.g. "paid, open or uncollectible invoices created 2025-03-01 to 2025-05-31" */
const excludedStatuses = (s: FetchScope) =>
  (['uncollectible', 'open', 'paid', 'void', 'draft'] as const).filter((x) => !s.statuses.includes(x)).map((x) => `${STATUS_LABEL[x].toLowerCase()} invoices`);

const describeScope = (s: FetchScope) =>
  `${s.statuses.length === 5 ? 'all' : s.statuses.join(', ').replace(/, ([^,]*)$/, ' or $1')} invoices created ${s.createdFrom} to ${s.createdTo}`;

/** Stripe taxability reasons, in words. Unlisted reasons are shown as-is. */
const TAX_REASON_LABEL: Record<string, string> = {
  standard_rated: 'Standard rate',
  reduced_rated: 'Reduced rate',
  zero_rated: '0% rate',
  product_exempt: 'Exempt product',
  product_exempt_holiday: 'Exempt product',
  portion_product_exempt: 'Partly exempt',
  proportionally_rated: 'Proportional',
  reverse_charge: 'Reverse charge',
  customer_exempt: 'Customer exempt',
  not_subject_to_tax: 'Not subject to tax',
  excluded_territory: 'Excluded territory',
  not_collecting: 'Not collecting',
  not_supported: 'Not supported',
};
const taxLabel = (i: VatInvoice) => (i.taxReasons.length ? i.taxReasons.map((r) => TAX_REASON_LABEL[r] ?? r.replace(/_/g, ' ')).join(', ') : 'No tax calculated');

const monthLabel = (month: string) => monthYearFmt.format(new Date(`${month}-01T00:00:00Z`));

export function initVatTab(api: StripeAnalyticsApi): { restore(saved: SavedVat): void } {
  const form = $<HTMLFormElement>('#vat-query');
  const schemeSelect = $<HTMLSelectElement>('#vat-scheme');
  const periodSelect = $<HTMLSelectElement>('#vat-period');
  const loadBtn = $<HTMLButtonElement>('#vat-load');
  const exportBtn = $<HTMLButtonElement>('#vat-export');
  const statusEl = $<HTMLElement>('#vat-status');
  const content = $<HTMLElement>('#vat-content');
  const metaEl = $<HTMLElement>('#vat-meta');
  const setStatus = (text: string, error = false) => setStatusOn(statusEl, text, error);

  let report: VatReport | null = null;
  let loading = false;

  function populatePeriods(): void {
    const periods = vatQuarters(schemeSelect.value as Scheme, yesterdayUtc, QUARTERS_BACK);
    periodSelect.replaceChildren(
      ...periods.map((p) => {
        const o = el('option', undefined, p.label);
        o.value = `${p.from}|${p.to}`;
        return o;
      }),
    );
    // Default to the latest quarter that has ended.
    const latest = periods.find((p) => p.complete);
    if (latest) periodSelect.value = `${latest.from}|${latest.to}`;
  }
  populatePeriods();
  schemeSelect.addEventListener('change', populatePeriods);

  // The scope arrives with the first progress event, so the count reads as "of what".
  let scope: FetchScope | null = null;
  api.onProgress((p) => {
    if (!loading) return;
    if (p.scope) scope = p.scope;
    setStatus(scope ? `Fetching ${describeScope(scope)}… ${p.invoicesScanned} so far` : `Fetching… ${p.invoicesScanned} invoices`);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const [from, to] = periodSelect.value.split('|');
    loadBtn.disabled = exportBtn.disabled = true;
    loading = true;
    scope = null;
    setStatus('Fetching…');
    const res = await api.vatReport({ from, to });
    loading = false;
    loadBtn.disabled = false;
    if (!res.ok) {
      setStatus(res.error, true);
      exportBtn.disabled = !report;
      return;
    }
    report = res.value;
    render(report);
    exportBtn.disabled = false;
    setStatus(`Loaded ${plural(report.invoices.length, 'invoice')}`);
    remember({ vat: { form: { scheme: schemeSelect.value, period: periodSelect.value }, report } });
  });

  exportBtn.addEventListener('click', async () => {
    if (!report) return;
    const res = await api.exportVatCsv(report);
    if (!res.ok) setStatus(res.error, true);
    else if (res.value) setStatus(`Exported to ${res.value}`);
  });

  function render(r: VatReport): void {
    renderSummary(r);
    $<HTMLElement>('#vat-cy').replaceChildren(invoiceTable(r.invoices.filter((i) => i.section === 'cy'), true));
    renderVies(r);
    $<HTMLElement>('#vat-intl').replaceChildren(invoiceTable(r.invoices.filter((i) => i.section === 'intl'), false));
    content.hidden = false;

    const flagged = r.invoices.filter((i) => i.warnings.length).length;
    metaEl.textContent =
      `${plural(r.invoices.length, 'invoice')} dated ${r.query.from} to ${r.query.to} ` +
      `at ${new Date(r.generatedAt).toLocaleString()}, from ${r.invoicesScanned} ${describeScope(r.scope)} (search period and statuses: Options tab). ` +
      (flagged ? `${plural(flagged, 'invoice')} flagged for review. ` : '') +
      `Country from the address on the invoice, else the customer's address. ` +
      `EUR: ${r.fxSource}. Not included: ${['credit notes and refunds', 'input VAT on purchases', ...excludedStatuses(r.scope)].join(', ')}.`;
  }

  function card(k: string, v: string, n?: string, empty = false): HTMLElement {
    const c = el('div', empty ? 'card empty' : 'card');
    c.append(el('div', 'k', k), el('div', 'v', v));
    if (n) c.append(el('div', 'n', n));
    return c;
  }

  function renderSummary(r: VatReport): void {
    const { cy, vies, intl } = r.summaries;
    const totalNet = cy.netEurCents + vies.netEurCents + intl.netEurCents;
    const unpaidCy = cy.unpaidCount ? ` · ${plural(cy.unpaidCount, 'invoice')} unpaid` : '';
    const noVatCy = cy.noVatNetEurCents ? ` · of which 0%/exempt ${formatEurCents(cy.noVatNetEurCents)}` : '';
    $<HTMLElement>('#vat-summary').replaceChildren(
      card('Output VAT owed (Cyprus)', formatEurCents(cy.vatEurCents), `Collected (paid): ${formatEurCents(cy.vatPaidEurCents)}${unpaidCy}`),
      card(
        'Cyprus sales (net)',
        formatEurCents(cy.netEurCents),
        `${formatEurCents(cy.grossEurCents)} incl. VAT${noVatCy} · ${plural(cy.invoiceCount, 'invoice')} · ${plural(cy.customerCount, 'customer')}`,
      ),
      card('VIES · reverse charge (net)', formatEurCents(vies.netEurCents), `${plural(vies.invoiceCount, 'invoice')} · ${plural(vies.customerCount, 'customer')}`),
      card('International (net)', formatEurCents(intl.netEurCents), `${plural(intl.invoiceCount, 'invoice')} · ${plural(intl.customerCount, 'customer')}`),
      card('All sales (net)', formatEurCents(totalNet), `${r.query.from} to ${r.query.to}`),
    );
  }

  function renderVies(r: VatReport): void {
    $<HTMLElement>('#vat-vies-months').replaceChildren(
      ...r.viesMonths.map((m) =>
        card(monthLabel(m.month), formatEurCents(m.netEurCents), m.invoiceCount ? `${plural(m.invoiceCount, 'invoice')} · ${plural(m.lines.length, 'customer')}` : 'Nothing to report', m.invoiceCount === 0),
      ),
    );
    const invoices = r.invoices.filter((i) => i.section === 'vies');
    $<HTMLElement>('#vat-vies').replaceChildren(
      ...r.viesMonths.filter((m) => m.invoiceCount > 0).map((m) => viesMonthBlock(m, invoices.filter((i) => i.month === m.month))),
    );
    if (!invoices.length) $<HTMLElement>('#vat-vies').append(el('p', 'empty-note', 'No EU business sales in this period.'));
  }

  /** One month of VIES: the listing per customer (what goes on the VIES return), then the invoices. */
  function viesMonthBlock(m: ViesMonth, invoices: VatInvoice[]): HTMLElement {
    const block = el('div', 'vies-month');
    block.append(el('h3', undefined, `${monthLabel(m.month)} · ${formatEurCents(m.netEurCents)}`));

    const t = el('table');
    const head = el('tr');
    head.append(el('th', undefined, 'Country'), el('th', undefined, 'VAT number'), el('th', undefined, 'Customer'), el('th', 'num', 'Invoices'), el('th', 'num', 'Value (net €)'));
    t.append(el('thead'), el('tbody'), el('tfoot'));
    t.tHead!.append(head);
    for (const l of m.lines) {
      const tr = el('tr', l.vatNumber ? undefined : 'flagged');
      tr.append(
        countryCell(l.country),
        el('td', l.vatNumber ? undefined : 'warn', l.vatNumber ?? 'Missing'),
        el('td', undefined, l.customerName ?? '—'),
        el('td', 'num', String(l.invoiceCount)),
        el('td', 'num', formatEurCents(l.netEurCents)),
      );
      t.tBodies[0].append(tr);
    }
    const foot = el('tr');
    foot.append(el('td', undefined, 'Total'), el('td'), el('td'), el('td', 'num', String(m.invoiceCount)), el('td', 'num', formatEurCents(m.netEurCents)));
    t.tFoot!.append(foot);

    const details = el('details');
    details.append(el('summary', undefined, `Show ${plural(invoices.length, 'invoice')}`), invoiceTable(invoices, false));
    block.append(t, details);
    return block;
  }

  /** One row per invoice; `showVat` adds VAT and gross columns (Cyprus section). */
  function invoiceTable(invoices: VatInvoice[], showVat: boolean): HTMLElement {
    if (!invoices.length) return el('p', 'empty-note', 'No invoices in this period.');
    const t = el('table');
    t.append(el('thead'), el('tbody'), el('tfoot'));
    const head = el('tr');
    const cols = ['Date', 'Invoice', 'Customer', 'Country', 'VAT number', 'Status'];
    head.append(...cols.map((c) => el('th', undefined, c)), el('th', 'num', 'Net €'));
    if (showVat) head.append(el('th', 'num', 'VAT €'), el('th', 'num', 'Rate'), el('th', 'num', 'Gross €'));
    head.append(el('th', undefined, 'Tax'), el('th', 'num', 'Invoice total'), el('th', undefined, 'Notes'));
    t.tHead!.append(head);

    for (const i of invoices) {
      const tr = el('tr', i.warnings.length ? 'flagged' : undefined);
      tr.append(
        el('td', undefined, i.date),
        el('td', undefined, i.number ?? i.id),
        el('td', undefined, i.customerName ?? i.customerId ?? '—'),
        countryCell(i.country),
        el('td', undefined, i.vatNumber ?? '—'),
        el('td', i.status === 'paid' ? undefined : 'muted', STATUS_LABEL[i.status] ?? i.status),
        el('td', 'num', formatEurCents(i.netEurCents)),
      );
      if (showVat) {
        const rate = i.netEurCents ? `${((i.vatEurCents / i.netEurCents) * 100).toFixed(1)}%` : '—';
        tr.append(el('td', 'num', formatEurCents(i.vatEurCents)), el('td', 'num muted', rate), el('td', 'num', formatEurCents(i.grossEurCents)));
      }
      tr.append(
        el('td', 'muted', taxLabel(i)),
        el('td', 'num muted', formatMoney(i.totalMinor, i.currency, i.exponent)),
        el('td', 'warn', i.warnings.join('; ')),
      );
      t.tBodies[0].append(tr);
    }

    const sum = (f: (i: VatInvoice) => number) => invoices.reduce((n, i) => n + f(i), 0);
    const foot = el('tr');
    foot.append(el('td', undefined, `Total · ${plural(invoices.length, 'invoice')}`), ...Array.from({ length: cols.length - 1 }, () => el('td')));
    foot.append(el('td', 'num', formatEurCents(sum((i) => i.netEurCents))));
    if (showVat) foot.append(el('td', 'num', formatEurCents(sum((i) => i.vatEurCents))), el('td'), el('td', 'num', formatEurCents(sum((i) => i.grossEurCents))));
    foot.append(el('td'), el('td'), el('td'));
    t.tFoot!.append(foot);
    return t;
  }

  return {
    /** Puts back the tab from the last session. */
    restore(saved: SavedVat): void {
      if (saved.form.scheme === 'legacy' || saved.form.scheme === 'calendar') schemeSelect.value = saved.form.scheme;
      populatePeriods();
      // A quarter older than the picker goes back still shows.
      if (![...periodSelect.options].some((o) => o.value === saved.form.period)) {
        const o = el('option', undefined, saved.form.period.replace('|', ' – '));
        o.value = saved.form.period;
        periodSelect.append(o);
      }
      periodSelect.value = saved.form.period;
      report = saved.report;
      render(report);
      exportBtn.disabled = false;
      setStatus(`Restored the last session: ${plural(report.invoices.length, 'invoice')} loaded ${new Date(report.generatedAt).toLocaleString()}`);
    },
  };
}
