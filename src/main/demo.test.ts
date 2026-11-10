import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { demoInvoiceSource, generateDemoInvoices, isDemoKey } from './demo';
import { FxRateStore, SUPPORTED_CURRENCIES, type FetchJson } from './fx';
import { revenueByCountry, vatReport, type InvoiceLike } from './stripe';

const unix = (iso: string) => Date.parse(iso) / 1000;

test('demo key: exact rk_demo only, never a real key', () => {
  assert.equal(isDemoKey('rk_demo'), true);
  assert.equal(isDemoKey(' rk_demo '), true);
  assert.equal(isDemoKey('rk_demo_x'), false);
  assert.equal(isDemoKey('rk_live_demo'), false);
  assert.equal(isDemoKey(undefined), false);
});

test('demo invoices are deterministic: a past month looks the same whenever it is generated', () => {
  const inMarch = (invs: InvoiceLike[]) =>
    invs
      .filter((i) => i.created >= unix('2025-03-01T00:00:00Z') && i.created < unix('2025-04-01T00:00:00Z'))
      .map((i) => [i.id, i.total, i.currency]);
  const early = inMarch(generateDemoInvoices(unix('2025-08-01T00:00:00Z')));
  const later = inMarch(generateDemoInvoices(unix('2026-11-01T00:00:00Z')));
  assert.ok(early.length > 5);
  assert.deepEqual(later, early);
});

test('demo invoices: supported currencies, nothing in the future, newest first, made-up identities', () => {
  const now = unix('2026-11-01T00:00:00Z');
  const invs = generateDemoInvoices(now);
  assert.ok(invs.length > 200, `only ${invs.length} invoices`);
  for (const i of invs) {
    assert.ok((SUPPORTED_CURRENCIES as readonly string[]).includes(i.currency));
    assert.ok(i.created <= now);
    if (i.status === 'paid') assert.ok(i.status_transitions.paid_at! <= now);
    const c = i.customer as { email: string };
    assert.match(c.email, /\.example$/);
    for (const t of i.customer_tax_ids ?? []) assert.match(t.value!, /DEMO/);
  }
  for (let k = 1; k < invs.length; k++) assert.ok(invs[k - 1].created >= invs[k].created);
  const statuses = new Set(invs.map((i) => i.status));
  for (const s of ['paid', 'void', 'uncollectible']) assert.ok(statuses.has(s), `no ${s} invoice`);
});

test('demo source filters like the Stripe list endpoint', async () => {
  const src = demoInvoiceSource(() => unix('2026-11-01T00:00:00Z'));
  const gte = unix('2025-06-01T00:00:00Z');
  const lte = unix('2025-06-30T23:59:59Z');
  const got: InvoiceLike[] = [];
  for await (const i of src({ status: 'paid', created: { gte, lte } })) got.push(i);
  assert.ok(got.length > 0);
  for (const i of got) {
    assert.equal(i.status, 'paid');
    assert.ok(i.created >= gte && i.created <= lte);
  }
});

/** Constant rates for every day asked for. */
const fakeFx: FetchJson = async (url) => {
  const [, from, to] = /\/(\d{4}-\d\d-\d\d)\.\.(\d{4}-\d\d-\d\d)\?/.exec(url)!;
  const rates: Record<string, Record<string, number>> = {};
  for (let d = Date.parse(`${from}T00:00:00Z`); d <= Date.parse(`${to}T00:00:00Z`); d += 86_400_000) {
    rates[new Date(d).toISOString().slice(0, 10)] = { USD: 1.1, GBP: 0.85 };
  }
  return { base: 'EUR', rates };
};
const fxStore = () => new FxRateStore(path.join(mkdtempSync(path.join(tmpdir(), 'demo-fx-')), 'fx.csv'), fakeFx);

test('demo data fills both reports, including rows the VAT tab flags', async () => {
  const src = demoInvoiceSource();
  const progress = () => {};

  const rev = await revenueByCountry(src, fxStore(), { from: '2025-07-01', to: '2025-09-30' }, progress);
  assert.ok(rev.rows.length >= 5, `${rev.rows.length} country/currency rows`);
  assert.deepEqual([...new Set(rev.rows.map((r) => r.currency))].sort(), ['eur', 'gbp', 'usd']);

  const vat = await vatReport(src, fxStore(), { from: '2025-06-01', to: '2025-08-31' }, progress);
  const sections = new Set(vat.invoices.map((i) => i.section));
  assert.deepEqual([...sections].sort(), ['cy', 'intl', 'vies']);
  assert.ok(vat.viesMonths.length === 3);
  assert.ok(vat.invoices.some((i) => i.warnings.length > 0), 'no flagged invoices');
});
