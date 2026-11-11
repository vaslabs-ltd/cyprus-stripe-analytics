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

/** One country's part of a service's revenue. */
export interface ServiceCountryRevenue {
  country: string;
  /** Major units of the base currency. */
  baseAmount: number;
  /** Fraction (0..1) of the service's revenue. */
  share: number;
  invoiceCount: number;
  customerCount: number;
}

/**
 * Revenue for one service: a Stripe tax code (the product's, else the account default). Each paid
 * invoice is split across its lines in proportion to their net amounts.
 */
export interface ServiceTotal {
  /** The tax code ID (txcd_…), or 'none', 'unknown' or 'unsplit'. */
  key: string;
  /** Tax code name, e.g. "General - Services" (the ID if the name can't be read). */
  name: string;
  /** Products (or line descriptions) billed under this tax code, sorted. */
  items: string[];
  /**
   * Totals in each invoice currency. Each invoice's amount is split across its tax codes in whole
   * minor units, so these add up exactly to the per-currency totals.
   */
  byCurrency: Array<{ currency: string; exponent: number; amountMinor: number; baseAmount: number; invoiceCount: number; customerCount: number }>;
  /** One row per country and invoice currency (by currency, then largest first). */
  rows: CountryCurrencyRevenue[];
  /** Major units of the base currency. */
  baseAmount: number;
  /** Fraction (0..1) of all revenue, measured in the base currency. */
  share: number;
  /** Invoices with at least one line for this service. */
  invoiceCount: number;
  customerCount: number;
  /** Largest first. */
  countries: ServiceCountryRevenue[];
}

/** currency/eur: by country, in invoice currencies or converted; service/service-eur: by tax code. */
export type ReportView = 'currency' | 'eur' | 'service' | 'service-eur';

export interface RevenueReport {
  rows: CountryCurrencyRevenue[];
  totalsByCurrency: CurrencyTotal[];
  /** One row per country, all currencies converted to the base currency (largest first). */
  countries: CountryTotal[];
  /** One row per service (largest first), each split by country. */
  services: ServiceTotal[];
  /** Set when tax codes couldn't all be read, e.g. the key has no access to Products. */
  servicesNote?: string;
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
  /** What is being fetched, sent once before the first page (VAT report). */
  scope?: FetchScope;
}

/** Stripe invoice statuses. */
export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'uncollectible' | 'void';

/**
 * How the VAT report fetches invoices from Stripe. Stripe can only filter invoices by
 * `created` and `status`, not by the invoice date (`effective_at`), so a wider search
 * finds invoices finalized or back-dated into the period, at the cost of fetching more.
 */
export interface VatFetchSettings {
  /** Statuses to fetch and include in the report (at least one). */
  statuses: InvoiceStatus[];
  /** Also fetch invoices created this many days before the period starts. */
  lookbackDays: number;
  /** Also fetch invoices created after the period ends, up to yesterday. */
  includeCreatedAfter: boolean;
}

export interface Settings {
  vatFetch: VatFetchSettings;
}

/** The `created` window and statuses one report fetched. */
export interface FetchScope {
  /** Inclusive, ISO dates (UTC). */
  createdFrom: string;
  createdTo: string;
  statuses: InvoiceStatus[];
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Cyprus VAT report sections: domestic (CY VAT), EU B2B (VIES, reverse charge), rest of the world. */
export type VatSection = 'cy' | 'vies' | 'intl';

export interface VatQuery {
  /** Inclusive start, ISO date (YYYY-MM-DD), UTC. */
  from: string;
  /** Inclusive end, ISO date (YYYY-MM-DD), UTC. */
  to: string;
}

/** One finalized invoice, dated by its invoice date (the VAT tax point). EUR amounts are in cents. */
export interface VatInvoice {
  id: string;
  /** Invoice number as printed on the invoice. */
  number: string | null;
  /** Invoice date (YYYY-MM-DD, UTC). */
  date: string;
  /** YYYY-MM of `date`; VIES is reported per month. */
  month: string;
  /** Stripe status: paid, open or uncollectible (draft and void only when enabled in Options). */
  status: string;
  customerId: string | null;
  customerName: string | null;
  /** ISO country code, or "??" when unknown. */
  country: string;
  /** Customer VAT number snapshotted on the invoice (EU VAT number preferred). */
  vatNumber: string | null;
  section: VatSection;
  /** Lower-case invoice currency. */
  currency: string;
  exponent: number;
  /** Invoice total including VAT, in the invoice currency's minor units. */
  totalMinor: number;
  /**
   * Stripe's taxability reasons on the invoice (e.g. standard_rated, product_exempt,
   * reverse_charge), deduplicated. Empty when no tax was calculated.
   */
  taxReasons: string[];
  netEurCents: number;
  vatEurCents: number;
  /** netEurCents + vatEurCents. */
  grossEurCents: number;
  /** Things to double-check before filing, e.g. VAT charged on a reverse-charge invoice. */
  warnings: string[];
}

export interface VatSectionSummary {
  section: VatSection;
  invoiceCount: number;
  customerCount: number;
  netEurCents: number;
  vatEurCents: number;
  grossEurCents: number;
  /** VAT on invoices that have been paid (collected). */
  vatPaidEurCents: number;
  /** Net sales on invoices with no VAT (0% rated or exempt). */
  noVatNetEurCents: number;
  /** Invoices still open or marked uncollectible. */
  unpaidCount: number;
}

/** A VIES listing line: one customer (VAT number) in one month. */
export interface ViesLine {
  country: string;
  vatNumber: string | null;
  customerName: string | null;
  netEurCents: number;
  invoiceCount: number;
}

export interface ViesMonth {
  /** YYYY-MM. */
  month: string;
  netEurCents: number;
  invoiceCount: number;
  lines: ViesLine[];
}

export interface VatReport {
  /** The period actually covered (`to` is clipped to yesterday). */
  query: VatQuery;
  invoices: VatInvoice[];
  summaries: Record<VatSection, VatSectionSummary>;
  /** Every month of the period, in order, including months without EU sales. */
  viesMonths: ViesMonth[];
  fxSource: string;
  /** Invoices fetched from Stripe (including ones dated outside the period). */
  invoicesScanned: number;
  /** What was fetched from Stripe. */
  scope: FetchScope;
  generatedAt: string;
}

export interface KeyStatus {
  /**
   * missing: no key set; invalid: a key is set but it isn't a restricted (rk_) key;
   * demo: the demo key was entered, reports show generated data.
   */
  state: 'ok' | 'missing' | 'invalid' | 'demo';
  /** The .env file a key entered in the app is saved to. */
  configFile: string;
}

export interface StripeAnalyticsApi {
  keyStatus(): Promise<KeyStatus>;
  /**
   * Checks the key against Stripe (read-only calls), then saves it and reloads the window.
   * Returns the file it was saved to, or null for the demo key (which is never saved).
   */
  saveKey(key: string): Promise<IpcResult<string | null>>;
  revenueByCountry(query: RevenueQuery): Promise<IpcResult<RevenueReport>>;
  exportCsv(report: RevenueReport, view: ReportView): Promise<IpcResult<string | null>>;
  vatReport(query: VatQuery): Promise<IpcResult<VatReport>>;
  exportVatCsv(report: VatReport): Promise<IpcResult<string | null>>;
  onProgress(cb: (p: Progress) => void): () => void;
  getSettings(): Promise<IpcResult<{ settings: Settings; file: string }>>;
  /** Validates and saves; returns what was saved. */
  saveSettings(settings: Settings): Promise<IpcResult<Settings>>;
}
