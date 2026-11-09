import type { CountryCurrencyRevenue, RevenueReport, RevenueQuery } from '../shared/types';

/** Minimal shape of the invoice data the aggregation needs (decoupled from the Stripe SDK). */
export interface InvoiceFact {
  customerId: string | null;
  currency: string;
  amountPaid: number;
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
  private readonly sources: RevenueReport['countrySources'] = {
    customerAddress: 0,
    invoiceSnapshot: 0,
    shipping: 0,
    unknown: 0,
  };
  private scanned = 0;

  add(f: InvoiceFact): void {
    this.scanned++;
    const { country, source } = resolveCountry(f);
    this.sources[source]++;
    const currency = f.currency.toLowerCase();
    const key = `${country}|${currency}`;
    let b = this.buckets.get(key);
    if (!b) {
      b = {
        row: { country, currency, amountMinor: 0, exponent: minorUnitExponent(currency), invoiceCount: 0, customerCount: 0 },
        customers: new Set(),
      };
      this.buckets.set(key, b);
    }
    b.row.amountMinor += f.amountPaid;
    b.row.invoiceCount++;
    if (f.customerId) b.customers.add(f.customerId);
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
      const t = totals.get(r.currency) ?? { currency: r.currency, amountMinor: 0, exponent: r.exponent, invoiceCount: 0 };
      t.amountMinor += r.amountMinor;
      t.invoiceCount += r.invoiceCount;
      totals.set(r.currency, t);
    }

    return {
      rows,
      totalsByCurrency: [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
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

export function reportToCsv(report: RevenueReport): string {
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [['country', 'currency', 'revenue', 'revenue_minor_units', 'invoices', 'customers'].join(',')];
  for (const r of report.rows) {
    const exp = minorUnitExponent(r.currency);
    lines.push(
      [r.country, r.currency.toUpperCase(), toMajorUnits(r.amountMinor, r.currency).toFixed(exp), r.amountMinor, r.invoiceCount, r.customerCount]
        .map(esc)
        .join(','),
    );
  }
  return lines.join('\n') + '\n';
}
