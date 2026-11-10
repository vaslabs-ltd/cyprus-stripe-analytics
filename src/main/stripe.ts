import Stripe from 'stripe';
import type { FetchScope, InvoiceStatus, Progress, RevenueQuery, RevenueReport, VatFetchSettings, VatQuery, VatReport } from '../shared/types';
import { RevenueAggregator, toMajorUnits, type InvoiceFact } from './analytics';
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
}

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

function toFact(inv: InvoiceLike): InvoiceFact {
  const c = inv.customer;
  const customer = expandedCustomer(c);
  const customerId = typeof c === 'string' ? c : (c?.id ?? null);
  return {
    customerId,
    currency: inv.currency,
    amountPaid: inv.amount_paid,
    paidDate: isoDate((inv.status_transitions?.paid_at ?? inv.created) * 1000),
    customerCountry: customer?.address?.country,
    invoiceCountry: inv.customer_address?.country,
    shippingCountry: customer?.shipping?.address?.country,
  };
}

/**
 * Revenue = sum of `amount_paid` over invoices with status "paid", grouped by the
 * customer's country and the invoice currency. Each invoice is also converted to EUR at
 * the ECB rate on its payment date, for cross-currency shares. Read-only: list endpoints only.
 */
export async function revenueByCountry(
  invoices: InvoiceSource,
  fx: FxRateStore,
  query: RevenueQuery,
  onProgress: (p: Progress) => void,
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
    facts.push(fact);
    if (facts.length % 100 === 0) onProgress({ invoicesScanned: facts.length });
  }
  onProgress({ invoicesScanned: facts.length });

  await fx.ensure(
    facts.map((f) => f.currency),
    facts.map((f) => f.paidDate),
  );

  const agg = new RevenueAggregator(BASE_CURRENCY, FX_SOURCE);
  for (const f of facts) {
    // An invoice created before the cut-off but paid today can't be converted yet: leave it out.
    if (f.paidDate > yesterday) continue;
    agg.add(f, toMajorUnits(f.amountPaid, f.currency) / fx.rate(f.currency, f.paidDate));
  }
  return agg.report(query);
}

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
