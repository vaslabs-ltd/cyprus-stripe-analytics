import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revenueByCountry, vatFetchScope, vatReport, type InvoiceLike, type InvoiceListParams, type LineItemLike, type ServiceSource } from './stripe';
import type { FxRateStore } from './fx';
import type { Progress } from '../shared/types';

const fx = { ensure: async () => {}, rate: () => 1 } as unknown as FxRateStore;
const day = (iso: string) => Date.parse(`${iso}T12:00:00Z`) / 1000;

const inv = (id: string, status: string, date: string): InvoiceLike => ({
  id,
  number: id,
  status,
  created: day(date),
  effective_at: status === 'draft' ? null : day(date),
  status_transitions: { paid_at: null, finalized_at: null },
  currency: 'eur',
  amount_paid: 0,
  total: 1000,
  total_taxes: [],
  customer: 'cus_1',
  customer_name: 'Acme',
  customer_email: null,
  customer_address: { country: 'GB' },
});

/** Records each list call; returns the given invoices that match its status (like Stripe). */
function source(all: InvoiceLike[]) {
  const calls: InvoiceListParams[] = [];
  const list = (params: InvoiceListParams) => {
    calls.push(params);
    return (async function* () {
      for (const i of all) if (!params.status || i.status === params.status) yield i;
    })();
  };
  return { list, calls };
}

const unix = (iso: string, end = false) => Date.parse(`${iso}T${end ? '23:59:59' : '00:00:00'}Z`) / 1000;

test('fetch scope: created within the period by default; lookback and back-dated invoices on request', () => {
  const period = { from: '2025-03-01', to: '2025-05-31' };
  const base = { statuses: ['void', 'paid'] as const, lookbackDays: 0, includeCreatedAfter: false };
  assert.deepEqual(vatFetchScope(period, { ...base, statuses: [...base.statuses] }, '2026-11-09'), {
    createdFrom: '2025-03-01',
    createdTo: '2025-05-31',
    statuses: ['paid', 'void'],
  });
  const wide = vatFetchScope(period, { statuses: ['paid'], lookbackDays: 31, includeCreatedAfter: true }, '2026-11-09');
  assert.equal(wide.createdFrom, '2025-01-29');
  assert.equal(wide.createdTo, '2026-11-09');
});

test('VAT report: one Stripe query per chosen status, filtered by created in the query', async () => {
  const { list, calls } = source([inv('p', 'paid', '2025-04-10'), inv('o', 'open', '2025-04-11'), inv('v', 'void', '2025-04-12'), inv('d', 'draft', '2025-04-13')]);
  const progress: Progress[] = [];
  const r = await vatReport(list, fx, { from: '2025-03-01', to: '2025-05-31' }, (p) => progress.push(p));

  const created = { gte: unix('2025-03-01'), lte: unix('2025-05-31', true) };
  assert.deepEqual(calls, [
    { status: 'paid', created },
    { status: 'open', created },
    { status: 'uncollectible', created },
  ]);
  assert.deepEqual(r.invoices.map((i) => i.id), ['p', 'o']);
  assert.equal(r.invoicesScanned, 2);
  assert.deepEqual(progress[0].scope, { createdFrom: '2025-03-01', createdTo: '2025-05-31', statuses: ['paid', 'open', 'uncollectible'] });
});

test('VAT report: draft and void included and flagged when chosen; all statuses is one unfiltered query', async () => {
  const { list, calls } = source([inv('p', 'paid', '2025-04-10'), inv('v', 'void', '2025-04-12'), inv('d', 'draft', '2025-04-13')]);
  const all = { statuses: ['paid', 'open', 'uncollectible', 'draft', 'void'] as const, lookbackDays: 0, includeCreatedAfter: false };
  const r = await vatReport(list, fx, { from: '2025-03-01', to: '2025-05-31' }, () => {}, { ...all, statuses: [...all.statuses] });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].status, undefined);
  assert.deepEqual(r.invoices.map((i) => i.id), ['p', 'v', 'd']);
  assert.match(r.invoices[1].warnings[0], /^Void/);
  assert.match(r.invoices[2].warnings[0], /^Draft/);
  assert.deepEqual(r.invoices[0].warnings, []);
});

test('VAT report: refuses an empty status list', async () => {
  const { list } = source([]);
  await assert.rejects(
    vatReport(list, fx, { from: '2025-03-01', to: '2025-05-31' }, () => {}, { statuses: [], lookbackDays: 0, includeCreatedAfter: false }),
    /No invoice statuses/,
  );
});

test('revenue by service: pages line items when Stripe cut them short; names from products', async () => {
  const line = (product: string | null, amount: number, discount = 0): LineItemLike => ({
    amount,
    description: product ?? 'Ad-hoc work',
    discount_amounts: discount ? [{ amount: discount }] : [],
    pricing: product ? { price_details: { product } } : null,
  });
  const paid = (id: string, lines: InvoiceLike['lines']): InvoiceLike => ({
    ...inv(id, 'paid', '2025-04-10'),
    amount_paid: 1000,
    status_transitions: { paid_at: day('2025-04-10'), finalized_at: null },
    lines,
  });
  const { list } = source([
    paid('in_short', { data: [line('prod_dev', 1000)], has_more: true }),
    paid('in_full', { data: [line('prod_dev', 1000, 250), line(null, 250)], has_more: false }),
  ]);
  const asked: string[] = [];
  const services: ServiceSource = {
    lineItems: async function* (id) {
      asked.push(id);
      yield line('prod_dev', 1000);
      yield line('prod_hosting', 1000);
    },
    products: async function* () {
      yield { id: 'prod_dev', name: 'Development' };
      yield { id: 'prod_hosting', name: 'Hosting' };
    },
  };
  const r = await revenueByCountry(list, fx, { from: '2025-04-01', to: '2025-04-30' }, () => {}, services);
  assert.deepEqual(asked, ['in_short']);
  assert.deepEqual(
    r.services.map((s) => [s.name, s.baseAmount]),
    [
      ['Development', 12.5], // 5 of in_short + 7.50 of in_full (750 of its 1000 net)
      ['Hosting', 5],
      ['Ad-hoc work', 2.5],
    ],
  );
  assert.equal(r.servicesNote, undefined);

  // Without access to Products: still a report, by product ID, with a note.
  const noProducts: ServiceSource = {
    ...services,
    products: async function* () {
      throw new Error('This API call cannot be made with a restricted key');
    },
  };
  const r2 = await revenueByCountry(list, fx, { from: '2025-04-01', to: '2025-04-30' }, () => {}, noProducts);
  assert.equal(r2.services[0].name, 'prod_dev');
  assert.match(r2.servicesNote!, /Read access to Products/);
});
