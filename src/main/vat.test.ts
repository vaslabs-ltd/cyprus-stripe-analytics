import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { InvoiceStatus } from '../shared/types';
import { buildVatReport, monthsBetween, resolveVatCountry, vatReportToCsv, vatSection, type VatInvoiceFact } from './vat';

const fact = (f: Partial<VatInvoiceFact>): VatInvoiceFact => ({
  id: 'in_1',
  number: 'INV-1',
  date: '2026-01-15',
  status: 'paid',
  customerId: 'cus_1',
  customerName: 'Acme',
  currency: 'eur',
  totalMinor: 0,
  vatMinor: 0,
  taxIds: [],
  taxReasons: [],
  ...f,
});

// 1 EUR = 0.8 GBP
const rate = (cur: string) => (cur === 'gbp' ? 0.8 : 1);
const scope = { createdFrom: '2025-01-01', createdTo: '2026-12-31', statuses: ['paid', 'open', 'uncollectible'] as InvoiceStatus[] };
const meta = { fxSource: 'test', invoicesScanned: 99, scope };

test('sections: Cyprus, other EU (VIES), everything else international', () => {
  assert.equal(vatSection('CY'), 'cy');
  assert.equal(vatSection('DE'), 'vies');
  assert.equal(vatSection('GR'), 'vies');
  assert.equal(vatSection('GB'), 'intl');
  assert.equal(vatSection('US'), 'intl');
  assert.equal(vatSection('??'), 'intl');
});

test('VAT country prefers the address on the invoice over the current customer address', () => {
  assert.equal(resolveVatCountry({ invoiceCountry: 'de', customerCountry: 'CY' }), 'DE');
  assert.equal(resolveVatCountry({ customerCountry: 'cy', shippingCountry: 'FR' }), 'CY');
  assert.equal(resolveVatCountry({}), '??');
});

test('months of a legacy Dec–Feb quarter span the year end', () => {
  assert.deepEqual(monthsBetween('2025-12-01', '2026-02-28'), ['2025-12', '2026-01', '2026-02']);
  assert.deepEqual(monthsBetween('2026-03-01', '2026-03-10'), ['2026-03']);
});

test('builds Cyprus VAT, VIES per month and international for a Dec–Feb quarter', () => {
  const r = buildVatReport(
    [
      // Cyprus: 19% VAT, one paid, one unpaid
      fact({ id: 'a', number: 'A', date: '2025-12-05', customerId: 'cy1', invoiceCountry: 'CY', totalMinor: 11900, vatMinor: 1900, taxReasons: ['standard_rated'] }),
      fact({ id: 'b', number: 'B', date: '2026-02-10', status: 'open', customerId: 'cy2', invoiceCountry: 'CY', totalMinor: 23800, vatMinor: 3800 }),
      // VIES: two invoices to one German customer in December, one French customer in February (GBP)
      fact({ id: 'c', number: 'C', date: '2025-12-20', customerId: 'de1', invoiceCountry: 'DE', totalMinor: 50000, taxIds: [{ type: 'eu_vat', value: 'DE123' }] }),
      fact({ id: 'd', number: 'D', date: '2025-12-28', customerId: 'de1', invoiceCountry: 'DE', totalMinor: 25000, taxIds: [{ type: 'eu_vat', value: 'DE123' }] }),
      fact({ id: 'e', number: 'E', date: '2026-02-01', customerId: 'fr1', currency: 'gbp', invoiceCountry: 'FR', totalMinor: 8000 }),
      // International
      fact({ id: 'f', number: 'F', date: '2026-01-31', customerId: 'us1', currency: 'gbp', invoiceCountry: 'US', totalMinor: 4000 }),
      // Excluded: outside the period, void, draft
      fact({ id: 'g', date: '2026-03-01', invoiceCountry: 'CY', totalMinor: 11900, vatMinor: 1900 }),
      fact({ id: 'h', status: 'void', invoiceCountry: 'CY', totalMinor: 11900, vatMinor: 1900 }),
      fact({ id: 'i', status: 'draft', invoiceCountry: 'CY', totalMinor: 11900, vatMinor: 1900 }),
    ],
    rate,
    { from: '2025-12-01', to: '2026-02-28' },
    meta,
  );

  assert.deepEqual(r.invoices.map((i) => i.id), ['a', 'c', 'd', 'f', 'e', 'b']);
  assert.deepEqual(r.summaries.cy, {
    section: 'cy', invoiceCount: 2, customerCount: 2, netEurCents: 30000, vatEurCents: 5700, grossEurCents: 35700, vatPaidEurCents: 1900, noVatNetEurCents: 0, unpaidCount: 1,
  });
  assert.equal(r.summaries.vies.netEurCents, 85000); // 500 + 250 + 80 GBP / 0.8
  assert.equal(r.summaries.vies.customerCount, 2);
  assert.equal(r.summaries.intl.netEurCents, 5000);

  assert.deepEqual(
    r.viesMonths.map((m) => [m.month, m.netEurCents, m.invoiceCount, m.lines.map((l) => [l.country, l.vatNumber, l.netEurCents, l.invoiceCount])]),
    [
      ['2025-12', 75000, 2, [['DE', 'DE123', 75000, 2]]],
      ['2026-01', 0, 0, []],
      ['2026-02', 10000, 1, [['FR', null, 10000, 1]]],
    ],
  );
  assert.deepEqual(r.invoices.find((i) => i.id === 'e')!.warnings, ['No EU VAT number on invoice']);
  assert.deepEqual(r.invoices.find((i) => i.id === 'c')!.warnings, []);

  const csv = vatReportToCsv(r).trim().split('\n');
  assert.equal(csv[0], 'section,month,invoice_date,invoice_number,invoice_id,status,customer_id,customer_name,country,vat_number,tax_treatment,currency,total,net_eur,vat_eur,gross_eur,warnings');
  assert.equal(csv[1], 'Cyprus VAT,2025-12,2025-12-05,A,a,paid,cy1,Acme,CY,,standard_rated,EUR,119.00,100.00,19.00,119.00,');
  assert.equal(csv[5], 'VIES,2026-02,2026-02-01,E,e,paid,fr1,Acme,FR,,,GBP,80.00,100.00,0.00,100.00,No EU VAT number on invoice');
});

test('flags VAT on reverse-charge and international invoices, and Cyprus invoices without VAT', () => {
  const r = buildVatReport(
    [
      fact({ id: 'a', invoiceCountry: 'CY', totalMinor: 1000 }),
      fact({ id: 'b', invoiceCountry: 'IT', totalMinor: 1220, vatMinor: 220, taxIds: [{ type: 'eu_vat', value: 'IT1' }] }),
      fact({ id: 'c', invoiceCountry: 'GB', totalMinor: 1190, vatMinor: 190 }),
      fact({ id: 'd', totalMinor: 1000 }),
    ],
    rate,
    { from: '2026-01-01', to: '2026-01-31' },
    meta,
  );
  const w = Object.fromEntries(r.invoices.map((i) => [i.id, i.warnings]));
  assert.deepEqual(w, {
    a: ['No VAT charged and no exemption or 0% rate recorded'],
    b: ['VAT charged on a reverse-charge invoice'],
    c: ['VAT charged'],
    d: ['Customer country unknown'],
  });
});

test('Cyprus 0% or exempt sales recorded by Stripe Tax are not flagged, and are totalled separately', () => {
  const r = buildVatReport(
    [
      fact({ id: 'tutoring', invoiceCountry: 'CY', totalMinor: 12000, taxReasons: ['product_exempt'] }),
      fact({ id: 'zero', invoiceCountry: 'CY', totalMinor: 5000, taxReasons: ['zero_rated'] }),
      fact({ id: 'missing', invoiceCountry: 'CY', totalMinor: 1000, taxReasons: ['not_collecting'] }),
      fact({ id: 'std', invoiceCountry: 'CY', totalMinor: 11900, vatMinor: 1900, taxReasons: ['standard_rated'] }),
    ],
    rate,
    { from: '2026-01-01', to: '2026-01-31' },
    meta,
  );
  const w = Object.fromEntries(r.invoices.map((i) => [i.id, i.warnings.length]));
  assert.deepEqual(w, { tutoring: 0, zero: 0, missing: 1, std: 0 });
  assert.equal(r.summaries.cy.noVatNetEurCents, 18000);
  assert.equal(r.summaries.cy.vatEurCents, 1900);
});
