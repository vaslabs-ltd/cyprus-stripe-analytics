import type { VatInvoice, VatQuery, VatReport, VatSection, VatSectionSummary, ViesLine, ViesMonth } from '../shared/types';
import { minorUnitExponent, toMajorUnits, UNKNOWN_COUNTRY } from './analytics';

/** The company's VAT registration country. */
export const HOME_COUNTRY = 'CY';

/** EU member states (ISO 3166-1 alpha-2). Greece is GR in ISO, EL in VIES. */
export const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU',
  'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK',
]);

/**
 * Taxability reasons that mean "no VAT, on purpose": the sale was recorded in Stripe as exempt,
 * 0% rated, reverse charge or outside the scope of tax. A 0-VAT invoice without one of these
 * (no tax calculated, or `not_collecting`) is flagged.
 */
export const NO_VAT_REASONS = new Set([
  'product_exempt', 'product_exempt_holiday', 'zero_rated', 'reverse_charge', 'customer_exempt',
  'not_subject_to_tax', 'excluded_territory', 'proportionally_rated', 'portion_product_exempt',
]);

/** Invoice statuses that count for VAT: finalized and not voided. */
export const VAT_STATUSES = new Set(['open', 'paid', 'uncollectible']);

/** Minimal invoice data the VAT report needs (decoupled from the Stripe SDK). */
export interface VatInvoiceFact {
  id: string;
  number: string | null;
  /** Invoice date (YYYY-MM-DD, UTC): `effective_at`, else finalization date. */
  date: string;
  status: string;
  customerId: string | null;
  customerName: string | null;
  currency: string;
  /** Invoice total including tax, minor units. */
  totalMinor: number;
  /** Sum of all taxes on the invoice, minor units. */
  vatMinor: number;
  /** `taxability_reason` of each entry in the invoice's `total_taxes`. */
  taxReasons: string[];
  /** Tax IDs snapshotted on the invoice. */
  taxIds: { type: string; value: string | null }[];
  /** Country snapshotted on the invoice at finalization time. */
  invoiceCountry?: string | null;
  /** Country from the customer's current billing address. */
  customerCountry?: string | null;
  shippingCountry?: string | null;
}

/**
 * For VAT the invoice is the legal document, so the address printed on it wins over the
 * customer's current address (unlike the Country Revenue report).
 */
export function resolveVatCountry(f: Pick<VatInvoiceFact, 'invoiceCountry' | 'customerCountry' | 'shippingCountry'>): string {
  const c = f.invoiceCountry || f.customerCountry || f.shippingCountry;
  return c ? c.toUpperCase() : UNKNOWN_COUNTRY;
}

export function vatSection(country: string): VatSection {
  if (country === HOME_COUNTRY) return 'cy';
  if (EU_COUNTRIES.has(country)) return 'vies';
  return 'intl';
}

/** Every YYYY-MM month touched by [from, to], in order. */
export function monthsBetween(from: string, to: string): string[] {
  const months: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const end = to.slice(0, 7);
  for (;;) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    if (key > end) break;
    months.push(key);
    if (++m > 12) {
      m = 1;
      y++;
    }
  }
  return months;
}

function warningsFor(section: VatSection, country: string, vatMinor: number, vatNumber: string | null, taxReasons: string[]): string[] {
  const w: string[] = [];
  if (country === UNKNOWN_COUNTRY) w.push('Customer country unknown');
  if (section === 'cy' && vatMinor === 0 && !taxReasons.some((r) => NO_VAT_REASONS.has(r))) {
    w.push('No VAT charged and no exemption or 0% rate recorded');
  }
  if (section === 'vies') {
    if (vatMinor !== 0) w.push('VAT charged on a reverse-charge invoice');
    if (!vatNumber) w.push('No EU VAT number on invoice');
  }
  if (section === 'intl' && vatMinor !== 0) w.push('VAT charged');
  return w;
}

function pickVatNumber(taxIds: VatInvoiceFact['taxIds']): string | null {
  const withValue = taxIds.filter((t) => t.value);
  return (withValue.find((t) => t.type === 'eu_vat') ?? withValue[0])?.value ?? null;
}

const emptySummary = (section: VatSection): VatSectionSummary => ({
  section,
  invoiceCount: 0,
  customerCount: 0,
  netEurCents: 0,
  vatEurCents: 0,
  grossEurCents: 0,
  vatPaidEurCents: 0,
  noVatNetEurCents: 0,
  unpaidCount: 0,
});

/**
 * @param eurRate units of `currency` per 1 EUR on `date`.
 * Each invoice's net and VAT are converted to EUR and rounded to cents on their own,
 * so section totals are sums of what each invoice row shows.
 */
export function buildVatReport(
  facts: VatInvoiceFact[],
  eurRate: (currency: string, date: string) => number,
  query: VatQuery,
  meta: { fxSource: string; invoicesScanned: number },
): VatReport {
  const invoices: VatInvoice[] = [];
  for (const f of facts) {
    if (!VAT_STATUSES.has(f.status) || f.date < query.from || f.date > query.to) continue;
    const currency = f.currency.toLowerCase();
    const country = resolveVatCountry(f);
    const section = vatSection(country);
    const vatNumber = pickVatNumber(f.taxIds);
    const rate = eurRate(currency, f.date);
    const toEurCents = (minor: number) => Math.round((toMajorUnits(minor, currency) / rate) * 100);
    const netEurCents = toEurCents(f.totalMinor - f.vatMinor);
    const vatEurCents = toEurCents(f.vatMinor);
    invoices.push({
      id: f.id,
      number: f.number,
      date: f.date,
      month: f.date.slice(0, 7),
      status: f.status,
      customerId: f.customerId,
      customerName: f.customerName,
      country,
      vatNumber,
      section,
      currency,
      exponent: minorUnitExponent(currency),
      totalMinor: f.totalMinor,
      taxReasons: [...new Set(f.taxReasons)].sort(),
      netEurCents,
      vatEurCents,
      grossEurCents: netEurCents + vatEurCents,
      warnings: warningsFor(section, country, f.vatMinor, vatNumber, f.taxReasons),
    });
  }
  invoices.sort((a, b) => a.date.localeCompare(b.date) || (a.number ?? a.id).localeCompare(b.number ?? b.id));

  const summaries = { cy: emptySummary('cy'), vies: emptySummary('vies'), intl: emptySummary('intl') };
  const customers = { cy: new Set<string>(), vies: new Set<string>(), intl: new Set<string>() };
  for (const inv of invoices) {
    const s = summaries[inv.section];
    s.invoiceCount++;
    s.netEurCents += inv.netEurCents;
    s.vatEurCents += inv.vatEurCents;
    s.grossEurCents += inv.grossEurCents;
    if (inv.vatEurCents === 0) s.noVatNetEurCents += inv.netEurCents;
    if (inv.status === 'paid') s.vatPaidEurCents += inv.vatEurCents;
    else s.unpaidCount++;
    customers[inv.section].add(inv.customerId ?? inv.customerName ?? inv.id);
  }
  for (const k of ['cy', 'vies', 'intl'] as const) summaries[k].customerCount = customers[k].size;

  const viesMonths: ViesMonth[] = monthsBetween(query.from, query.to).map((month) => {
    const lines = new Map<string, ViesLine>();
    for (const inv of invoices) {
      if (inv.section !== 'vies' || inv.month !== month) continue;
      const key = inv.vatNumber ? `vat:${inv.vatNumber}` : `cus:${inv.customerId ?? inv.id}`;
      const line = lines.get(key) ?? { country: inv.country, vatNumber: inv.vatNumber, customerName: inv.customerName, netEurCents: 0, invoiceCount: 0 };
      line.netEurCents += inv.netEurCents;
      line.invoiceCount++;
      lines.set(key, line);
    }
    const sorted = [...lines.values()].sort(
      (a, b) => a.country.localeCompare(b.country) || (a.vatNumber ?? '').localeCompare(b.vatNumber ?? ''),
    );
    return {
      month,
      netEurCents: sorted.reduce((n, l) => n + l.netEurCents, 0),
      invoiceCount: sorted.reduce((n, l) => n + l.invoiceCount, 0),
      lines: sorted,
    };
  });

  return {
    query,
    invoices,
    summaries,
    viesMonths,
    fxSource: meta.fxSource,
    invoicesScanned: meta.invoicesScanned,
    generatedAt: new Date().toISOString(),
  };
}

const SECTION_LABEL: Record<VatSection, string> = { cy: 'Cyprus VAT', vies: 'VIES', intl: 'International' };

const csvEscape = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const cents = (c: number) => (c / 100).toFixed(2);

/** One row per invoice; all EUR amounts at the ECB rate on the invoice date. */
export function vatReportToCsv(report: VatReport): string {
  const lines = [
    [
      'section', 'month', 'invoice_date', 'invoice_number', 'invoice_id', 'status', 'customer_id', 'customer_name',
      'country', 'vat_number', 'tax_treatment', 'currency', 'total', 'net_eur', 'vat_eur', 'gross_eur', 'warnings',
    ].join(','),
  ];
  for (const i of report.invoices) {
    lines.push(
      [
        SECTION_LABEL[i.section], i.month, i.date, i.number ?? '', i.id, i.status, i.customerId ?? '', i.customerName ?? '',
        i.country, i.vatNumber ?? '', i.taxReasons.join(' '), i.currency.toUpperCase(), toMajorUnits(i.totalMinor, i.currency).toFixed(i.exponent),
        cents(i.netEurCents), cents(i.vatEurCents), cents(i.grossEurCents), i.warnings.join('; '),
      ]
        .map(csvEscape)
        .join(','),
    );
  }
  return lines.join('\n') + '\n';
}
