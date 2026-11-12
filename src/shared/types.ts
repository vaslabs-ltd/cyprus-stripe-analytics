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

/** One country's part of a group's revenue. */
export interface GroupCountryRevenue {
  country: string;
  /** Major units of the base currency. */
  baseAmount: number;
  /** Fraction (0..1) of the group's revenue. */
  share: number;
  invoiceCount: number;
  customerCount: number;
}

/**
 * Revenue for one group of a breakdown:
 * - service: a Stripe tax code (the product's, else the account default),
 * - product: a Stripe product (or a line description, for lines without one),
 * - client: a Stripe customer,
 * - contractor: a contractor set in Options, from the products assigned to them.
 * For services and products, each paid invoice is split across its lines in proportion to their net
 * amounts; for clients, invoices are kept whole.
 */
export interface GroupTotal {
  /**
   * service: the tax code ID (txcd_…), or 'none', 'unknown' or 'unsplit'; product: the product ID,
   * 'line:<description>' or 'unsplit'; client: the customer ID or 'none'; contractor: the contractor
   * ID, 'unassigned' or 'unsplit'.
   */
  key: string;
  /** Tax code, product or customer name (the ID if the name can't be read). */
  name: string;
  /** service, contractor: products (or line descriptions) billed under it; client: products bought; product: none. Sorted. */
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
  /** Invoices with at least one line in this group. */
  invoiceCount: number;
  customerCount: number;
  /** Largest first. */
  countries: GroupCountryRevenue[];
  /**
   * Contractors only: the contractor broken down by product and by client, largest first. Their
   * `share` is of the contractor's revenue (in the base currency), not of all revenue.
   */
  sub?: Record<ContractorBreakdown, GroupTotal[]>;
}

/** What a contractor's rows are broken down by, besides country. */
export type ContractorBreakdown = 'product' | 'client';

/** One invoice's part of one product (product key as in the product view). */
export interface ProductPart {
  /** Index of the invoice in the report, to count each invoice once per contractor. */
  invoice: number;
  product: string;
  /** Product name, or '' for an invoice without line items. */
  name: string;
  customerId: string | null;
  country: string;
  currency: string;
  amountMinor: number;
  baseAmount: number;
}

/** What the revenue report is grouped by. */
export type ReportGrouping = 'country' | 'service' | 'product' | 'client' | 'contractor';

/**
 * currency/eur: by country, in invoice currencies or converted; <grouping>/<grouping>-eur: by tax
 * code, product or client, each split by country.
 */
export type ReportView = 'currency' | 'eur' | `${Exclude<ReportGrouping, 'country'>}` | `${Exclude<ReportGrouping, 'country'>}-eur`;

export interface RevenueReport {
  rows: CountryCurrencyRevenue[];
  totalsByCurrency: CurrencyTotal[];
  /** One row per country, all currencies converted to the base currency (largest first). */
  countries: CountryTotal[];
  /** One row per service (largest first), each split by country. */
  services: GroupTotal[];
  /** One row per product (largest first), each split by country. */
  products: GroupTotal[];
  /** One row per client (customer, largest first), each split by country. */
  clients: GroupTotal[];
  /** One row per contractor (largest first), plus unassigned products, each split by country. */
  contractors: GroupTotal[];
  /**
   * Each invoice's part of each product, so contractors can be worked out again when assignments
   * change, without calling Stripe. Missing in sessions saved by older versions.
   */
  productParts?: ProductPart[];
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

/** Someone products can be assigned to, for the contractor breakdown. */
export interface Contractor {
  /** Generated, stable ID (renaming keeps the assignments). */
  id: string;
  name: string;
}

export interface Settings {
  vatFetch: VatFetchSettings;
  contractors: Contractor[];
  /** Stripe product ID → contractor ID. Products not listed are unassigned. */
  productContractors: Record<string, string>;
  /** Names of the assigned products, so Options can show them before (or without) loading products from Stripe. */
  productNames: Record<string, string>;
}

/** A Stripe product, for assigning products to contractors in Options. */
export interface ProductInfo {
  id: string;
  name: string;
  /** False for archived products. */
  active: boolean;
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
   * demo: the demo key was entered, reports show generated data;
   * locked: the key is encrypted with the PIN and the PIN hasn't been entered.
   */
  state: 'ok' | 'missing' | 'invalid' | 'demo' | 'locked';
  /** The .env file a key entered in the app is saved to. */
  configFile: string;
}

/** PIN and last session state (Options and the unlock prompt). */
export interface SessionStatus {
  /** False when a PIN can't be set yet (no usable Stripe key); `reason` says why. */
  available: boolean;
  reason?: string;
  pinSet: boolean;
  /** The Stripe key is stored encrypted with the PIN (and not in the .env file). */
  encryptsKey: boolean;
  /** A saved session is waiting to be unlocked or restored. */
  hasSession: boolean;
  /** The PIN has been entered (or set) since the app started. */
  unlocked: boolean;
  /** Null when the Stripe key can be encrypted, else why not (e.g. it comes from an environment variable). */
  keyNotEncryptable: string | null;
}

/** What the Revenue tab showed: the form, the view and the report. */
export interface SavedRevenue {
  form: { from: string; to: string; quarter: string; year: string; currency: string; grouping: ReportGrouping; eur: boolean; breakdown?: 'country' | ContractorBreakdown };
  report: RevenueReport;
}

/** What the Cyprus VAT tab showed. */
export interface SavedVat {
  form: { scheme: string; period: string };
  report: VatReport;
}

/** The last session, restored after a restart (encrypted with the PIN). */
export interface SavedSession {
  version: 1;
  savedAt: string;
  /** ID of the selected tab. */
  tab?: string;
  revenue?: SavedRevenue;
  vat?: SavedVat;
}

export interface StripeAnalyticsApi {
  keyStatus(): Promise<KeyStatus>;
  /**
   * Checks the key against Stripe (read-only calls), then saves it and reloads the window.
   * Returns the file it was saved to, or null for the demo key (which is never saved).
   */
  saveKey(key: string): Promise<IpcResult<string | null>>;
  revenueByCountry(query: RevenueQuery): Promise<IpcResult<RevenueReport>>;
  /** `breakdown`: for the contractor view, rows per product or client instead of per country. */
  exportCsv(report: RevenueReport, view: ReportView, breakdown?: 'country' | ContractorBreakdown): Promise<IpcResult<string | null>>;
  vatReport(query: VatQuery): Promise<IpcResult<VatReport>>;
  exportVatCsv(report: VatReport): Promise<IpcResult<string | null>>;
  onProgress(cb: (p: Progress) => void): () => void;
  /** `file` is null in demo mode, where settings are kept in memory only. */
  getSettings(): Promise<IpcResult<{ settings: Settings; file: string | null }>>;
  /** All products in Stripe (active first, then archived), for assigning them to contractors. */
  listProducts(): Promise<IpcResult<ProductInfo[]>>;
  sessionStatus(): Promise<SessionStatus>;
  /** Unlocks with the PIN: decrypts the Stripe key (if encrypted) and returns the last session. */
  unlockSession(pin: string): Promise<IpcResult<SavedSession | null>>;
  /** The last session while unlocked (e.g. after a window reload), else null. */
  restoreSession(): Promise<SavedSession | null>;
  /** Saves the session, encrypted; does nothing without a PIN or in demo mode. */
  saveSession(session: SavedSession): Promise<boolean>;
  /** Sets or changes the PIN, or turns encrypting the Stripe key on or off (current PIN needed once set). */
  setPin(opts: { currentPin?: string; pin?: string; encryptStripeKey: boolean }): Promise<IpcResult<SessionStatus>>;
  removePin(currentPin: string): Promise<IpcResult<SessionStatus>>;
  /** Forgot the PIN: deletes the PIN, the session and an encrypted Stripe key. */
  resetPin(): Promise<IpcResult<null>>;
  /** The report's contractors worked out again for the current assignments in Options. */
  regroupContractors(report: RevenueReport): Promise<IpcResult<RevenueReport>>;
  /** Forgets the PIN until it's entered again, and reloads the window. */
  lockNow(): Promise<void>;
  /** Validates and saves; returns what was saved. */
  saveSettings(settings: Settings): Promise<IpcResult<Settings>>;
}
