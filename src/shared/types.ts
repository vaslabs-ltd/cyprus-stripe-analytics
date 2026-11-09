/** Types shared between the main process and the renderer (type-only, no runtime code). */

export interface RevenueQuery {
  /** Inclusive start, ISO date (YYYY-MM-DD), interpreted as UTC. */
  from?: string;
  /** Inclusive end, ISO date (YYYY-MM-DD), interpreted as UTC. */
  to?: string;
}

export interface CountryCurrencyRevenue {
  /** ISO 3166-1 alpha-2 country code, or "??" when unknown. */
  country: string;
  /** Lower-case ISO 4217 currency code as returned by Stripe. */
  currency: string;
  /** Sum of amount_paid in the currency's smallest unit (e.g. cents). */
  amountMinor: number;
  /** Number of decimal places for this currency in Stripe (0, 2 or 3). */
  exponent: number;
  /** Revenue converted to the report's base currency, in major units (e.g. euros). */
  baseAmount: number;
  invoiceCount: number;
  customerCount: number;
}

export interface CurrencyTotal {
  currency: string;
  amountMinor: number;
  exponent: number;
  /** Total converted to the base currency, major units. */
  baseAmount: number;
  /** Fraction (0..1) of all revenue, measured in the base currency. */
  share: number;
  invoiceCount: number;
}

/** All of a country's revenue, every currency converted to the base currency. */
export interface CountryTotal {
  country: string;
  /** Major units of the base currency. */
  baseAmount: number;
  /** Fraction (0..1) of all revenue, measured in the base currency. */
  share: number;
  invoiceCount: number;
  /** Distinct customers across all currencies. */
  customerCount: number;
  /** Lower-case currency codes this country paid in. */
  currencies: string[];
}

export type ReportView = 'currency' | 'eur';

export interface RevenueReport {
  rows: CountryCurrencyRevenue[];
  totalsByCurrency: CurrencyTotal[];
  /** One row per country, all currencies converted to the base currency (largest first). */
  countries: CountryTotal[];
  /** Lower-case currency code all amounts are converted to for comparison. */
  baseCurrency: string;
  /** Sum of all revenue in the base currency, major units. */
  baseTotal: number;
  /** Where the exchange rates come from. */
  fxSource: string;
  invoicesScanned: number;
  /** How the country was resolved, for transparency. */
  countrySources: { customerAddress: number; invoiceSnapshot: number; shipping: number; unknown: number };
  generatedAt: string;
  query: RevenueQuery;
}

export interface Progress {
  invoicesScanned: number;
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface StripeAnalyticsApi {
  revenueByCountry(query: RevenueQuery): Promise<IpcResult<RevenueReport>>;
  exportCsv(report: RevenueReport, view: ReportView): Promise<IpcResult<string | null>>;
  onProgress(cb: (p: Progress) => void): () => void;
}
