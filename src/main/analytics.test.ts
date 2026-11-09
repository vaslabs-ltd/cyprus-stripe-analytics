import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RevenueAggregator, reportToCsv, resolveCountry, UNKNOWN_COUNTRY, type InvoiceFact } from './analytics';

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

  const csv = reportToCsv(r).trim().split('\n');
  assert.equal(csv[0], 'country,currency,revenue,revenue_minor_units,revenue_eur,invoices,customers');
  assert.equal(csv[3], 'GB,GBP,15.00,1500,18.00,2,1');
});
