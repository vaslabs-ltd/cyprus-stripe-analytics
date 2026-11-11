import type { CountryCurrencyRevenue, CountryTotal, ReportView, RevenueReport, RevenueQuery, ServiceTotal } from '../shared/types';

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
  /** The invoice's line items, used to split its revenue by service. */
  lines?: LineFact[];
}

export interface LineFact {
  /** Stripe product ID, or null for a line without one. */
  product: string | null;
  description: string | null;
  /** Line amount after discounts, before tax, in the invoice currency's minor units. */
  amount: number;
}

/** How a line item is reported: its service (a tax code) and the item behind it. */
export interface LineClass {
  /** A Stripe tax code ID (txcd_…), or NO_TAX_CODE / UNKNOWN_TAX_CODE. */
  service: string;
  /** What the line sells, for the list under each service: product name or line description. */
  item: string;
}
export type Classify = (l: LineFact) => LineClass;

/** Service of an invoice with no line amounts to split it by. */
export const UNSPLIT_SERVICE = 'unsplit';
/** Neither the product nor the account has a tax code. */
export const NO_TAX_CODE = 'none';
/** The tax code couldn't be read (no access to Products or Tax settings). */
export const UNKNOWN_TAX_CODE = 'unknown';

const lineItem = (l: LineFact) => (l.description ?? '').trim() || l.product || 'Line without a description';
const unknownClass: Classify = (l) => ({ service: UNKNOWN_TAX_CODE, item: lineItem(l) });

/**
 * How an invoice's revenue splits across services: each service gets the fraction of the invoice's
 * net line amounts that its lines make up. Fractions add up to 1. An invoice without lines, or whose
 * lines add up to zero or less, goes to UNSPLIT_SERVICE whole.
 */
export function serviceFractions(lines: LineFact[] | undefined, classify: Classify): Map<string, { fraction: number; items: Set<string> }> {
  const byKey = new Map<string, { amount: number; items: Set<string> }>();
  for (const l of lines ?? []) {
    const { service, item } = classify(l);
    let b = byKey.get(service);
    if (!b) byKey.set(service, (b = { amount: 0, items: new Set() }));
    b.amount += l.amount;
    b.items.add(item);
  }
  const sum = [...byKey.values()].reduce((a, b) => a + b.amount, 0);
  if (sum <= 0) return new Map([[UNSPLIT_SERVICE, { fraction: 1, items: new Set() }]]);
  const out = new Map<string, { fraction: number; items: Set<string> }>();
  for (const [k, v] of byKey) if (v.amount !== 0) out.set(k, { fraction: v.amount / sum, items: v.items });
  return out;
}

export function serviceName(key: string, taxCodeNames: ReadonlyMap<string, string>): string {
  if (key === UNSPLIT_SERVICE) return 'Not split (no line items)';
  if (key === NO_TAX_CODE) return 'No tax code';
  if (key === UNKNOWN_TAX_CODE) return 'Tax code unknown';
  return taxCodeNames.get(key) ?? key;
}

interface Tally {
  /** Original currency, minor units (only for tallies of a single currency). */
  amountMinor: number;
  baseAmount: number;
  invoiceCount: number;
  customers: Set<string>;
}
const tally = (): Tally => ({ amountMinor: 0, baseAmount: 0, invoiceCount: 0, customers: new Set() });

/**
 * Splits a whole number of minor units by the given fractions (which add up to 1), in whole units:
 * each part is rounded down and the units left over go to the largest remainders, so the parts
 * always add up to the total exactly.
 */
export function splitMinor(total: number, fractions: number[]): number[] {
  const raw = fractions.map((f) => total * f);
  const parts = raw.map(Math.floor);
  let left = total - parts.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) parts[order[k][1]]++;
  return parts;
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
  private readonly serviceBuckets = new Map<
    string,
    { total: Tally; countries: Map<string, Tally>; currencies: Map<string, Tally>; rows: Map<string, Tally>; items: Set<string> }
  >();
  private scanned = 0;

  constructor(
    private readonly baseCurrency: string,
    private readonly fxSource: string,
    /** Which service (tax code) each invoice line belongs to. */
    private readonly classify: Classify = unknownClass,
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

    const split = [...serviceFractions(f.lines, this.classify)];
    const minor = splitMinor(
      f.amountPaid,
      split.map(([, s]) => s.fraction),
    );
    split.forEach(([service, { fraction, items }], i) => {
      let sb = this.serviceBuckets.get(service);
      if (!sb) this.serviceBuckets.set(service, (sb = { total: tally(), countries: new Map(), currencies: new Map(), rows: new Map(), items: new Set() }));
      for (const item of items) sb.items.add(item);
      const at = <K>(m: Map<K, Tally>, k: K) => m.get(k) ?? (m.set(k, tally()), m.get(k)!);
      const perCurrency = [at(sb.currencies, currency), at(sb.rows, key)];
      for (const t of [sb.total, at(sb.countries, country), ...perCurrency]) {
        t.baseAmount += baseAmount * fraction;
        t.invoiceCount++;
        if (f.customerId) t.customers.add(f.customerId);
      }
      for (const t of perCurrency) t.amountMinor += minor[i];
    });
  }

  /** Services (tax codes) seen so far. */
  serviceKeys(): string[] {
    return [...this.serviceBuckets.keys()];
  }

  get invoicesScanned(): number {
    return this.scanned;
  }

  /** @param taxCodeNames tax code ID → name, for the service view. */
  report(query: RevenueQuery, taxCodeNames: ReadonlyMap<string, string> = new Map()): RevenueReport {
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

    const services: ServiceTotal[] = [...this.serviceBuckets]
      .map(([key, { total, countries, currencies, rows, items }]) => ({
        key,
        name: serviceName(key, taxCodeNames),
        items: [...items].sort(),
        byCurrency: [...currencies]
          .map(([currency, t]) => ({
            currency,
            exponent: minorUnitExponent(currency),
            amountMinor: t.amountMinor,
            baseAmount: t.baseAmount,
            invoiceCount: t.invoiceCount,
            customerCount: t.customers.size,
          }))
          .sort((a, b) => a.currency.localeCompare(b.currency)),
        rows: [...rows]
          .map(([k, t]) => {
            const [country, currency] = k.split('|');
            return {
              country,
              currency,
              amountMinor: t.amountMinor,
              exponent: minorUnitExponent(currency),
              baseAmount: t.baseAmount,
              invoiceCount: t.invoiceCount,
              customerCount: t.customers.size,
            };
          })
          .sort((a, b) => a.currency.localeCompare(b.currency) || b.amountMinor - a.amountMinor || a.country.localeCompare(b.country)),
        baseAmount: total.baseAmount,
        share: baseTotal > 0 ? total.baseAmount / baseTotal : 0,
        invoiceCount: total.invoiceCount,
        customerCount: total.customers.size,
        countries: [...countries]
          .map(([country, t]) => ({
            country,
            baseAmount: t.baseAmount,
            share: total.baseAmount > 0 ? t.baseAmount / total.baseAmount : 0,
            invoiceCount: t.invoiceCount,
            customerCount: t.customers.size,
          }))
          .sort((a, b) => b.baseAmount - a.baseAmount || a.country.localeCompare(b.country)),
      }))
      .sort((a, b) => b.baseAmount - a.baseAmount || a.name.localeCompare(b.name));

    return {
      rows,
      totalsByCurrency,
      countries,
      services,
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
  if (view === 'service-eur') return servicesToCsv(report);
  if (view === 'service') return serviceCurrencyRowsToCsv(report);
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

/** One row per service and country; service totals are the sum of a service's rows. */
function servicesToCsv(report: RevenueReport): string {
  const base = report.baseCurrency.toLowerCase();
  const exp = minorUnitExponent(base);
  const lines = [['service', 'tax_code', 'country', `revenue_${base}`, 'share_of_service', 'share_of_total', 'invoices', 'customers'].join(',')];
  for (const s of report.services) {
    const taxCode = s.key.startsWith('txcd_') ? s.key : '';
    for (const c of s.countries) {
      lines.push(
        [s.name, taxCode, c.country, c.baseAmount.toFixed(exp), c.share.toFixed(4), (report.baseTotal > 0 ? c.baseAmount / report.baseTotal : 0).toFixed(4), c.invoiceCount, c.customerCount]
          .map(csvEscape)
          .join(','),
      );
    }
  }
  return lines.join('\n') + '\n';
}

/** One row per service, country and currency, in the invoice currency (and converted). */
function serviceCurrencyRowsToCsv(report: RevenueReport): string {
  const base = report.baseCurrency.toLowerCase();
  const lines = [['service', 'tax_code', 'country', 'currency', 'revenue', 'revenue_minor_units', `revenue_${base}`, 'invoices', 'customers'].join(',')];
  for (const s of report.services) {
    const taxCode = s.key.startsWith('txcd_') ? s.key : '';
    for (const r of s.rows) {
      lines.push(
        [s.name, taxCode, r.country, r.currency.toUpperCase(), toMajorUnits(r.amountMinor, r.currency).toFixed(r.exponent), r.amountMinor, r.baseAmount.toFixed(minorUnitExponent(base)), r.invoiceCount, r.customerCount]
          .map(csvEscape)
          .join(','),
      );
    }
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
