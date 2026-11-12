import Stripe from 'stripe';
import type { FetchScope, InvoiceStatus, ProductInfo, Progress, RevenueQuery, RevenueReport, VatFetchSettings, VatQuery, VatReport } from '../shared/types';
import { lineItem, NO_CONTRACTORS, NO_TAX_CODE, RevenueAggregator, type ContractorMap, toMajorUnits, UNKNOWN_TAX_CODE, type Classify, type InvoiceFact, type LineFact } from './analytics';
import { assertSupportedCurrency, BASE_CURRENCY, FX_SOURCE, isoDate, type FxRateStore } from './fx';
import { buildVatReport, type VatInvoiceFact } from './vat';
import { DEFAULT_SETTINGS, INVOICE_STATUSES } from './settings';

/**
 * Only restricted keys (rk_...) are accepted. A standard secret key (sk_...) has full
 * write access to the account, which this app never needs.
 */
export const isRestrictedKey = (key: string | undefined): key is string => !!key && /^rk_(live|test)_/.test(key);

export function createStripeClient(key: string | undefined): Stripe {
  if (!key) throw new Error('No Stripe key set. Enter a restricted, read-only key with "Stripe key…".');
  if (!isRestrictedKey(key)) {
    throw new Error('Refusing to use a non-restricted Stripe key. Create a restricted key with read-only access to Invoices and Customers.');
  }
  return new Stripe(key, { maxNetworkRetries: 3, appInfo: { name: 'stripe-analytics' } });
}

/** Make one read call per resource the reports need, so a wrong or under-permissioned key fails now. */
export async function checkKeyAccess(stripe: Stripe): Promise<void> {
  try {
    await stripe.invoices.list({ limit: 1 });
    await stripe.customers.list({ limit: 1 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Stripe rejected the key: ${msg}`);
  }
}

/** The invoice fields the reports read. A Stripe invoice (with `customer` expanded) fits it. */
export interface InvoiceLike {
  id: string;
  number: string | null;
  status: string | null;
  created: number;
  effective_at: number | null;
  status_transitions: { paid_at: number | null; finalized_at: number | null };
  currency: string;
  amount_paid: number;
  total: number;
  total_taxes: Array<{ amount: number; taxability_reason: string }> | null;
  customer: string | CustomerLike | null;
  customer_name: string | null;
  customer_email: string | null;
  customer_tax_ids?: Array<{ type: string; value: string | null }> | null;
  customer_address: { country: string | null } | null;
  /** The first page of line items (Stripe embeds up to 10). */
  lines?: { data: LineItemLike[]; has_more: boolean };
}

/** The invoice line item fields the service split reads. */
export interface LineItemLike {
  amount: number;
  description: string | null;
  discount_amounts?: Array<{ amount: number }> | null;
  pricing: { price_details?: { product: string } } | null;
}

export interface ProductLike {
  id: string;
  name: string;
  /** False for archived products. */
  active?: boolean;
  tax_code?: string | { id: string } | null;
}

/**
 * Line items, products and tax codes, for splitting revenue by service. Stripe keeps the tax code
 * on the product (invoice lines don't carry one); lines whose product has none are taxed with the
 * account's default tax code (Tax settings).
 */
export interface ServiceSource {
  /** All line items of one invoice, for invoices whose embedded list was cut short. */
  lineItems(invoiceId: string): AsyncIterable<LineItemLike>;
  /** All products, active and archived. */
  products(): AsyncIterable<ProductLike>;
  /** The account's default tax code (Tax settings), or null when none is set. */
  defaultTaxCode(): Promise<string | null>;
  /** A tax code's name, e.g. "General - Services". */
  taxCodeName(id: string): Promise<string>;
}

export const stripeServiceSource = (stripe: Stripe): ServiceSource => ({
  lineItems: (id) => stripe.invoices.listLineItems(id, { limit: 100 }),
  products: () => stripe.products.list({ limit: 100 }),
  defaultTaxCode: async () => (await stripe.tax.settings.retrieve()).defaults.tax_code,
  taxCodeName: async (id) => (await stripe.taxCodes.retrieve(id)).name,
});

export interface CustomerLike {
  id: string;
  deleted?: unknown;
  name?: string | null;
  email?: string | null;
  address?: { country: string | null } | null;
  shipping?: { address?: { country: string | null } } | null;
}

export interface InvoiceListParams {
  status?: InvoiceStatus;
  /** Unix seconds, inclusive. */
  created: { gte?: number; lte: number };
}

/** Lists invoices newest first, like `stripe.invoices.list` with auto-pagination. */
export type InvoiceSource = (params: InvoiceListParams) => AsyncIterable<InvoiceLike>;

export const stripeInvoiceSource =
  (stripe: Stripe): InvoiceSource =>
  (params) =>
    stripe.invoices.list({ ...params, limit: 100, expand: ['data.customer'] });

const expandedCustomer = (c: InvoiceLike['customer']): CustomerLike | null =>
  c && typeof c === 'object' && !c.deleted ? c : null;

function dateToUnix(date: string, endOfDay: boolean): number {
  const ms = Date.parse(`${date}T${endOfDay ? '23:59:59' : '00:00:00'}Z`);
  if (Number.isNaN(ms)) throw new Error(`Invalid date: ${date}`);
  return Math.floor(ms / 1000);
}

export function toLineFact(l: LineItemLike): LineFact {
  const discounts = (l.discount_amounts ?? []).reduce((sum, d) => sum + d.amount, 0);
  return { product: l.pricing?.price_details?.product ?? null, description: l.description, amount: l.amount - discounts };
}

async function invoiceLines(inv: InvoiceLike, services: ServiceSource): Promise<LineFact[]> {
  if (!inv.lines) return [];
  if (!inv.lines.has_more) return inv.lines.data.map(toLineFact);
  const all: LineFact[] = [];
  for await (const l of services.lineItems(inv.id)) all.push(toLineFact(l));
  return all;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Works out each line's tax code: the product's, else the account default. Whatever can't be read
 * (the key has no access to Products or Tax settings) is reported as unknown, with a note saying
 * which permission is missing; the report itself still loads.
 */
async function taxCodeClassifier(services: ServiceSource, lines: LineFact[]): Promise<{ classify: Classify; notes: string[] }> {
  const notes: string[] = [];
  const products = new Map<string, { name: string; taxCode: string | null }>();
  let productsOk = true;
  if (lines.some((l) => l.product)) {
    try {
      for await (const p of services.products()) {
        products.set(p.id, { name: p.name, taxCode: typeof p.tax_code === 'string' ? p.tax_code : (p.tax_code?.id ?? null) });
      }
    } catch (e) {
      productsOk = false;
      notes.push(`Products could not be read (${errorText(e)}): give the key Read access to Products to see tax codes and product names.`);
    }
  }
  const productOf = (l: LineFact) => (l.product ? products.get(l.product) : undefined);

  // The account default only matters for lines without a product tax code.
  let fallback: string = NO_TAX_CODE;
  if (lines.some((l) => !l.product || (productsOk && !productOf(l)?.taxCode))) {
    try {
      fallback = (await services.defaultTaxCode()) ?? NO_TAX_CODE;
    } catch (e) {
      fallback = UNKNOWN_TAX_CODE;
      notes.push(`Tax settings could not be read (${errorText(e)}): lines without a product tax code are shown as unknown. Give the key Read access to Tax settings for the account's default tax code.`);
    }
  }

  const classify: Classify = (l) => {
    const p = productOf(l);
    const item = p?.name ?? lineItem(l);
    const product = { product: l.product ?? undefined, productName: item };
    if (!productsOk && l.product) return { service: UNKNOWN_TAX_CODE, item, ...product };
    if (p?.taxCode) return { service: p.taxCode, item, ...product };
    return { service: fallback, item: fallback.startsWith('txcd_') ? `${item} (account default)` : item, ...product };
  };
  return { classify, notes };
}

async function taxCodeNames(services: ServiceSource, ids: string[]): Promise<{ names: Map<string, string>; note?: string }> {
  const names = new Map<string, string>();
  let failed: string | undefined;
  for (const id of ids) {
    try {
      names.set(id, await services.taxCodeName(id));
    } catch (e) {
      failed ??= errorText(e);
    }
  }
  return { names, note: failed && `Some tax code names could not be read (${failed}); those show by ID.` };
}

/**
 * The part of what was paid that isn't VAT: the paid amount scaled by the invoice's net share of its
 * total (so a partly credited invoice keeps its proportions), in whole minor units.
 */
export function paidExcludingTax(inv: Pick<InvoiceLike, 'amount_paid' | 'total' | 'total_taxes'>): number {
  const tax = (inv.total_taxes ?? []).reduce((sum, t) => sum + t.amount, 0);
  if (!tax || inv.total <= 0) return inv.amount_paid;
  return Math.round((inv.amount_paid * (inv.total - tax)) / inv.total);
}

function toFact(inv: InvoiceLike): InvoiceFact {
  const c = inv.customer;
  const customer = expandedCustomer(c);
  const customerId = typeof c === 'string' ? c : (c?.id ?? null);
  return {
    customerId,
    customerName: inv.customer_name ?? customer?.name ?? inv.customer_email ?? customer?.email ?? null,
    currency: inv.currency,
    amountPaid: inv.amount_paid,
    amountPaidExclTax: paidExcludingTax(inv),
    paidDate: isoDate((inv.status_transitions?.paid_at ?? inv.created) * 1000),
    customerCountry: customer?.address?.country,
    invoiceCountry: inv.customer_address?.country,
    shippingCountry: customer?.shipping?.address?.country,
  };
}

/**
 * Revenue = sum of `amount_paid` over invoices with status "paid", grouped by the
 * customer's country and the invoice currency. Each invoice is also converted to EUR at
 * the ECB rate on its payment date, for cross-currency shares, and split across its line
 * items' products for the service view. Read-only: list endpoints only.
 */
export async function revenueByCountry(
  invoices: InvoiceSource,
  fx: FxRateStore,
  query: RevenueQuery,
  onProgress: (p: Progress) => void,
  services: ServiceSource = NO_SERVICES,
  contractors: ContractorMap = NO_CONTRACTORS,
): Promise<RevenueReport> {
  // Reports cover complete past days only: always end at yesterday 23:59:59 UTC at the latest.
  const yesterday = isoDate(Date.now() - 86_400_000);
  const to = query.to && query.to < yesterday ? query.to : yesterday;
  const created: InvoiceListParams['created'] = { lte: dateToUnix(to, true) };
  if (query.from) created.gte = dateToUnix(query.from, false);

  const facts: InvoiceFact[] = [];
  const list = invoices({ status: 'paid', created });

  for await (const inv of list) {
    const fact = toFact(inv);
    assertSupportedCurrency(fact.currency);
    fact.lines = await invoiceLines(inv, services);
    facts.push(fact);
    if (facts.length % 100 === 0) onProgress({ invoicesScanned: facts.length });
  }
  onProgress({ invoicesScanned: facts.length });

  await fx.ensure(
    facts.map((f) => f.currency),
    facts.map((f) => f.paidDate),
  );

  const { classify, notes } = await taxCodeClassifier(
    services,
    facts.flatMap((f) => f.lines ?? []),
  );
  // Two reports from the same invoices: without VAT (the default view) and with it.
  const net = new RevenueAggregator(BASE_CURRENCY, FX_SOURCE, classify, contractors);
  const gross = new RevenueAggregator(BASE_CURRENCY, FX_SOURCE, classify, contractors);
  for (const f of facts) {
    // An invoice created before the cut-off but paid today can't be converted yet: leave it out.
    if (f.paidDate > yesterday) continue;
    const rate = fx.rate(f.currency, f.paidDate);
    const exclTax = { ...f, amountPaid: f.amountPaidExclTax ?? f.amountPaid };
    net.add(exclTax, toMajorUnits(exclTax.amountPaid, f.currency) / rate);
    gross.add(f, toMajorUnits(f.amountPaid, f.currency) / rate);
  }
  const codes = [...new Set(net.serviceKeys())].filter((k) => k.startsWith('txcd_'));
  const { names, note } = await taxCodeNames(services, codes);
  if (note) notes.push(note);
  const report: RevenueReport = { ...net.report(query, names), vat: 'excluded', withVat: { ...gross.report(query, names), vat: 'included' } };
  if (notes.length) report.servicesNote = report.withVat!.servicesNote = notes.join(' ');
  return report;
}

/** All products for Options: active first, then archived, each by name. */
export async function listProducts(services: ServiceSource): Promise<ProductInfo[]> {
  const out: ProductInfo[] = [];
  try {
    for await (const p of services.products()) out.push({ id: p.id, name: p.name, active: p.active !== false });
  } catch (e) {
    throw new Error(`Products could not be read (${errorText(e)}): give the key Read access to Products.`);
  }
  return out.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** For callers without line items or products: every invoice is reported as not split. */
const NO_SERVICES: ServiceSource = {
  lineItems: async function* () {},
  products: async function* () {},
  defaultTaxCode: async () => null,
  taxCodeName: async (id) => id,
};

const FX_SOURCE_VAT = 'ECB reference rate on the invoice date (cached in data/fx-rates.csv, gaps from api.frankfurter.dev)';

/**
 * Which invoices to fetch for a VAT period. Stripe filters by `created`, not by the invoice date,
 * so the window can reach back before the period (invoices finalized late) and on to yesterday
 * (invoices back-dated into the period); see VatFetchSettings.
 */
export function vatFetchScope(period: VatQuery, fetch: VatFetchSettings, yesterday: string): FetchScope {
  return {
    createdFrom: isoDate(Date.parse(`${period.from}T00:00:00Z`) - fetch.lookbackDays * 86_400_000),
    createdTo: fetch.includeCreatedAfter ? yesterday : period.to,
    statuses: INVOICE_STATUSES.filter((s) => fetch.statuses.includes(s)),
  };
}

/** One list per status (Stripe takes a single status), or one unfiltered list when all are wanted. */
async function* listScope(invoices: InvoiceSource, scope: FetchScope): AsyncIterable<InvoiceLike> {
  const created = { gte: dateToUnix(scope.createdFrom, false), lte: dateToUnix(scope.createdTo, true) };
  if (scope.statuses.length === INVOICE_STATUSES.length) {
    yield* invoices({ created });
    return;
  }
  for (const status of scope.statuses) yield* invoices({ status, created });
}

function toVatFact(inv: InvoiceLike): VatInvoiceFact {
  const c = inv.customer;
  const customer = expandedCustomer(c);
  const vatMinor = (inv.total_taxes ?? []).reduce((sum, t) => sum + t.amount, 0);
  const dateSec = inv.effective_at ?? inv.status_transitions?.finalized_at ?? inv.created;
  return {
    id: inv.id,
    number: inv.number,
    date: isoDate(dateSec * 1000),
    status: inv.status ?? 'draft',
    customerId: typeof c === 'string' ? c : (c?.id ?? null),
    customerName: inv.customer_name ?? customer?.name ?? inv.customer_email ?? customer?.email ?? null,
    currency: inv.currency,
    totalMinor: inv.total,
    vatMinor,
    taxReasons: (inv.total_taxes ?? []).map((t) => t.taxability_reason),
    taxIds: (inv.customer_tax_ids ?? []).map((t) => ({ type: t.type, value: t.value })),
    invoiceCountry: inv.customer_address?.country,
    customerCountry: customer?.address?.country,
    shippingCountry: customer?.shipping?.address?.country,
  };
}

/**
 * Cyprus VAT report: invoices with the chosen statuses (by default the finalized ones: paid, open,
 * uncollectible) whose invoice date falls in the period, split into Cyprus VAT / VIES /
 * international, converted to EUR at the ECB rate on the invoice date. Read-only: list endpoints only.
 */
export async function vatReport(
  invoices: InvoiceSource,
  fx: FxRateStore,
  query: VatQuery,
  onProgress: (p: Progress) => void,
  fetch: VatFetchSettings = DEFAULT_SETTINGS.vatFetch,
): Promise<VatReport> {
  if (!query.from || !query.to || query.from > query.to) throw new Error('Pick a VAT period.');
  const yesterday = isoDate(Date.now() - 86_400_000);
  if (query.from > yesterday) throw new Error('The VAT period has not started yet.');
  const period: VatQuery = { from: query.from, to: query.to < yesterday ? query.to : yesterday };
  const scope = vatFetchScope(period, fetch, yesterday);
  if (!scope.statuses.length) throw new Error('No invoice statuses selected in Options.');
  const wanted = new Set<string>(scope.statuses);

  onProgress({ invoicesScanned: 0, scope });
  let scanned = 0;
  const facts: VatInvoiceFact[] = [];
  for await (const inv of listScope(invoices, scope)) {
    if (++scanned % 100 === 0) onProgress({ invoicesScanned: scanned });
    if (!wanted.has(inv.status ?? 'draft')) continue;
    const fact = toVatFact(inv);
    if (fact.date < period.from || fact.date > period.to) continue;
    assertSupportedCurrency(fact.currency);
    facts.push(fact);
  }
  onProgress({ invoicesScanned: scanned });

  await fx.ensure(
    facts.map((f) => f.currency),
    facts.map((f) => f.date),
  );
  return buildVatReport(facts, (cur, date) => fx.rate(cur, date), period, { fxSource: FX_SOURCE_VAT, invoicesScanned: scanned, scope });
}
