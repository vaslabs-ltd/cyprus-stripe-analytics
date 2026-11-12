import type { ContractorBreakdown, CountryCurrencyRevenue, CountryTotal, GroupTotal, ProductPart, ReportGrouping, ReportView, RevenueReport, RevenueQuery } from '../shared/types';

/** Minimal shape of the invoice data the aggregation needs (decoupled from the Stripe SDK). */
export interface InvoiceFact {
  customerId: string | null;
  /** Name shown for the customer in the client view (name, else email). */
  customerName?: string | null;
  currency: string;
  /** What was paid, VAT included, in minor units. */
  amountPaid: number;
  /** What was paid without VAT, in minor units (see paidExcludingTax). */
  amountPaidExclTax?: number;
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
  /** Key for the product view: the product ID, else the line description. Derived from the line if unset. */
  product?: string;
  /** Product name for the product view (without the "(account default)" note). Defaults to the line's. */
  productName?: string;
}
export type Classify = (l: LineFact) => LineClass;

/** Service of an invoice with no line amounts to split it by. */
export const UNSPLIT_SERVICE = 'unsplit';
/** Neither the product nor the account has a tax code. */
export const NO_TAX_CODE = 'none';
/** The tax code couldn't be read (no access to Products or Tax settings). */
export const UNKNOWN_TAX_CODE = 'unknown';

export const lineItem = (l: LineFact) => (l.description ?? '').trim() || l.product || 'Line without a description';
const unknownClass: Classify = (l) => ({ service: UNKNOWN_TAX_CODE, item: lineItem(l) });

/** Product view key and name of a classified line. */
export function productOf(l: LineFact, c: LineClass): { key: string; name: string } {
  const name = c.productName ?? lineItem(l);
  return { key: c.product ?? l.product ?? `line:${name}`, name };
}

/** Customer key for invoices without a customer. */
export const NO_CUSTOMER = 'none';
/** Contractor key for lines whose product isn't assigned to anyone (or that have no product). */
export const UNASSIGNED = 'unassigned';

/** Contractors from Options: their names, and which contractor each product is assigned to. */
export interface ContractorMap {
  /** Contractor ID → name. */
  names: ReadonlyMap<string, string>;
  /** Product ID → contractor ID. */
  byProduct: ReadonlyMap<string, string>;
}
export const NO_CONTRACTORS: ContractorMap = { names: new Map(), byProduct: new Map() };

/**
 * How an invoice's revenue splits across groups (e.g. services): each group gets the fraction of the
 * invoice's net line amounts that its lines make up. Fractions add up to 1. An invoice without lines,
 * or whose lines add up to zero or less, goes to UNSPLIT_SERVICE whole.
 */
export function splitFractions(
  lines: LineFact[] | undefined,
  group: (l: LineFact) => { key: string; item: string },
): Map<string, { fraction: number; items: Set<string> }> {
  const byKey = new Map<string, { amount: number; items: Set<string> }>();
  for (const l of lines ?? []) {
    const { key: service, item } = group(l);
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

/** Fractions per service (tax code); see splitFractions. */
export function serviceFractions(lines: LineFact[] | undefined, classify: Classify): Map<string, { fraction: number; items: Set<string> }> {
  return splitFractions(lines, (l) => {
    const c = classify(l);
    return { key: c.service, item: c.item };
  });
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
const at = <K>(m: Map<K, Tally>, k: K) => m.get(k) ?? (m.set(k, tally()), m.get(k)!);

/** One invoice's part of a group: its fraction of the invoice and the items behind it. */
export interface GroupPart {
  key: string;
  fraction: number;
  items: Iterable<string>;
}

/**
 * Revenue grouped by some key (service, product, client), each group split by country and by
 * invoice currency. An invoice can be split across several groups by fractions that add up to 1;
 * its amount is split in whole minor units, so per currency the groups add up exactly.
 */
class GroupBuckets {
  private readonly buckets = new Map<
    string,
    { total: Tally; countries: Map<string, Tally>; currencies: Map<string, Tally>; rows: Map<string, Tally>; items: Set<string>; names: Set<string> }
  >();

  /** Splits one invoice across the parts; returns each part's amount in minor units. */
  add(parts: GroupPart[], f: InvoiceFact, country: string, currency: string, baseAmount: number, name?: (key: string) => string | undefined): number[] {
    const minor = splitMinor(
      f.amountPaid,
      parts.map((p) => p.fraction),
    );
    parts.forEach(({ key, fraction, items }, i) =>
      this.addPart(key, items, f.customerId, country, currency, minor[i], baseAmount * fraction, name?.(key)),
    );
    return minor;
  }

  /** One invoice's (already split) part of one group. */
  addPart(key: string, items: Iterable<string>, customerId: string | null, country: string, currency: string, amountMinor: number, baseAmount: number, name?: string): void {
    let b = this.buckets.get(key);
    if (!b) this.buckets.set(key, (b = { total: tally(), countries: new Map(), currencies: new Map(), rows: new Map(), items: new Set(), names: new Set() }));
    for (const item of items) b.items.add(item);
    if (name) b.names.add(name);
    const perCurrency = [at(b.currencies, currency), at(b.rows, `${country}|${currency}`)];
    for (const t of [b.total, at(b.countries, country), ...perCurrency]) {
      t.baseAmount += baseAmount;
      t.invoiceCount++;
      if (customerId) t.customers.add(customerId);
    }
    for (const t of perCurrency) t.amountMinor += amountMinor;
  }

  keys(): string[] {
    return [...this.buckets.keys()];
  }

  /** @param name display name of a group, given the names seen for it while adding (if any). */
  totals(baseTotal: number, name: (key: string, seen: string[]) => string): GroupTotal[] {
    return [...this.buckets]
      .map(([key, { total, countries, currencies, rows, items, names }]) => ({
        key,
        name: name(key, [...names]),
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
  }
}

const toParts = (m: Map<string, { fraction: number; items: Set<string> }>): GroupPart[] =>
  [...m].map(([key, { fraction, items }]) => ({ key, fraction, items }));

export function productName(key: string, seen: string[]): string {
  if (key === UNSPLIT_SERVICE) return serviceName(key, new Map());
  return seen.sort()[0] ?? key;
}

export function contractorName(key: string, contractors: ContractorMap): string {
  if (key === UNSPLIT_SERVICE) return serviceName(key, new Map());
  if (key === UNASSIGNED) return 'Unassigned';
  return contractors.names.get(key) ?? key;
}

/**
 * Revenue per contractor, from each invoice's split by product: every product's part goes to the
 * contractor it's assigned to (else Unassigned). An invoice counts once per contractor. Each
 * contractor is also broken down by product and by client (`sub`), with shares of the contractor.
 */
export function contractorTotals(
  parts: readonly ProductPart[],
  contractors: ContractorMap,
  baseTotal: number,
  clientNames: ReadonlyMap<string, string> = new Map(),
): GroupTotal[] {
  const groups = new GroupBuckets();
  const subs = new Map<string, { product: GroupBuckets; client: GroupBuckets }>();
  const perInvoice = new Map<string, { p: ProductPart; key: string; minor: number; base: number; items: Set<string> }>();
  for (const p of parts) {
    const key = p.product === UNSPLIT_SERVICE ? UNSPLIT_SERVICE : (contractors.byProduct.get(p.product) ?? UNASSIGNED);
    const k = `${p.invoice}|${key}`;
    const e = perInvoice.get(k) ?? perInvoice.set(k, { p, key, minor: 0, base: 0, items: new Set() }).get(k)!;
    e.minor += p.amountMinor;
    e.base += p.baseAmount;
    if (p.name) e.items.add(p.name);
    const sub = subs.get(key) ?? subs.set(key, { product: new GroupBuckets(), client: new GroupBuckets() }).get(key)!;
    sub.product.addPart(p.product, [], p.customerId, p.country, p.currency, p.amountMinor, p.baseAmount, p.name || undefined);
  }
  for (const { p, key, minor, base, items } of perInvoice.values()) {
    groups.addPart(key, items, p.customerId, p.country, p.currency, minor, base);
    // Per client, an invoice counts once (whatever the number of the contractor's products on it).
    subs.get(key)!.client.addPart(p.customerId ?? NO_CUSTOMER, items, p.customerId, p.country, p.currency, minor, base, p.customerId ? clientNames.get(p.customerId) : undefined);
  }
  return groups.totals(baseTotal, (k) => contractorName(k, contractors)).map((g) => {
    const sub = subs.get(g.key)!;
    return { ...g, sub: { product: sub.product.totals(g.baseAmount, productName), client: sub.client.totals(g.baseAmount, clientName) } };
  });
}

const clientNamesOf = (clients: readonly GroupTotal[]) => new Map(clients.map((c) => [c.key, c.name]));

/** The report with its contractors worked out again for the current assignments (no call to Stripe). */
export function regroupContractors(report: RevenueReport, contractors: ContractorMap): RevenueReport {
  // Reports saved before product parts were kept can't be regrouped.
  const withVat = report.withVat && regroupContractors(report.withVat, contractors);
  if (!Array.isArray(report.productParts)) return withVat ? { ...report, withVat } : report;
  return {
    ...report,
    contractors: contractorTotals(report.productParts, contractors, report.baseTotal, clientNamesOf(report.clients)),
    ...(withVat ? { withVat } : {}),
  };
}

export function clientName(key: string, seen: string[]): string {
  if (key === NO_CUSTOMER) return 'No customer';
  return seen.sort()[0] ?? key;
}

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
  private readonly serviceGroups = new GroupBuckets();
  private readonly productGroups = new GroupBuckets();
  private readonly clientGroups = new GroupBuckets();
  /** Each invoice's split by product, kept in the report so contractors can be regrouped later. */
  private readonly productParts: ProductPart[] = [];
  /** Product view key → name, from the lines classified so far. */
  private readonly productNames = new Map<string, string>();
  private scanned = 0;

  constructor(
    private readonly baseCurrency: string,
    private readonly fxSource: string,
    /** Which service (tax code) and product each invoice line belongs to. */
    private readonly classify: Classify = unknownClass,
    /** Who each product is assigned to, for the contractor view. */
    private readonly contractors: ContractorMap = NO_CONTRACTORS,
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

    const classified = (f.lines ?? []).map((l) => ({ l, c: this.classify(l) }));
    const byLine = new Map(classified.map(({ l, c }) => [l, c]));
    const cls = (l: LineFact) => byLine.get(l)!;
    this.serviceGroups.add(toParts(serviceFractions(f.lines, cls)), f, country, currency, baseAmount);

    const products = toParts(
      splitFractions(f.lines, (l) => {
        const p = productOf(l, cls(l));
        this.productNames.set(p.key, p.name);
        return { key: p.key, item: p.name };
      }),
    );
    // A product's own name is its label: don't also list it under itself.
    for (const p of products) p.items = [];
    const minor = this.productGroups.add(products, f, country, currency, baseAmount, (k) => this.productNames.get(k));
    const invoice = this.scanned - 1;
    products.forEach((p, i) =>
      this.productParts.push({
        invoice,
        product: p.key,
        name: p.key === UNSPLIT_SERVICE ? '' : (this.productNames.get(p.key) ?? p.key),
        customerId: f.customerId,
        country,
        currency,
        amountMinor: minor[i],
        baseAmount: baseAmount * p.fraction,
      }),
    );

    // The client view keeps invoices whole, listing the products they bought.
    const bought = new Set(classified.filter(({ l }) => l.amount !== 0).map(({ l, c }) => productOf(l, c).name));
    const client = f.customerId ?? NO_CUSTOMER;
    const label = (f.customerName ?? '').trim() || undefined;
    this.clientGroups.add([{ key: client, fraction: 1, items: bought }], f, country, currency, baseAmount, () => label);
  }

  /** Services (tax codes) seen so far. */
  serviceKeys(): string[] {
    return this.serviceGroups.keys();
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

    const clients = this.clientGroups.totals(baseTotal, clientName);
    return {
      rows,
      totalsByCurrency,
      countries,
      services: this.serviceGroups.totals(baseTotal, (k) => serviceName(k, taxCodeNames)),
      products: this.productGroups.totals(baseTotal, productName),
      clients,
      contractors: contractorTotals(this.productParts, this.contractors, baseTotal, clientNamesOf(clients)),
      productParts: this.productParts,
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

/** Which grouping a view shows, and whether it's converted to the base currency. */
export function parseView(view: ReportView): { grouping: ReportGrouping; eur: boolean } {
  const [g, e] = view.split('-');
  if (g === 'currency' || g === 'eur') return { grouping: 'country', eur: g === 'eur' };
  return { grouping: g as ReportGrouping, eur: e === 'eur' };
}

/**
 * @param breakdown for contractors: rows per product or client under each contractor, instead of
 *   per country.
 */
export function reportToCsv(report: RevenueReport, view: ReportView = 'currency', breakdown: 'country' | ContractorBreakdown = 'country'): string {
  const { grouping, eur } = parseView(view);
  if (grouping === 'country') return eur ? countriesToCsv(report) : currencyRowsToCsv(report);
  const g = GROUP_CSV[grouping];
  if (grouping === 'contractor' && breakdown !== 'country') return eur ? contractorSubsToCsv(report, g, breakdown) : contractorSubCurrencyRowsToCsv(report, g, breakdown);
  return eur ? groupsToCsv(report, g) : groupCurrencyRowsToCsv(report, g);
}

/** One row per contractor and product (or client), in the base currency. */
function contractorSubsToCsv(report: RevenueReport, g: GroupCsv, by: ContractorBreakdown): string {
  const base = report.baseCurrency.toLowerCase();
  const exp = minorUnitExponent(base);
  const lines = [[g.name, g.idColumn, by, `revenue_${base}`, `share_of_${g.name}`, 'share_of_total', 'invoices', 'customers', `${g.name}_share_of_total`].join(',')];
  for (const c of g.groups(report)) {
    for (const x of c.sub?.[by] ?? []) {
      lines.push(
        [c.name, g.id(c), x.name, x.baseAmount.toFixed(exp), x.share.toFixed(4), (report.baseTotal > 0 ? x.baseAmount / report.baseTotal : 0).toFixed(4), x.invoiceCount, x.customerCount, c.share.toFixed(4)]
          .map(csvEscape)
          .join(','),
      );
    }
  }
  return lines.join('\n') + '\n';
}

/** One row per contractor, product (or client) and currency, in the invoice currency (and converted). */
function contractorSubCurrencyRowsToCsv(report: RevenueReport, g: GroupCsv, by: ContractorBreakdown): string {
  const base = report.baseCurrency.toLowerCase();
  const lines = [[g.name, g.idColumn, by, 'currency', 'revenue', 'revenue_minor_units', `revenue_${base}`, 'invoices', 'customers', `${g.name}_share_of_total`].join(',')];
  for (const c of g.groups(report)) {
    for (const x of c.sub?.[by] ?? []) {
      for (const t of x.byCurrency) {
        lines.push(
          [c.name, g.id(c), x.name, t.currency.toUpperCase(), toMajorUnits(t.amountMinor, t.currency).toFixed(t.exponent), t.amountMinor, t.baseAmount.toFixed(minorUnitExponent(base)), t.invoiceCount, t.customerCount, c.share.toFixed(4)]
            .map(csvEscape)
            .join(','),
        );
      }
    }
  }
  return lines.join('\n') + '\n';
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

/** CSV columns of a grouping: its name column, its ID column and how to read a group's ID. */
interface GroupCsv {
  groups: (r: RevenueReport) => GroupTotal[];
  name: string;
  idColumn: string;
  id: (g: GroupTotal) => string;
  /** Leave out share_of_<group> (a client's countries are rarely more than one). */
  noGroupShare?: boolean;
}

const GROUP_CSV: Record<Exclude<ReportGrouping, 'country'>, GroupCsv> = {
  service: { groups: (r) => r.services, name: 'service', idColumn: 'tax_code', id: (g) => (g.key.startsWith('txcd_') ? g.key : '') },
  product: { groups: (r) => r.products, name: 'product', idColumn: 'product_id', id: (g) => (g.key.startsWith('prod_') ? g.key : '') },
  client: { groups: (r) => r.clients, name: 'client', idColumn: 'customer_id', id: (g) => (g.key.startsWith('cus_') ? g.key : ''), noGroupShare: true },
  contractor: {
    groups: (r) => r.contractors,
    name: 'contractor',
    idColumn: 'products',
    // The products behind each contractor's revenue, so the CSV says what was counted.
    id: (g) => g.items.join('; '),
  },
};

/** One row per group and country; group totals are the sum of a group's rows. */
function groupsToCsv(report: RevenueReport, g: GroupCsv): string {
  const base = report.baseCurrency.toLowerCase();
  const exp = minorUnitExponent(base);
  const groupShare = (v: string) => (g.noGroupShare ? [] : [v]);
  const lines = [[g.name, g.idColumn, 'country', `revenue_${base}`, ...groupShare(`share_of_${g.name}`), 'share_of_total', 'invoices', 'customers', `${g.name}_share_of_total`].join(',')];
  for (const s of g.groups(report)) {
    for (const c of s.countries) {
      lines.push(
        [s.name, g.id(s), c.country, c.baseAmount.toFixed(exp), ...groupShare(c.share.toFixed(4)), (report.baseTotal > 0 ? c.baseAmount / report.baseTotal : 0).toFixed(4), c.invoiceCount, c.customerCount, s.share.toFixed(4)]
          .map(csvEscape)
          .join(','),
      );
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * One row per group, country and currency, in the invoice currency (and converted). The last column
 * is the group's share of all revenue (compared in the base currency), the same on each of its rows.
 */
function groupCurrencyRowsToCsv(report: RevenueReport, g: GroupCsv): string {
  const base = report.baseCurrency.toLowerCase();
  const lines = [[g.name, g.idColumn, 'country', 'currency', 'revenue', 'revenue_minor_units', `revenue_${base}`, 'invoices', 'customers', `${g.name}_share_of_total`].join(',')];
  for (const s of g.groups(report)) {
    for (const r of s.rows) {
      lines.push(
        [s.name, g.id(s), r.country, r.currency.toUpperCase(), toMajorUnits(r.amountMinor, r.currency).toFixed(r.exponent), r.amountMinor, r.baseAmount.toFixed(minorUnitExponent(base)), r.invoiceCount, r.customerCount, s.share.toFixed(4)]
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
