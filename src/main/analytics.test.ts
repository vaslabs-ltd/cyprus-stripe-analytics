import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RevenueAggregator, reportToCsv, resolveCountry, UNKNOWN_COUNTRY } from './analytics';

test('country resolution prefers customer address, then invoice snapshot, then shipping', () => {
  assert.deepEqual(resolveCountry({ customerId: 'c', currency: 'gbp', amountPaid: 1, customerCountry: 'gb', invoiceCountry: 'FR' }), {
    country: 'GB',
    source: 'customerAddress',
  });
  assert.equal(resolveCountry({ customerId: 'c', currency: 'gbp', amountPaid: 1, invoiceCountry: 'FR', shippingCountry: 'DE' }).country, 'FR');
  assert.equal(resolveCountry({ customerId: 'c', currency: 'gbp', amountPaid: 1, shippingCountry: 'DE' }).country, 'DE');
  assert.equal(resolveCountry({ customerId: 'c', currency: 'gbp', amountPaid: 1 }).country, UNKNOWN_COUNTRY);
});

test('aggregates per country and currency, counting distinct customers', () => {
  const agg = new RevenueAggregator();
  agg.add({ customerId: 'a', currency: 'gbp', amountPaid: 1000, customerCountry: 'GB' });
  agg.add({ customerId: 'a', currency: 'gbp', amountPaid: 500, customerCountry: 'GB' });
  agg.add({ customerId: 'b', currency: 'eur', amountPaid: 200, customerCountry: 'GB' });
  agg.add({ customerId: 'c', currency: 'EUR', amountPaid: 300, customerCountry: 'CY' });
  agg.add({ customerId: 'd', currency: 'jpy', amountPaid: 5000, customerCountry: 'JP' });

  const r = agg.report({});
  assert.equal(r.invoicesScanned, 5);
  assert.deepEqual(
    r.rows.map((x) => [x.country, x.currency, x.amountMinor, x.invoiceCount, x.customerCount, x.exponent]),
    [
      ['CY', 'eur', 300, 1, 1, 2],
      ['GB', 'eur', 200, 1, 1, 2],
      ['GB', 'gbp', 1500, 2, 1, 2],
      ['JP', 'jpy', 5000, 1, 1, 0],
    ],
  );
  assert.deepEqual(
    r.totalsByCurrency.map((t) => [t.currency, t.amountMinor, t.invoiceCount]),
    [
      ['eur', 500, 2],
      ['gbp', 1500, 2],
      ['jpy', 5000, 1],
    ],
  );

  const csv = reportToCsv(r).trim().split('\n');
  assert.equal(csv[0], 'country,currency,revenue,revenue_minor_units,invoices,customers');
  assert.equal(csv[3], 'GB,GBP,15.00,1500,2,1');
  assert.equal(csv[4], 'JP,JPY,5000,5000,1,1');
});
