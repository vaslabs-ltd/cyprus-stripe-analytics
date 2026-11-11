import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RevenueAggregator, reportToCsv, resolveCountry, serviceFractions, UNKNOWN_COUNTRY, UNSPLIT_SERVICE, type InvoiceFact } from './analytics';

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

test('service fractions: by net line amount per product, falling back to the description', () => {
  const f = serviceFractions([
    { product: 'prod_a', description: 'A', amount: 600 },
    { product: 'prod_b', description: 'B', amount: 300 },
    { product: 'prod_a', description: 'A again', amount: 300 },
    { product: null, description: ' Training ', amount: 300 },
  ]);
  assert.deepEqual([...f], [['prod_a', 0.6], ['prod_b', 0.2], ['desc:Training', 0.2]]);
  assert.deepEqual([...serviceFractions(undefined)], [[UNSPLIT_SERVICE, 1]]);
  assert.deepEqual([...serviceFractions([{ product: 'prod_a', description: null, amount: 0 }])], [[UNSPLIT_SERVICE, 1]]);
  // A credit line reduces its service; the fractions still add up to 1.
  const credit = serviceFractions([
    { product: 'prod_a', description: null, amount: 1000 },
    { product: 'prod_b', description: null, amount: -200 },
  ]);
  assert.deepEqual([...credit], [['prod_a', 1.25], ['prod_b', -0.25]]);
});

test('service view: invoices split across products, then by country, with CSV', () => {
  const agg = new RevenueAggregator('eur', 'test');
  const dev = { product: 'prod_dev', description: 'Development', amount: 900 };
  const train = { product: null, description: 'Training, on site', amount: 100 };
  agg.add(fact({ customerId: 'a', customerCountry: 'GB', lines: [dev, train] }), 1000);
  agg.add(fact({ customerId: 'b', customerCountry: 'CY', lines: [dev] }), 500);
  agg.add(fact({ customerId: 'c', customerCountry: 'CY', lines: [{ ...dev, amount: 50 }] }), 50);
  const r = agg.report({}, new Map([['prod_dev', 'Software development']]));

  assert.deepEqual(
    r.services.map((s) => [s.key, s.name, s.baseAmount, s.invoiceCount, s.customerCount]),
    [
      ['prod_dev', 'Software development', 1450, 3, 3],
      ['desc:Training, on site', 'Training, on site', 100, 1, 1],
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
  assert.deepEqual(reportToCsv(r, 'service').trim().split('\n'), [
    'service,product_id,country,revenue_eur,share_of_service,share_of_total,invoices,customers',
    'Software development,prod_dev,GB,900.00,0.6207,0.5806,1,1',
    'Software development,prod_dev,CY,550.00,0.3793,0.3548,2,2',
    '"Training, on site",,GB,100.00,1.0000,0.0645,1,1',
  ]);
});
