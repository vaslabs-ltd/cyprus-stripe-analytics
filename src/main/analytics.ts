import type { CountryCurrencyRevenue, CountryTotal, ReportView, RevenueReport, RevenueQuery } from '../shared/types';

/** Minimal shape of the invoice data the aggregation needs (decoupled from the Stripe SDK). */
export interface InvoiceFact {
  customerId: string | null;
  currency: string;
  amountPaid: number;
  /** UTC date (YYYY-MM-DD) the invoice was paid, used for currency conversion. */
  paidDate: string;
  /** Country from the customer object's billing address (current). */
  customerCountry?: string | null;
  /** Country snapshotted on the invoice at finalization time. */
  invoiceCountry?: string | null;
  /** Country from the customer's shipping address. */
  shippingCountry?: string | null;
}

export const UNKNOWN_COUNTRY = '??';

type Source = keyof RevenueReport['countrySources'];

export function resolveCountry(f: InvoiceFact): { country: string; source: Source } {
  if (f.customerCountry) return { country: f.customerCountry.toUpperCase(), source: 'customerAddress' };
  if (f.invoiceCountry) return { country: f.invoiceCountry.toUpperCase(), source: 'invoiceSnapshot' };
  if (f.shippingCountry) return { country: f.shippingCountry.toUpperCase(), source: 'shipping' };
  return { country: UNKNOWN_COUNTRY, source: 'unknown' };
}

export class RevenueAggregator {
  private readonly buckets = new Map<string, { row: CountryCurrencyRevenue; customers: Set<string> }>();
  private readonly countryBuckets = new Map<string, { row: CountryTotal; customers: Set<string>; currencies: Set<string> }>();
  private readonly sources: RevenueReport['countrySources'] = {
    customerAddress: 0,
    invoiceSnapshot: 0,
    shipping: 0,
    unknown: 0,
  };
  private scanned = 0;

  constructor(
    private readonly baseCurrency: string,
    private readonly fxSource: string,
  ) {}

  /** @param baseAmount the invoice's amount_paid converted to the base currency, in major units. */
  add(f: InvoiceFact, baseAmount: number): void {
    this.scanned++;
    const { country, source } = resolveCountry(f);
    this.sources[source]++;
    const currency = f.currency.toLowerCase();
    const key = `${country}|${currency}`;
    let b = this.buckets.get(key);
    if (!b) {
      b = {
        row: { country, currency, amountMinor: 0, exponent: minorUnitExponent(currency), baseAmount: 0, invoiceCount: 0, customerCount: 0 },
        customers: new Set(),
      };
      this.buckets.set(key, b);
    }
    b.row.amountMinor += f.amountPaid;
    b.row.baseAmount += baseAmount;
    b.row.invoiceCount++;
    if (f.customerId) b.customers.add(f.customerId);

    let cb = this.countryBuckets.get(country);
    if (!cb) {
      cb = {
        row: { country, baseAmount: 0, share: 0, invoiceCount: 0, customerCount: 0, currencies: [] },
        customers: new Set(),
        currencies: new Set(),
      };
      this.countryBuckets.set(country, cb);
    }
    cb.row.baseAmount += baseAmount;
    cb.row.invoiceCount++;
    cb.currencies.add(currency);
    if (f.customerId) cb.customers.add(f.customerId);
  }

  get invoicesScanned(): number {
    return this.scanned;
  }

  report(query: RevenueQuery): RevenueReport {
    const rows = [...this.buckets.values()]
      .map(({ row, customers }) => ({ ...row, customerCount: customers.size }))
      .sort((a, b) => a.country.localeCompare(b.country) || a.currency.localeCompare(b.currency));

    const totals = new Map<string, RevenueReport['totalsByCurrency'][number]>();
    for (const r of rows) {
      const t = totals.get(r.currency) ?? { currency: r.currency, amountMinor: 0, exponent: r.exponent, baseAmount: 0, share: 0, invoiceCount: 0 };
      t.amountMinor += r.amountMinor;
      t.baseAmount += r.baseAmount;
      t.invoiceCount += r.invoiceCount;
      totals.set(r.currency, t);
    }

    const totalsByCurrency = [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency));
    const baseTotal = totalsByCurrency.reduce((sum, t) => sum + t.baseAmount, 0);
    for (const t of totalsByCurrency) t.share = baseTotal > 0 ? t.baseAmount / baseTotal : 0;

    const countries = [...this.countryBuckets.values()]
      .map(({ row, customers, currencies }) => ({
        ...row,
        share: baseTotal > 0 ? row.baseAmount / baseTotal : 0,
        customerCount: customers.size,
        currencies: [...currencies].sort(),
      }))
      .sort((a, b) => b.baseAmount - a.baseAmount || a.country.localeCompare(b.country));

    return {
      rows,
      totalsByCurrency,
      countries,
      baseCurrency: this.baseCurrency,
      baseTotal,
      fxSource: this.fxSource,
      invoicesScanned: this.scanned,
      countrySources: { ...this.sources },
      generatedAt: new Date().toISOString(),
      query,
    };
  }
}

/** Stripe zero-decimal currencies: amounts are already in whole units. */
const ZERO_DECIMAL = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
]);
/** Stripe three-decimal currencies. */
const THREE_DECIMAL = new Set(['bhd', 'jod', 'kwd', 'omr', 'tnd']);

export function minorUnitExponent(currency: string): number {
  const c = currency.toLowerCase();
  if (ZERO_DECIMAL.has(c)) return 0;
  if (THREE_DECIMAL.has(c)) return 3;
  return 2;
}

export function toMajorUnits(amountMinor: number, currency: string): number {
  return amountMinor / 10 ** minorUnitExponent(currency);
}

export function reportToCsv(report: RevenueReport, view: ReportView = 'currency'): string {
  return view === 'eur' ? countriesToCsv(report) : currencyRowsToCsv(report);
}

const csvEscape = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function countriesToCsv(report: RevenueReport): string {
  const base = report.baseCurrency.toLowerCase();
  const exp = minorUnitExponent(base);
  const lines = [['country', `revenue_${base}`, 'share', 'invoices', 'customers', 'currencies'].join(',')];
  for (const c of report.countries) {
    lines.push(
      [c.country, c.baseAmount.toFixed(exp), c.share.toFixed(4), c.invoiceCount, c.customerCount, c.currencies.map((x) => x.toUpperCase()).join(' ')]
        .map(csvEscape)
        .join(','),
    );
  }
  return lines.join('\n') + '\n';
}

function currencyRowsToCsv(report: RevenueReport): string {
  const base = report.baseCurrency.toLowerCase();
  const lines = [['country', 'currency', 'revenue', 'revenue_minor_units', `revenue_${base}`, 'invoices', 'customers'].join(',')];
  for (const r of report.rows) {
    const exp = minorUnitExponent(r.currency);
    lines.push(
      [r.country, r.currency.toUpperCase(), toMajorUnits(r.amountMinor, r.currency).toFixed(exp), r.amountMinor, r.baseAmount.toFixed(minorUnitExponent(base)), r.invoiceCount, r.customerCount]
        .map(csvEscape)
        .join(','),
    );
  }
  return lines.join('\n') + '\n';
}
