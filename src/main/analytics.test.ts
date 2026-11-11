import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_TAX_CODE,
  RevenueAggregator,
  reportToCsv,
  resolveCountry,
  serviceFractions,
  splitMinor,
  UNKNOWN_COUNTRY,
  UNSPLIT_SERVICE,
  type Classify,
  type InvoiceFact,
} from './analytics';

const fact = (f: Partial<InvoiceFact>): InvoiceFact => ({ customerId: 'c', currency: 'gbp', amountPaid: 1, paidDate: '2026-01-01', ...f });

test('country resolution prefers customer address, then invoice snapshot, then shipping', () => {
  assert.deepEqual(resolveCountry(fact({ customerCountry: 'gb', invoiceCountry: 'FR' })), { country: 'GB', source: 'customerAddress' });
  assert.equal(resolveCountry(fact({ invoiceCountry: 'FR', shippingCountry: 'DE' })).country, 'FR');
  assert.equal(resolveCountry(fact({ shippingCountry: 'DE' })).country, 'DE');
  assert.equal(resolveCountry(fact({})).country, UNKNOWN_COUNTRY);
});

test('aggregates per country and currency, with base-currency shares', () => {
  const agg = new RevenueAggregator('eur', 'test');
  agg.add(fact({ customerId: 'a', currency: 'gbp', amountPaid: 1000, customerCountry: 'GB' }), 12);
  agg.add(fact({ customerId: 'a', currency: 'gbp', amountPaid: 500, customerCountry: 'GB' }), 6);
  agg.add(fact({ customerId: 'b', currency: 'eur', amountPaid: 20000, customerCountry: 'GB' }), 200);
  agg.add(fact({ customerId: 'c', currency: 'EUR', amountPaid: 70000, customerCountry: 'CY' }), 700);
  agg.add(fact({ customerId: 'd', currency: 'usd', amountPaid: 9200, customerCountry: 'US' }), 82);

  const r = agg.report({});
  assert.equal(r.invoicesScanned, 5);
  assert.equal(r.baseCurrency, 'eur');
  assert.deepEqual(
    r.rows.map((x) => [x.country, x.currency, x.amountMinor, x.baseAmount, x.invoiceCount, x.customerCount]),
    [
      ['CY', 'eur', 70000, 700, 1, 1],
      ['GB', 'eur', 20000, 200, 1, 1],
      ['GB', 'gbp', 1500, 18, 2, 1],
      ['US', 'usd', 9200, 82, 1, 1],
    ],
  );
  assert.equal(r.baseTotal, 1000);
  assert.deepEqual(
    r.totalsByCurrency.map((t) => [t.currency, t.amountMinor, t.baseAmount, t.share]),
    [
      ['eur', 90000, 900, 0.9],
      ['gbp', 1500, 18, 0.018],
      ['usd', 9200, 82, 0.082],
    ],
  );

  // EUR view: one row per country, largest first; customer "a" paid in GBP and EUR in GB.
  agg.add(fact({ customerId: 'a', currency: 'eur', amountPaid: 1000, customerCountry: 'GB' }), 10);
  const r2 = agg.report({});
  assert.deepEqual(
    r2.countries.map((c) => [c.country, c.baseAmount, c.invoiceCount, c.customerCount, c.currencies]),
    [
      ['CY', 700, 1, 1, ['eur']],
      ['GB', 228, 4, 2, ['eur', 'gbp']],
      ['US', 82, 1, 1, ['usd']],
    ],
  );
  assert.equal(r2.countries.reduce((sum, c) => sum + c.share, 0).toFixed(10), '1.0000000000');
  assert.deepEqual(reportToCsv(r2, 'eur').trim().split('\n'), [
    'country,revenue_eur,share,invoices,customers,currencies',
    'CY,700.00,0.6931,1,1,EUR',
    'GB,228.00,0.2257,4,2,EUR GBP',
    'US,82.00,0.0812,1,1,USD',
  ]);

  const csv = reportToCsv(r).trim().split('\n');
  assert.equal(csv[0], 'country,currency,revenue,revenue_minor_units,revenue_eur,invoices,customers');
  assert.equal(csv[3], 'GB,GBP,15.00,1500,18.00,2,1');
});

// Tax code per product, as the Stripe side works it out; lines without a product get 'none'.
const codes: Record<string, string> = { prod_dev: 'txcd_it', prod_host: 'txcd_it', prod_ads: 'txcd_mkt' };
const byCode: Classify = (l) => ({ service: (l.product && codes[l.product]) || NO_TAX_CODE, item: l.description ?? '?' });

test('service fractions: by net line amount per tax code; products with the same code add up', () => {
  const f = serviceFractions(
    [
      { product: 'prod_dev', description: 'Development', amount: 600 },
      { product: 'prod_host', description: 'Hosting', amount: 200 },
      { product: 'prod_ads', description: 'Ads', amount: 100 },
      { product: null, description: 'Ad-hoc', amount: 100 },
    ],
    byCode,
  );
  assert.deepEqual(
    [...f].map(([k, v]) => [k, v.fraction, [...v.items]]),
    [
      ['txcd_it', 0.8, ['Development', 'Hosting']],
      ['txcd_mkt', 0.1, ['Ads']],
      [NO_TAX_CODE, 0.1, ['Ad-hoc']],
    ],
  );
  assert.deepEqual([...serviceFractions(undefined, byCode).keys()], [UNSPLIT_SERVICE]);
  assert.deepEqual([...serviceFractions([{ product: 'prod_dev', description: null, amount: 0 }], byCode).keys()], [UNSPLIT_SERVICE]);
  // A credit line reduces its service; the fractions still add up to 1.
  const credit = serviceFractions(
    [
      { product: 'prod_dev', description: null, amount: 1000 },
      { product: 'prod_ads', description: null, amount: -200 },
    ],
    byCode,
  );
  assert.deepEqual([...credit].map(([k, v]) => [k, v.fraction]), [['txcd_it', 1.25], ['txcd_mkt', -0.25]]);
});

test('service view: invoices split across tax codes, then by country, with CSV', () => {
  const agg = new RevenueAggregator('eur', 'test', byCode);
  const dev = { product: 'prod_dev', description: 'Development', amount: 900 };
  const ads = { product: 'prod_ads', description: 'Ads, social', amount: 100 };
  agg.add(fact({ customerId: 'a', customerCountry: 'GB', lines: [dev, ads] }), 1000);
  agg.add(fact({ customerId: 'b', customerCountry: 'CY', lines: [dev] }), 500);
  agg.add(fact({ customerId: 'c', customerCountry: 'CY', lines: [{ product: 'prod_host', description: 'Hosting', amount: 50 }] }), 50);
  const r = agg.report({}, new Map([['txcd_mkt', 'Marketing, advertising']]));

  assert.deepEqual(
    r.services.map((s) => [s.key, s.name, s.items, s.baseAmount, s.invoiceCount, s.customerCount]),
    [
      ['txcd_it', 'txcd_it', ['Development', 'Hosting'], 1450, 3, 3],
      ['txcd_mkt', 'Marketing, advertising', ['Ads, social'], 100, 1, 1],
    ],
  );
  assert.deepEqual(
    r.services[0].countries.map((c) => [c.country, c.baseAmount, c.invoiceCount]),
    [
      ['GB', 900, 1],
      ['CY', 550, 2],
    ],
  );
  assert.equal(r.services.reduce((n, s) => n + s.share, 0), 1);
  assert.deepEqual(reportToCsv(r, 'service-eur').trim().split('\n'), [
    'service,tax_code,country,revenue_eur,share_of_service,share_of_total,invoices,customers',
    'txcd_it,txcd_it,GB,900.00,0.6207,0.5806,1,1',
    'txcd_it,txcd_it,CY,550.00,0.3793,0.3548,2,2',
    '"Marketing, advertising",txcd_mkt,GB,100.00,1.0000,0.0645,1,1',
  ]);
});

test('splitMinor: whole units that always add up to the total', () => {
  assert.deepEqual(splitMinor(1000, [0.9, 0.1]), [900, 100]);
  assert.deepEqual(splitMinor(100, [1 / 3, 1 / 3, 1 / 3]), [34, 33, 33]);
  assert.deepEqual(splitMinor(999, [0.5, 0.5]), [500, 499]);
  assert.deepEqual(splitMinor(1000, [1.25, -0.25]), [1250, -250]);
  assert.deepEqual(splitMinor(1001, [1]), [1001]);
});

test('service view in invoice currencies: per tax code, country and currency, never mixed', () => {
  const agg = new RevenueAggregator('eur', 'test', byCode);
  const dev = { product: 'prod_dev', description: 'Development', amount: 2 };
  const ads = { product: 'prod_ads', description: 'Ads', amount: 1 };
  agg.add(fact({ customerId: 'a', currency: 'gbp', amountPaid: 1000, customerCountry: 'GB', lines: [dev, ads] }), 12);
  agg.add(fact({ customerId: 'b', currency: 'eur', amountPaid: 500, customerCountry: 'GB', lines: [dev] }), 5);
  agg.add(fact({ customerId: 'c', currency: 'eur', amountPaid: 700, customerCountry: 'CY', lines: [dev] }), 7);
  const r = agg.report({});
  const it = r.services.find((s) => s.key === 'txcd_it')!;
  const mkt = r.services.find((s) => s.key === 'txcd_mkt')!;
  // £10.00 split 2:1 in whole pence: 667 + 333.
  assert.deepEqual(it.byCurrency.map((c) => [c.currency, c.amountMinor, c.invoiceCount]), [['eur', 1200, 2], ['gbp', 667, 1]]);
  assert.deepEqual(mkt.byCurrency.map((c) => [c.currency, c.amountMinor]), [['gbp', 333]]);
  assert.deepEqual(
    it.rows.map((x) => [x.country, x.currency, x.amountMinor, x.baseAmount, x.invoiceCount, x.customerCount]),
    [
      ['CY', 'eur', 700, 7, 1, 1],
      ['GB', 'eur', 500, 5, 1, 1],
      ['GB', 'gbp', 667, 8, 1, 1],
    ],
  );
  assert.deepEqual(reportToCsv(r, 'service').trim().split('\n'), [
    'service,tax_code,country,currency,revenue,revenue_minor_units,revenue_eur,invoices,customers',
    'txcd_it,txcd_it,CY,EUR,7.00,700,7.00,1,1',
    'txcd_it,txcd_it,GB,EUR,5.00,500,5.00,1,1',
    'txcd_it,txcd_it,GB,GBP,6.67,667,8.00,1,1',
    'txcd_mkt,txcd_mkt,GB,GBP,3.33,333,4.00,1,1',
  ]);
});
