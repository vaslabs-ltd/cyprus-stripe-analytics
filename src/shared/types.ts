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
  invoiceCount: number;
  customerCount: number;
}

export interface RevenueReport {
  rows: CountryCurrencyRevenue[];
  totalsByCurrency: { currency: string; amountMinor: number; exponent: number; invoiceCount: number }[];
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
  exportCsv(report: RevenueReport): Promise<IpcResult<string | null>>;
  onProgress(cb: (p: Progress) => void): () => void;
}
