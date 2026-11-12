import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_TAX_CODE,
  RevenueAggregator,
  regroupContractors,
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
    'service,tax_code,country,revenue_eur,share_of_service,share_of_total,invoices,customers,service_share_of_total',
    'txcd_it,txcd_it,GB,900.00,0.6207,0.5806,1,1,0.9355',
    'txcd_it,txcd_it,CY,550.00,0.3793,0.3548,2,2,0.9355',
    '"Marketing, advertising",txcd_mkt,GB,100.00,1.0000,0.0645,1,1,0.0645',
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
    'service,tax_code,country,currency,revenue,revenue_minor_units,revenue_eur,invoices,customers,service_share_of_total',
    'txcd_it,txcd_it,CY,EUR,7.00,700,7.00,1,1,0.8333',
    'txcd_it,txcd_it,GB,EUR,5.00,500,5.00,1,1,0.8333',
    'txcd_it,txcd_it,GB,GBP,6.67,667,8.00,1,1,0.8333',
    'txcd_mkt,txcd_mkt,GB,GBP,3.33,333,4.00,1,1,0.1667',
  ]);
});

test('product view: invoices split across products by net line amount, with CSV in both views', () => {
  const agg = new RevenueAggregator('eur', 'test', byCode);
  const dev = { product: 'prod_dev', description: 'Development', amount: 2 };
  const ads = { product: 'prod_ads', description: 'Ads', amount: 1 };
  const adhoc = { product: null, description: 'Ad-hoc', amount: 2 };
  agg.add(fact({ customerId: 'a', currency: 'gbp', amountPaid: 1000, customerCountry: 'GB', lines: [dev, ads] }), 12);
  agg.add(fact({ customerId: 'b', currency: 'eur', amountPaid: 500, customerCountry: 'CY', lines: [dev, adhoc] }), 5);
  agg.add(fact({ customerId: 'c', currency: 'eur', amountPaid: 100, customerCountry: 'CY' }), 1);
  const r = agg.report({});

  assert.deepEqual(
    r.products.map((p) => [p.key, p.name, p.items, p.baseAmount, p.invoiceCount, p.customerCount]),
    [
      ['prod_dev', 'Development', [], 8 + 2.5, 2, 2],
      ['prod_ads', 'Ads', [], 4, 1, 1],
      ['line:Ad-hoc', 'Ad-hoc', [], 2.5, 1, 1],
      [UNSPLIT_SERVICE, 'Not split (no line items)', [], 1, 1, 1],
    ],
  );
  const dv = r.products[0];
  assert.deepEqual(dv.byCurrency.map((c) => [c.currency, c.amountMinor]), [['eur', 250], ['gbp', 667]]);
  // Per currency, products add up to the currency totals exactly.
  for (const t of r.totalsByCurrency) {
    const sum = r.products.flatMap((p) => p.byCurrency).filter((c) => c.currency === t.currency).reduce((n, c) => n + c.amountMinor, 0);
    assert.equal(sum, t.amountMinor, t.currency);
  }
  assert.deepEqual(reportToCsv(r, 'product').trim().split('\n').slice(0, 3), [
    'product,product_id,country,currency,revenue,revenue_minor_units,revenue_eur,invoices,customers,product_share_of_total',
    'Development,prod_dev,CY,EUR,2.50,250,2.50,1,1,0.5833',
    'Development,prod_dev,GB,GBP,6.67,667,8.00,1,1,0.5833',
  ]);
  assert.deepEqual(reportToCsv(r, 'product-eur').trim().split('\n').slice(0, 2), [
    'product,product_id,country,revenue_eur,share_of_product,share_of_total,invoices,customers,product_share_of_total',
    'Development,prod_dev,GB,8.00,0.7619,0.4444,1,1,0.5833',
  ]);
  assert.match(reportToCsv(r, 'product-eur'), /\nAd-hoc,,CY,2\.50,/);
});

test('client view: whole invoices per customer, with the products they bought', () => {
  const agg = new RevenueAggregator('eur', 'test', byCode);
  const dev = { product: 'prod_dev', description: 'Development', amount: 2 };
  const ads = { product: 'prod_ads', description: 'Ads', amount: 1 };
  agg.add(fact({ customerId: 'cus_a', customerName: 'Acme', currency: 'gbp', amountPaid: 1000, customerCountry: 'GB', lines: [dev, ads] }), 12);
  agg.add(fact({ customerId: 'cus_a', customerName: 'Acme', currency: 'eur', amountPaid: 300, customerCountry: 'GB', lines: [dev] }), 3);
  agg.add(fact({ customerId: 'cus_b', customerName: 'Beta, Ltd', currency: 'eur', amountPaid: 500, customerCountry: 'CY', lines: [dev] }), 5);
  agg.add(fact({ customerId: null, currency: 'eur', amountPaid: 100, customerCountry: 'CY' }), 1);
  const r = agg.report({});

  assert.deepEqual(
    r.clients.map((c) => [c.key, c.name, c.items, c.baseAmount, c.invoiceCount, c.customerCount]),
    [
      ['cus_a', 'Acme', ['Ads', 'Development'], 15, 2, 1],
      ['cus_b', 'Beta, Ltd', ['Development'], 5, 1, 1],
      ['none', 'No customer', [], 1, 1, 0],
    ],
  );
  assert.deepEqual(r.clients[0].byCurrency.map((c) => [c.currency, c.amountMinor]), [['eur', 300], ['gbp', 1000]]);
  assert.deepEqual(reportToCsv(r, 'client-eur').trim().split('\n'), [
    'client,customer_id,country,revenue_eur,share_of_total,invoices,customers,client_share_of_total',
    'Acme,cus_a,GB,15.00,0.7143,2,1,0.7143',
    '"Beta, Ltd",cus_b,CY,5.00,0.2381,1,1,0.2381',
    'No customer,,CY,1.00,0.0476,1,0,0.0476',
  ]);
  assert.deepEqual(reportToCsv(r, 'client').trim().split('\n').slice(0, 3), [
    'client,customer_id,country,currency,revenue,revenue_minor_units,revenue_eur,invoices,customers,client_share_of_total',
    'Acme,cus_a,GB,EUR,3.00,300,3.00,1,1,0.7143',
    'Acme,cus_a,GB,GBP,10.00,1000,12.00,1,1,0.7143',
  ]);
});

test('contractor view: lines go to whoever their product is assigned to, the rest unassigned', () => {
  const contractors = { names: new Map([['ctr_a', 'Ann'], ['ctr_b', 'Ben']]), byProduct: new Map([['prod_dev', 'ctr_a'], ['prod_ads', 'ctr_b'], ['prod_host', 'ctr_a']]) };
  const agg = new RevenueAggregator('eur', 'test', byCode, contractors);
  const dev = { product: 'prod_dev', description: 'Development', amount: 2 };
  const ads = { product: 'prod_ads', description: 'Ads', amount: 1 };
  const adhoc = { product: null, description: 'Ad-hoc', amount: 1 };
  agg.add(fact({ customerId: 'a', currency: 'gbp', amountPaid: 1000, customerCountry: 'GB', lines: [dev, ads] }), 12);
  agg.add(fact({ customerId: 'b', currency: 'eur', amountPaid: 400, customerCountry: 'CY', lines: [dev, adhoc, { product: 'prod_host', description: 'Hosting', amount: 1 }] }), 4);
  agg.add(fact({ customerId: 'c', currency: 'eur', amountPaid: 100, customerCountry: 'CY' }), 1);
  const r = agg.report({});

  assert.deepEqual(
    r.contractors.map((c) => [c.key, c.name, c.items, c.baseAmount, c.invoiceCount]),
    [
      ['ctr_a', 'Ann', ['Development', 'Hosting'], 8 + 3, 2],
      ['ctr_b', 'Ben', ['Ads'], 4, 1],
      // Equal totals: by name.
      [UNSPLIT_SERVICE, 'Not split (no line items)', [], 1, 1],
      ['unassigned', 'Unassigned', ['Ad-hoc'], 1, 1],
    ],
  );
  assert.deepEqual(r.contractors[0].byCurrency.map((c) => [c.currency, c.amountMinor]), [['eur', 300], ['gbp', 667]]);
  assert.deepEqual(reportToCsv(r, 'contractor-eur').trim().split('\n').slice(0, 2), [
    'contractor,products,country,revenue_eur,share_of_contractor,share_of_total,invoices,customers,contractor_share_of_total',
    'Ann,Development; Hosting,GB,8.00,0.7273,0.4706,1,1,0.6471',
  ]);
  assert.equal(reportToCsv(r, 'contractor').split('\n')[0], 'contractor,products,country,currency,revenue,revenue_minor_units,revenue_eur,invoices,customers,contractor_share_of_total');

  // Without contractors everything is unassigned.
  const none = new RevenueAggregator('eur', 'test', byCode);
  none.add(fact({ lines: [dev] }), 1);
  assert.deepEqual(none.report({}).contractors.map((c) => c.key), ['unassigned']);
});

test('contractors are regrouped from the loaded report when assignments change, as a fresh load would', () => {
  const dev = { product: 'prod_dev', description: 'Development', amount: 2 };
  const ads = { product: 'prod_ads', description: 'Ads', amount: 1 };
  const host = { product: 'prod_host', description: 'Hosting', amount: 1 };
  const facts = [
    fact({ customerId: 'a', currency: 'gbp', amountPaid: 1000, customerCountry: 'GB', lines: [dev, ads] }),
    fact({ customerId: 'b', currency: 'eur', amountPaid: 400, customerCountry: 'CY', lines: [dev, host] }),
  ];
  const build = (byProduct: Map<string, string>) => {
    const agg = new RevenueAggregator('eur', 'test', byCode, { names: new Map([['ctr_a', 'Ann'], ['ctr_b', 'Ben']]), byProduct });
    facts.forEach((f, i) => agg.add(f, [12, 4][i]));
    return agg.report({});
  };
  const before = build(new Map([['prod_dev', 'ctr_a']]));
  assert.deepEqual(before.contractors.map((c) => [c.name, Math.round(c.baseAmount * 100) / 100]), [['Ann', 10.67], ['Unassigned', 5.33]]);

  const moved = new Map([['prod_dev', 'ctr_b'], ['prod_host', 'ctr_b'], ['prod_ads', 'ctr_a']]);
  const names = new Map([['ctr_a', 'Ann'], ['ctr_b', 'Ben']]);
  const after = regroupContractors(before, { names, byProduct: moved });
  assert.deepEqual(after.contractors, build(moved).contractors);
  // Ben has two products on invoice b: it still counts once.
  assert.deepEqual(after.contractors.map((c) => [c.name, c.baseAmount, c.invoiceCount, c.items]), [
    ['Ben', 8 + 4, 2, ['Development', 'Hosting']],
    ['Ann', 4, 1, ['Ads']],
  ]);
  // Everything else is untouched; an older report without product parts comes back as it was.
  assert.equal(after.products, before.products);
  const old = { ...before, productParts: undefined };
  assert.equal(regroupContractors(old, { names, byProduct: moved }), old);
});

test('contractor breakdown by product and by client, with shares of the contractor and CSV', () => {
  const contractors = { names: new Map([['ctr_a', 'Ann']]), byProduct: new Map([['prod_dev', 'ctr_a'], ['prod_host', 'ctr_a']]) };
  const agg = new RevenueAggregator('eur', 'test', byCode, contractors);
  const dev = { product: 'prod_dev', description: 'Development', amount: 3 };
  const host = { product: 'prod_host', description: 'Hosting', amount: 1 };
  agg.add(fact({ customerId: 'cus_x', customerName: 'Xeno', currency: 'eur', amountPaid: 800, customerCountry: 'CY', lines: [dev, host] }), 8);
  agg.add(fact({ customerId: 'cus_y', customerName: 'Yarrow', currency: 'gbp', amountPaid: 400, customerCountry: 'GB', lines: [dev] }), 4);
  const r = agg.report({});
  const ann = r.contractors.find((c) => c.key === 'ctr_a')!;
  assert.deepEqual(
    ann.sub!.product.map((p) => [p.name, p.baseAmount, p.share, p.invoiceCount, p.byCurrency.map((c) => [c.currency, c.amountMinor])]),
    [
      ['Development', 10, 10 / 12, 2, [['eur', 600], ['gbp', 400]]],
      ['Hosting', 2, 2 / 12, 1, [['eur', 200]]],
    ],
  );
  // Per client, an invoice with two of Ann's products counts once.
  assert.deepEqual(
    ann.sub!.client.map((c) => [c.name, c.baseAmount, c.invoiceCount, c.items]),
    [
      ['Xeno', 8, 1, ['Development', 'Hosting']],
      ['Yarrow', 4, 1, ['Development']],
    ],
  );
  assert.deepEqual(reportToCsv(r, 'contractor-eur', 'client').trim().split('\n'), [
    'contractor,products,client,revenue_eur,share_of_contractor,share_of_total,invoices,customers,contractor_share_of_total',
    'Ann,Development; Hosting,Xeno,8.00,0.6667,0.6667,1,1,1.0000',
    'Ann,Development; Hosting,Yarrow,4.00,0.3333,0.3333,1,1,1.0000',
  ]);
  assert.deepEqual(reportToCsv(r, 'contractor', 'product').trim().split('\n'), [
    'contractor,products,product,currency,revenue,revenue_minor_units,revenue_eur,invoices,customers,contractor_share_of_total',
    'Ann,Development; Hosting,Development,EUR,6.00,600,6.00,1,1,1.0000',
    'Ann,Development; Hosting,Development,GBP,4.00,400,4.00,1,1,1.0000',
    'Ann,Development; Hosting,Hosting,EUR,2.00,200,2.00,1,1,1.0000',
  ]);
  // The breakdown is only for contractors; by country is the default.
  assert.equal(reportToCsv(r, 'contractor-eur').split('\n')[0].split(',')[2], 'country');
});
