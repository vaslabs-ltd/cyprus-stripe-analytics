import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GroupTotal, RevenueReport, SummaryRequest } from '../shared/types';
import { companyFromAccount } from './stripe';
import { countryName, distribution, foldSlices, loadSummaryAssets, normalizeCompany, normalizeSections, presentationHtml, summaryFileNames, summaryHtml, summaryModel } from './summary';

const group = (key: string, name: string, baseAmount: number, total: number): GroupTotal => ({
  key,
  name,
  items: [],
  byCurrency: [],
  rows: [],
  baseAmount,
  share: baseAmount / total,
  invoiceCount: 1,
  customerCount: 1,
  countries: [],
});

function report(): RevenueReport {
  const total = 10_000;
  const clients = [7000, 1000, 800, 500, 300, 200, 200].map((a, i) => group(`cus_${i}`, `Client ${i}`, a, total));
  return {
    rows: [],
    totalsByCurrency: [
      { currency: 'eur', amountMinor: 900_000, exponent: 2, baseAmount: 9000, share: 0.9, invoiceCount: 9 },
      { currency: 'usd', amountMinor: 110_000, exponent: 2, baseAmount: 1000, share: 0.1, invoiceCount: 2 },
    ],
    countries: [
      { country: 'CY', baseAmount: 6000, share: 0.6, invoiceCount: 6, customerCount: 4, currencies: ['eur'] },
      { country: 'US', baseAmount: 4000, share: 0.4, invoiceCount: 5, customerCount: 3, currencies: ['eur', 'usd'] },
    ],
    services: [group('txcd_1', 'SaaS', 10_000, total)],
    products: [group('prod_a', 'Platform <b>', 6000, total), group('prod_b', 'Support', 4000, total)],
    clients,
    contractors: [group('ctr_1', 'Jane Secret', 10_000, total)],
    baseCurrency: 'eur',
    baseTotal: total,
    fxSource: 'ECB',
    invoicesScanned: 11,
    countrySources: { customerAddress: 11, invoiceSnapshot: 0, shipping: 0, unknown: 0 },
    generatedAt: '2026-10-01T09:00:00.000Z',
    query: { from: '2026-07-01', to: '2026-09-30' },
    vat: 'excluded',
  };
}

const company = { name: 'Acme Ltd', address: '1 Main St\nNicosia', country: 'Cyprus', email: 'a@acme.example', website: '', registration: 'HE 1' };
const request = (over: Partial<SummaryRequest> = {}): SummaryRequest => ({ report: report(), sections: ['totals', 'client', 'product'], company, title: 'Q3 summary', ...over });
const assets = { revealJs: 'window.Reveal={};', revealCss: '.reveal{}', chartJs: 'window.Chart=function(){};' };

test('pies keep the five largest slices and fold the rest into Other', () => {
  const d = distribution(report(), 'client');
  assert.equal(d.all.length, 7);
  assert.deepEqual(
    d.slices.map((s) => s.name),
    ['Client 0', 'Client 1', 'Client 2', 'Client 3', 'Client 4', 'Other (2)'],
  );
  const other = d.slices[5];
  assert.equal(other.amount, 400);
  assert.equal(other.count, 2);
  assert.ok(Math.abs(d.slices.reduce((a, s) => a + s.share, 0) - 1) < 1e-9);
  // Six or fewer: shown as they are.
  assert.equal(foldSlices(d.all.slice(0, 6)).length, 6);
});

test('countries are named and sorted', () => {
  assert.deepEqual(
    distribution(report(), 'country').all.map((s) => s.name),
    [countryName('CY'), countryName('US')],
  );
});

test('sections: only known ones, in report order; contractor is never accepted', () => {
  assert.deepEqual(normalizeSections(['country', 'contractor', 'totals', 'x']), ['totals', 'country']);
  assert.deepEqual(normalizeSections('client'), []);
});

test('company details: strings only, trimmed and capped', () => {
  assert.deepEqual(normalizeCompany({ name: '  Acme  ', email: 5, website: 'x'.repeat(500) }), {
    name: 'Acme',
    address: '',
    country: '',
    email: '',
    website: 'x'.repeat(200),
    registration: '',
  });
});

test('model: intro and conclusion state the facts', () => {
  const m = summaryModel(request());
  assert.equal(m.invoices, 11);
  assert.equal(m.clients, 7);
  assert.match(m.intro.join(' '), /Acme Ltd for the period 1 July 2026 to 30 September 2026/);
  assert.match(m.intro.join(' '), /excluding VAT/);
  assert.match(m.intro.join(' '), /total revenue, revenue by client and revenue by product/);
  assert.match(m.conclusion.join(' '), /The largest client, Client 0, accounted for 70\.0% of revenue, out of 7 clients\. The three largest clients together accounted for 88\.0%\./);
  assert.equal(summaryModel(request({ company: normalizeCompany(null) })).who, 'the company');
});

test('presentation: one slide per section, data escaped, contractors absent', () => {
  const html = presentationHtml(request(), assets);
  assert.equal(html.match(/<section/g)?.length, 7); // title, intro, company, totals, client, product, conclusion
  assert.match(html, /id="chart-client"/);
  assert.match(html, /id="chart-product"/);
  assert.doesNotMatch(html, /id="chart-service"/);
  assert.doesNotMatch(html, /Jane Secret/);
  assert.match(html, /Platform &lt;b&gt;/);
  assert.doesNotMatch(html, /Platform <b>/);
  assert.match(html, /Reveal\.initialize/);
});

test('summary document: same sections, without reveal.js', () => {
  const html = summaryHtml(request({ sections: ['service', 'country'] }), assets);
  assert.match(html, /Revenue by service/);
  assert.match(html, /Revenue by country/);
  assert.doesNotMatch(html, /Total revenue/);
  assert.doesNotMatch(html, /Reveal/);
  assert.match(html, /1 Main St<br>Nicosia/);
});

test('inlined code cannot close its script element', () => {
  const html = summaryHtml(request(), { chartJs: 'var s="</script><script>alert(1)";' });
  assert.doesNotMatch(html, /<\/script><script>alert/);
});

test('the bundled libraries can be read', () => {
  const a = loadSummaryAssets();
  assert.match(a.revealJs, /reveal\.js/);
  assert.match(a.chartJs, /Chart/);
  assert.ok(a.revealCss.length > 1000);
});

test('file names carry the period', () => {
  assert.deepEqual(summaryFileNames(report(), false), {
    presentation: 'executive-summary-2026-07-01-to-2026-09-30-presentation.html',
    summary: 'executive-summary-2026-07-01-to-2026-09-30-summary.html',
  });
  assert.match(summaryFileNames(report(), true).summary, /^demo-/);
});

test('company details from the Stripe account', () => {
  const c = companyFromAccount(
    {
      email: 'owner@acme.example',
      country: 'CY',
      business_profile: { name: 'Acme', url: 'https://acme.example', support_email: null },
      company: { name: 'Acme Ltd', address: { line1: '1 Main St', line2: null, postal_code: '1000', city: 'Nicosia', country: 'CY' } },
    },
    countryName,
  );
  assert.deepEqual(c, { name: 'Acme Ltd', address: '1 Main St\n1000 Nicosia', country: countryName('CY'), email: 'owner@acme.example', website: 'https://acme.example', registration: '' });
  assert.deepEqual(companyFromAccount({}, countryName), normalizeCompany(null));
});

test('both files follow the OS theme, with a toggle; print is always light', () => {
  for (const html of [presentationHtml(request(), assets), summaryHtml(request(), assets)]) {
    assert.match(html, /@media \(prefers-color-scheme: dark\) \{ :root:not\(\[data-theme="light"\]\) \{ color-scheme: dark;/);
    assert.match(html, /:root\[data-theme="dark"\] \{ color-scheme: dark;/);
    assert.match(html, /@media print \{ :root, :root\[data-theme\] \{ color-scheme: light;/);
    assert.match(html, /id="theme-toggle"/);
    // Swatches use the theme's slot colors, so they switch with the pies.
    assert.match(html, /class="swatch" style="background:var\(--s1\)"/);
  }
});
