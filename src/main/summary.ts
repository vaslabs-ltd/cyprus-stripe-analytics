/**
 * Executive summary: an HTML presentation (reveal.js) and a written one-page summary, made from a
 * revenue report. Both are single, self-contained files: the libraries (reveal.js, Chart.js) are
 * inlined, so they open offline and load nothing from the network.
 *
 * Only distributions that aren't personal are offered (client, product, service, country):
 * contractor revenue is confidential to each contractor and is never read here.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { CompanyDetails, RevenueReport, SummaryRequest, SummarySection } from '../shared/types';

export const SUMMARY_SECTIONS: readonly SummarySection[] = ['totals', 'client', 'product', 'service', 'country'];

export const EMPTY_COMPANY: CompanyDetails = { name: '', address: '', country: '', email: '', website: '', registration: '' };

const COMPANY_LIMITS: Record<keyof CompanyDetails, number> = { name: 200, address: 500, country: 100, email: 200, website: 200, registration: 200 };

/** Turn anything (a parsed file, an IPC payload) into company details: trimmed strings, length-capped. */
export function normalizeCompany(raw: unknown): CompanyDetails {
  const out = { ...EMPTY_COMPANY };
  if (!raw || typeof raw !== 'object') return out;
  for (const k of Object.keys(COMPANY_LIMITS) as Array<keyof CompanyDetails>) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === 'string') out[k] = v.trim().slice(0, COMPANY_LIMITS[k]);
  }
  return out;
}

/** Sections in report order, unknown ones (e.g. 'contractor') dropped. */
export function normalizeSections(raw: unknown): SummarySection[] {
  const asked = Array.isArray(raw) ? raw : [];
  return SUMMARY_SECTIONS.filter((s) => asked.includes(s));
}

/** One slice of a pie: a client, product, service or country. */
export interface Slice {
  name: string;
  /** Base currency, major units. */
  amount: number;
  /** Fraction (0..1) of all revenue. */
  share: number;
  /** For "Other": how many entries it folds together. */
  count?: number;
}

export interface Distribution {
  section: Exclude<SummarySection, 'totals'>;
  title: string;
  /** What one entry is, singular and plural. */
  one: string;
  many: string;
  /** Every entry, largest first. */
  all: Slice[];
  /** At most MAX_SLICES: the largest ones, then the rest folded into "Other". */
  slices: Slice[];
}

/** A pie stays readable up to six slices: the five largest, then "Other". */
export const MAX_SLICES = 6;

export function foldSlices(all: Slice[], max = MAX_SLICES): Slice[] {
  if (all.length <= max) return all;
  const kept = all.slice(0, max - 1);
  const rest = all.slice(max - 1);
  const other = rest.reduce((a, s) => ({ ...a, amount: a.amount + s.amount, share: a.share + s.share }), { name: '', amount: 0, share: 0 });
  return [...kept, { ...other, name: `Other (${rest.length})`, count: rest.length }];
}

const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });
export function countryName(code: string): string {
  if (code === '??') return 'Unknown';
  try {
    return countryNames.of(code) ?? code;
  } catch {
    return code;
  }
}

export function distribution(report: RevenueReport, section: Exclude<SummarySection, 'totals'>): Distribution {
  const fromGroups = (gs: RevenueReport['clients']) => gs.map((g) => ({ name: g.name || g.key, amount: g.baseAmount, share: g.share }));
  const kinds = {
    client: { title: 'Revenue by client', one: 'client', many: 'clients', all: () => fromGroups(report.clients) },
    product: { title: 'Revenue by product', one: 'product', many: 'products', all: () => fromGroups(report.products) },
    service: { title: 'Revenue by service', one: 'service', many: 'services', all: () => fromGroups(report.services) },
    country: {
      title: 'Revenue by country',
      one: 'country',
      many: 'countries',
      all: () => report.countries.map((c) => ({ name: countryName(c.country), amount: c.baseAmount, share: c.share })),
    },
  };
  const k = kinds[section];
  const all = k.all().filter((s) => s.amount > 0).sort((a, b) => b.amount - a.amount);
  return { section, title: k.title, one: k.one, many: k.many, all, slices: foldSlices(all) };
}

/**
 * Categorical palette, fixed order, one step per theme (both validated: lightness band, CVD and
 * contrast against their surface). "Other" is always the neutral gray. Slices refer to the CSS
 * variables (--s1…--s6, --s-other), so the legend swatches and the pies switch theme together.
 */
export const SLICE_COLORS = { light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300'], dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c'] };
export const OTHER_COLOR = { light: '#9b9a97', dark: '#7a7975' };
const sliceSlots = (slices: Slice[]) => slices.map((s, i) => (s.count !== undefined ? 's-other' : `s${(i % SLICE_COLORS.light.length) + 1}`));

// ---- Formatting ----

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** JSON that can sit inside a <script> element. */
const LINE_SEPARATORS = new RegExp(`[${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`, 'g');
const scriptJson = (v: unknown) =>
  JSON.stringify(v)
    .replace(/</g, '\\u003c')
    .replace(LINE_SEPARATORS, (c) => `\\u${c.charCodeAt(0).toString(16)}`);

/** Library code inlined in a <script> or <style> element must not close it early. */
const inlineSafe = (code: string, tag: 'script' | 'style') => code.replace(new RegExp(`</${tag}`, 'gi'), `<\\/${tag}`);

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currency.toUpperCase() }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency.toUpperCase()}`;
  }
}
const pct = (f: number) => new Intl.NumberFormat('en-GB', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(f);
const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;

function longDate(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** "1 July 2026 to 30 September 2026", or an open-ended period. */
export function periodText(r: RevenueReport): string {
  const { from, to } = r.query;
  if (from && to) return `${longDate(from)} to ${longDate(to)}`;
  if (from) return `${longDate(from)} to ${longDate(r.generatedAt)}`;
  if (to) return `up to ${longDate(to)}`;
  return `up to ${longDate(r.generatedAt)}`;
}

// ---- Content shared by both documents ----

export interface SummaryModel {
  title: string;
  company: CompanyDetails;
  /** The company's name, or "the company". */
  who: string;
  period: string;
  generated: string;
  vatIncluded: boolean;
  currency: string;
  total: number;
  invoices: number;
  clients: number;
  countries: number;
  byCurrency: Array<{ currency: string; amount: number; base: number; share: number; invoices: number }>;
  showTotals: boolean;
  distributions: Distribution[];
  intro: string[];
  conclusion: string[];
}

export function summaryModel(req: SummaryRequest): SummaryModel {
  const r = req.report;
  const sections = normalizeSections(req.sections);
  const company = normalizeCompany(req.company);
  const who = company.name || 'the company';
  const distributions = sections.filter((s): s is Distribution['section'] => s !== 'totals').map((s) => distribution(r, s));
  const vatIncluded = r.vat !== 'excluded';
  const currency = r.baseCurrency.toUpperCase();
  const invoices = r.totalsByCurrency.reduce((n, t) => n + t.invoiceCount, 0);
  const clients = r.clients.filter((c) => c.key !== 'none').length;
  const period = periodText(r);
  const total = money(r.baseTotal, r.baseCurrency);

  const covered = [...(sections.includes('totals') ? ['total revenue'] : []), ...distributions.map((d) => `revenue by ${d.one}`)];
  const intro = [
    `This report summarises the revenue of ${who} for the period ${period}, taken from paid invoices in Stripe.`,
    `All amounts are in ${currency}, ${vatIncluded ? 'including' : 'excluding'} VAT. Invoices in other currencies are converted at the ${fxText(r.fxSource)} of the day they were paid.`,
    covered.length ? `It covers ${listText(covered)}.` : '',
  ].filter(Boolean);

  const conclusion = [
    `For the period ${period}, ${who} recorded revenue of ${total} from ${count(invoices, 'paid invoice')}, across ${count(clients, 'client')} in ${count(r.countries.length, 'country', 'countries')}.`,
    ...distributions.map((d) => {
      const top = d.all[0];
      if (!top) return '';
      if (d.all.length === 1) return `All revenue came from one ${d.one}, ${top.name}.`;
      const top3 = d.all.slice(0, 3).reduce((a, s) => a + s.share, 0);
      const three = d.all.length > 3 ? ` The three largest ${d.many} together accounted for ${pct(top3)}.` : '';
      return `The largest ${d.one}, ${top.name}, accounted for ${pct(top.share)} of revenue, out of ${count(d.all.length, d.one, d.many)}.${three}`;
    }),
    `Figures are as of ${longDate(r.generatedAt)}.`,
  ].filter(Boolean);

  return {
    title: req.title.trim() || 'Executive summary',
    company,
    who,
    period,
    generated: longDate(r.generatedAt),
    vatIncluded,
    currency: r.baseCurrency,
    total: r.baseTotal,
    invoices,
    clients,
    countries: r.countries.length,
    byCurrency: r.totalsByCurrency.map((t) => ({ currency: t.currency, amount: t.amountMinor / 10 ** t.exponent, base: t.baseAmount, share: t.share, invoices: t.invoiceCount })),
    showTotals: sections.includes('totals'),
    distributions,
    intro,
    conclusion,
  };
}

/** The rates' source in plain words: the app's own wording names cache files, not for a report. */
const fxText = (source: string) => (/^ECB\b/.test(source) ? 'European Central Bank reference rate' : `exchange rate (${source})`);

function listText(items: string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// ---- HTML pieces ----

function companyRows(c: CompanyDetails): string {
  const rows: Array<[string, string]> = [
    ['Company', esc(c.name)],
    ['Address', esc(c.address).replace(/\r?\n/g, '<br>')],
    ['Country', esc(c.country)],
    ['Registration', esc(c.registration)],
    ['Email', esc(c.email)],
    ['Website', esc(c.website)],
  ];
  const filled = rows.filter(([, v]) => v);
  if (!filled.length) return '<p class="muted">No company details were entered.</p>';
  return `<dl class="company">${filled.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
}

function kpis(m: SummaryModel): string {
  const tile = (k: string, v: string) => `<div class="kpi"><div class="kpi-k">${k}</div><div class="kpi-v">${v}</div></div>`;
  return `<div class="kpis">${[
    tile(`Total revenue (${m.vatIncluded ? 'incl.' : 'excl.'} VAT)`, esc(money(m.total, m.currency))),
    tile('Paid invoices', m.invoices.toLocaleString('en-GB')),
    tile('Clients', m.clients.toLocaleString('en-GB')),
    tile('Countries', m.countries.toLocaleString('en-GB')),
  ].join('')}</div>`;
}

function currencyTable(m: SummaryModel): string {
  if (m.byCurrency.length < 2) return '';
  const base = m.currency.toUpperCase();
  const rows = m.byCurrency
    .map((c) => `<tr><td>${esc(c.currency.toUpperCase())}</td><td class="num">${esc(money(c.amount, c.currency))}</td><td class="num">${esc(money(c.base, m.currency))}</td><td class="num">${pct(c.share)}</td></tr>`)
    .join('');
  return `<table class="data"><thead><tr><th>Invoice currency</th><th class="num">Amount</th><th class="num">In ${base}</th><th class="num">Share</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** The pie's legend and table in one: a swatch, the name, the amount and the share. */
function sliceTable(d: Distribution, m: SummaryModel): string {
  const slots = sliceSlots(d.slices);
  const rows = d.slices
    .map((s, i) => `<tr><td><span class="swatch" style="background:var(--${slots[i]})"></span>${esc(s.name)}</td><td class="num">${esc(money(s.amount, m.currency))}</td><td class="num">${pct(s.share)}</td></tr>`)
    .join('');
  return `<table class="data legend"><thead><tr><th>${esc(cap(d.one))}</th><th class="num">Revenue</th><th class="num">Share</th></tr></thead><tbody>${rows}</tbody></table>`;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function distributionIntro(d: Distribution): string {
  const shown = d.all.length > d.slices.length ? ` The ${d.slices.length - 1} largest are shown; the other ${d.all.length - d.slices.length + 1} are grouped as Other.` : '';
  return `Revenue was spread across ${count(d.all.length, d.one, d.many)}.${shown}`;
}

/** Chart data for the page script, keyed by canvas id. */
function chartData(m: SummaryModel, currency: string) {
  return Object.fromEntries(
    m.distributions.map((d) => [
      `chart-${d.section}`,
      { labels: d.slices.map((s) => s.name), values: d.slices.map((s) => Math.round(s.amount * 100) / 100), shares: d.slices.map((s) => s.share), slots: sliceSlots(d.slices), currency },
    ]),
  );
}

/** Where the viewer's theme choice is remembered (localStorage, per browser). */
const THEME_KEY = 'stripe-analytics-summary-theme';

/**
 * Pies (created once per canvas, colored from the theme's CSS variables) and the theme toggle:
 * the OS setting by default, or the viewer's choice (remembered in this browser). Printing is
 * always light.
 */
const PAGE_SCRIPT = `
var CHART_LIST = [];
function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
function slotColors(d) { return d.slots.map(function (s) { return cssVar('--' + s); }); }
function makeChart(canvas, d, animate) {
  if (!canvas || canvas.dataset.done) return;
  canvas.dataset.done = '1';
  var fmt = new Intl.NumberFormat('en-GB', { style: 'currency', currency: d.currency.toUpperCase() });
  var pct = new Intl.NumberFormat('en-GB', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });
  var chart = new Chart(canvas, {
    type: 'pie',
    data: { labels: d.labels, datasets: [{ data: d.values, backgroundColor: slotColors(d), borderColor: cssVar('--surface'), borderWidth: 2, hoverOffset: 6 }] },
    options: {
      animation: animate ? undefined : false,
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: function (c) { return ' ' + fmt.format(c.parsed) + ' (' + pct.format(d.shares[c.dataIndex]) + ')'; } } }
      }
    }
  });
  CHART_LIST.push({ chart: chart, d: d });
}
function recolor() {
  CHART_LIST.forEach(function (x) {
    var ds = x.chart.data.datasets[0];
    ds.backgroundColor = slotColors(x.d);
    ds.borderColor = cssVar('--surface');
    x.chart.update('none');
  });
}
var THEME_KEY = '${THEME_KEY}';
var root = document.documentElement;
var darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
function isDark() { return root.dataset.theme ? root.dataset.theme === 'dark' : darkQuery.matches; }
function labelToggle() {
  var b = document.getElementById('theme-toggle');
  if (b) b.textContent = isDark() ? 'Light theme' : 'Dark theme';
}
function setTheme(t, remember) {
  if (t) root.dataset.theme = t; else delete root.dataset.theme;
  if (remember) { try { localStorage.setItem(THEME_KEY, t); } catch (e) {} }
  labelToggle();
  recolor();
}
document.getElementById('theme-toggle').addEventListener('click', function () { setTheme(isDark() ? 'light' : 'dark', true); });
darkQuery.addEventListener('change', function () { labelToggle(); recolor(); });
var themeBeforePrint;
window.addEventListener('beforeprint', function () { themeBeforePrint = root.dataset.theme; setTheme('light', false); });
window.addEventListener('afterprint', function () { setTheme(themeBeforePrint, false); });
labelToggle();
`;

// ---- Theme ----

const slotVars = (t: 'light' | 'dark') => SLICE_COLORS[t].map((c, i) => `--s${i + 1}: ${c};`).join(' ') + ` --s-other: ${OTHER_COLOR[t]};`;
const LIGHT = `color-scheme: light; --page: #ececef; --surface: #ffffff; --ink: #1d1d22; --ink-2: #52514e; --muted: #74737a; --rule: #e4e4e8; --accent: #2a78d6; --tile: #f4f4f6; ${slotVars('light')}`;
const DARK = `color-scheme: dark; --page: #0f0f0e; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #9a9992; --rule: #34342f; --accent: #3987e5; --tile: #242422; ${slotVars('dark')}`;

/** Light by default, dark with the OS setting or the toggle (which wins both ways), light on paper. */
const BASE_CSS = `
:root { ${LIGHT} }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${DARK} } }
:root[data-theme="dark"] { ${DARK} }
@media print { :root, :root[data-theme] { ${LIGHT} } .theme-toggle { display: none !important; } }
body { background: var(--page); color: var(--ink); }
.theme-toggle { position: fixed; top: 12px; right: 12px; z-index: 40; font: 13px system-ui, -apple-system, 'Segoe UI', Cantarell, sans-serif; color: var(--ink-2); background: var(--tile); border: 1px solid var(--rule); border-radius: 6px; padding: 5px 10px; cursor: pointer; }
.theme-toggle:hover { color: var(--ink); }
.muted { color: var(--muted); }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
table.data { border-collapse: collapse; width: 100%; font-size: 0.9em; }
table.data th { text-align: left; font-weight: 600; color: var(--ink-2); border-bottom: 1px solid var(--rule); padding: 6px 10px; }
table.data th.num { text-align: right; }
table.data td { border-bottom: 1px solid var(--rule); padding: 6px 10px; vertical-align: top; }
.swatch { display: inline-block; width: 0.8em; height: 0.8em; border-radius: 3px; margin-right: 0.5em; vertical-align: -0.05em; }
.kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
.kpi { background: var(--tile); border-radius: 10px; padding: 14px 18px; }
.kpi-k { font-size: 0.75em; color: var(--muted); }
.kpi-v { font-size: 1.5em; font-weight: 650; font-variant-numeric: tabular-nums; margin-top: 4px; }
.company { display: grid; grid-template-columns: max-content 1fr; gap: 8px 24px; margin: 0; }
.company dt { color: var(--muted); }
.company dd { margin: 0; }
.dist { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); gap: 32px; align-items: center; }
.pie { position: relative; height: 340px; }
`;

const DECK_CSS = `
.reveal { font-family: system-ui, -apple-system, 'Segoe UI', Cantarell, sans-serif; font-size: 28px; color: var(--ink); background: var(--surface); }
.reveal-viewport, body { background: var(--surface); }
.reveal .slides { text-align: left; }
.reveal .slides section { height: 100%; padding: 56px 72px; box-sizing: border-box; }
.reveal h1, .reveal h2 { font-weight: 650; letter-spacing: -0.01em; color: var(--ink); margin: 0 0 28px; line-height: 1.15; }
.reveal h1 { font-size: 2.2em; }
.reveal h2 { font-size: 1.5em; }
.reveal p { margin: 0 0 18px; line-height: 1.45; color: var(--ink-2); }
.reveal .title-slide { display: flex !important; flex-direction: column; justify-content: center; }
.reveal .title-slide .kicker { color: var(--accent); font-weight: 600; font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 16px; }
.reveal .title-slide .meta { color: var(--muted); font-size: 0.8em; }
.reveal .kpis { margin-bottom: 28px; }
.reveal .pie { height: 440px; }
.reveal table.data { font-size: 0.7em; }
.reveal .note { font-size: 0.65em; color: var(--muted); }
.reveal .conclusion p { font-size: 0.72em; margin-bottom: 12px; }
.reveal .slide-number a { text-decoration: none; color: inherit; }
.reveal .footer-line { position: absolute; left: 72px; bottom: 28px; font-size: 0.5em; color: var(--muted); }
.reveal .controls { color: var(--accent); }
.reveal .progress { color: var(--accent); }
.reveal .slide-number { background: transparent; color: var(--muted); font-size: 14px; }
`;

const DOC_CSS = `
* { box-sizing: border-box; }
html { background: var(--page); }
body { margin: 0; font: 15px/1.55 system-ui, -apple-system, 'Segoe UI', Cantarell, sans-serif; color: var(--ink); }
main { max-width: 860px; margin: 32px auto; background: var(--surface); padding: 56px 64px; border-radius: 4px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); border: 1px solid var(--rule); }
header { border-bottom: 2px solid var(--accent); padding-bottom: 20px; margin-bottom: 28px; }
header .kicker { color: var(--accent); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
h1 { font-size: 28px; margin: 6px 0 4px; letter-spacing: -0.01em; }
h2 { font-size: 19px; margin: 36px 0 12px; }
p { margin: 0 0 12px; color: var(--ink-2); }
header p { margin: 0; color: var(--muted); }
.kpis { margin: 4px 0 16px; }
.pie { height: 260px; }
footer { margin-top: 40px; font-size: 12px; color: var(--muted); border-top: 1px solid var(--rule); padding-top: 12px; }
@media (max-width: 700px) {
  main { margin: 0; padding: 28px 16px; }
  .kpis { grid-template-columns: repeat(2, 1fr); }
  .dist { grid-template-columns: 1fr; }
}
@media print {
  html { background: none; }
  main { margin: 0; max-width: none; box-shadow: none; border: none; padding: 0; }
  section { break-inside: avoid; }
}
`;

// ---- Documents ----

export interface SummaryAssets {
  revealJs: string;
  revealCss: string;
  chartJs: string;
}

/** reveal.js and Chart.js from node_modules (shipped with the app as dependencies). */
export function loadSummaryAssets(): SummaryAssets {
  const revealDir = path.dirname(require.resolve('reveal.js'));
  const chartDir = path.dirname(require.resolve('chart.js'));
  return {
    revealJs: readFileSync(path.join(revealDir, 'reveal.js'), 'utf8'),
    revealCss: readFileSync(path.join(revealDir, 'reveal.css'), 'utf8'),
    chartJs: readFileSync(path.join(chartDir, 'chart.umd.min.js'), 'utf8'),
  };
}

/** Runs in <head>, before the first paint: the remembered theme (and always light for print-pdf). */
const themeHead = (forceLightOnPrintPdf: boolean) => `<script>
try { var t = localStorage.getItem('${THEME_KEY}'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch (e) {}
${forceLightOnPrintPdf ? "if (/print-pdf/.test(location.search)) document.documentElement.dataset.theme = 'light';" : ''}
</script>`;
const TOGGLE = '<button type="button" id="theme-toggle" class="theme-toggle">Dark theme</button>';

const footerText = (m: SummaryModel) => `${m.company.name ? `${esc(m.company.name)} · ` : ''}${esc(m.period)} · Confidential`;

export function presentationHtml(req: SummaryRequest, assets: SummaryAssets): string {
  const m = summaryModel(req);
  const foot = `<div class="footer-line">${footerText(m)}</div>`;
  const slides: string[] = [];
  slides.push(`<section class="title-slide">
  <div class="kicker">${esc(m.company.name || 'Executive summary')}</div>
  <h1>${esc(m.title)}</h1>
  <p class="meta">${esc(cap(m.period))}<br>Prepared ${esc(m.generated)}</p>
</section>`);
  slides.push(`<section><h2>Introduction</h2>${m.intro.map((p) => `<p>${esc(p)}</p>`).join('')}${foot}</section>`);
  slides.push(`<section><h2>Company details</h2>${companyRows(m.company)}${foot}</section>`);
  if (m.showTotals) {
    slides.push(`<section><h2>Total revenue</h2>${kpis(m)}${currencyTable(m)}<p class="note">${esc(cap(m.period))}, ${m.vatIncluded ? 'including' : 'excluding'} VAT.</p>${foot}</section>`);
  }
  for (const d of m.distributions) {
    slides.push(`<section><h2>${esc(d.title)}</h2>
  <div class="dist"><div class="pie"><canvas id="chart-${d.section}" role="img" aria-label="${esc(d.title)}, pie chart"></canvas></div>${sliceTable(d, m)}</div>
  <p class="note">${esc(distributionIntro(d))}</p>${foot}</section>`);
  }
  slides.push(`<section class="conclusion"><h2>Conclusion</h2>${m.conclusion.map((p) => `<p>${esc(p)}</p>`).join('')}${foot}</section>`);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(m.title)}${m.company.name ? ` · ${esc(m.company.name)}` : ''}</title>
<style>${inlineSafe(assets.revealCss, 'style')}</style>
<style>${BASE_CSS}${DECK_CSS}</style>
${themeHead(true)}
</head>
<body>
${TOGGLE}
<div class="reveal"><div class="slides">
${slides.join('\n')}
</div></div>
<script>${inlineSafe(assets.revealJs, 'script')}</script>
<script>${inlineSafe(assets.chartJs, 'script')}</script>
<script>
var CHARTS = ${scriptJson(chartData(m, m.currency))};
${PAGE_SCRIPT}
var printing = /print-pdf/.test(location.search);
function chartsIn(slide) {
  if (!slide) return;
  slide.querySelectorAll('canvas[id]').forEach(function (c) { makeChart(c, CHARTS[c.id], !printing); });
}
Reveal.initialize({ hash: true, width: 1280, height: 720, margin: 0.04, center: false, slideNumber: 'c/t', transition: 'slide', controls: true, progress: true });
Reveal.on('ready', function (e) {
  if (printing) Object.keys(CHARTS).forEach(function (id) { makeChart(document.getElementById(id), CHARTS[id], false); });
  else chartsIn(e.currentSlide);
});
Reveal.on('slidechanged', function (e) { chartsIn(e.currentSlide); });
</script>
</body>
</html>
`;
}

export function summaryHtml(req: SummaryRequest, assets: Pick<SummaryAssets, 'chartJs'>): string {
  const m = summaryModel(req);
  const parts: string[] = [];
  parts.push(`<section><h2>Introduction</h2>${m.intro.map((p) => `<p>${esc(p)}</p>`).join('')}</section>`);
  parts.push(`<section><h2>Company details</h2>${companyRows(m.company)}</section>`);
  if (m.showTotals) parts.push(`<section><h2>Total revenue</h2>${kpis(m)}${currencyTable(m)}</section>`);
  for (const d of m.distributions) {
    parts.push(`<section><h2>${esc(d.title)}</h2><p>${esc(distributionIntro(d))}</p>
  <div class="dist"><div class="pie"><canvas id="chart-${d.section}" role="img" aria-label="${esc(d.title)}, pie chart"></canvas></div>${sliceTable(d, m)}</div></section>`);
  }
  parts.push(`<section><h2>Conclusion</h2>${m.conclusion.map((p) => `<p>${esc(p)}</p>`).join('')}</section>`);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(m.title)}${m.company.name ? ` · ${esc(m.company.name)}` : ''}</title>
<style>${BASE_CSS}${DOC_CSS}</style>
${themeHead(false)}
</head>
<body>
${TOGGLE}
<main>
<header>
  <div class="kicker">${esc(m.company.name || 'Executive summary')}</div>
  <h1>${esc(m.title)}</h1>
  <p>${esc(cap(m.period))} · Prepared ${esc(m.generated)}</p>
</header>
${parts.join('\n')}
<footer>${footerText(m)}</footer>
</main>
<script>${inlineSafe(assets.chartJs, 'script')}</script>
<script>
var CHARTS = ${scriptJson(chartData(m, m.currency))};
${PAGE_SCRIPT}
var still = window.matchMedia('print').matches || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
Object.keys(CHARTS).forEach(function (id) { makeChart(document.getElementById(id), CHARTS[id], !still); });
</script>
</body>
</html>
`;
}

/** File names for an export, e.g. executive-summary-2026-07-01-to-2026-09-30-presentation.html. */
export function summaryFileNames(r: RevenueReport, demo: boolean): { presentation: string; summary: string } {
  const { from, to } = r.query;
  const period = from && to ? `${from}-to-${to}` : from ? `from-${from}` : to ? `to-${to}` : r.generatedAt.slice(0, 10);
  const base = `${demo ? 'demo-' : ''}executive-summary-${period}`;
  return { presentation: `${base}-presentation.html`, summary: `${base}-summary.html` };
}
