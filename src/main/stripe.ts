import Stripe from 'stripe';
import type { Progress, RevenueQuery, RevenueReport, VatQuery, VatReport } from '../shared/types';
import { RevenueAggregator, toMajorUnits, type InvoiceFact } from './analytics';
import { assertSupportedCurrency, BASE_CURRENCY, FX_SOURCE, isoDate, type FxRateStore } from './fx';
import { buildVatReport, VAT_STATUSES, type VatInvoiceFact } from './vat';

/**
 * Only restricted keys (rk_...) are accepted. A standard secret key (sk_...) has full
 * write access to the account, which this app never needs.
 */
export function createStripeClient(key: string | undefined): Stripe {
  if (!key) throw new Error('STRIPE_PASSKEY is not set. Put a restricted, read-only key in .env.');
  if (!/^rk_(live|test)_/.test(key)) {
    throw new Error('Refusing to use a non-restricted Stripe key. Create a restricted key with read-only access to Invoices and Customers.');
  }
  return new Stripe(key, { maxNetworkRetries: 3, appInfo: { name: 'stripe-analytics' } });
}

function dateToUnix(date: string, endOfDay: boolean): number {
  const ms = Date.parse(`${date}T${endOfDay ? '23:59:59' : '00:00:00'}Z`);
  if (Number.isNaN(ms)) throw new Error(`Invalid date: ${date}`);
  return Math.floor(ms / 1000);
}

function toFact(inv: Stripe.Invoice): InvoiceFact {
  const c = inv.customer;
  const customer = c && typeof c === 'object' && !('deleted' in c && c.deleted) ? (c as Stripe.Customer) : null;
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
  stripe: Stripe,
  fx: FxRateStore,
  query: RevenueQuery,
  onProgress: (p: Progress) => void,
): Promise<RevenueReport> {
  // Reports cover complete past days only: always end at yesterday 23:59:59 UTC at the latest.
  const yesterday = isoDate(Date.now() - 86_400_000);
  const to = query.to && query.to < yesterday ? query.to : yesterday;
  const created: Stripe.RangeQueryParam = { lte: dateToUnix(to, true) };
  if (query.from) created.gte = dateToUnix(query.from, false);

  const facts: InvoiceFact[] = [];
  const list = stripe.invoices.list({
    status: 'paid',
    limit: 100,
    expand: ['data.customer'],
    created,
  });

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

/** Invoices are listed by `created`; look back this far for invoices finalized (or back-dated) into the period. */
const VAT_CREATED_LOOKBACK_DAYS = 365;

function toVatFact(inv: Stripe.Invoice): VatInvoiceFact {
  const c = inv.customer;
  const customer = c && typeof c === 'object' && !('deleted' in c && c.deleted) ? (c as Stripe.Customer) : null;
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
 * Cyprus VAT report: finalized invoices (paid, open, uncollectible) whose invoice date falls in
 * the period, split into Cyprus VAT / VIES / international, converted to EUR at the ECB rate on
 * the invoice date. Read-only: list endpoints only.
 */
export async function vatReport(
  stripe: Stripe,
  fx: FxRateStore,
  query: VatQuery,
  onProgress: (p: Progress) => void,
): Promise<VatReport> {
  if (!query.from || !query.to || query.from > query.to) throw new Error('Pick a VAT period.');
  const yesterday = isoDate(Date.now() - 86_400_000);
  if (query.from > yesterday) throw new Error('The VAT period has not started yet.');
  const period: VatQuery = { from: query.from, to: query.to < yesterday ? query.to : yesterday };

  const lookbackFrom = isoDate(Date.parse(`${period.from}T00:00:00Z`) - VAT_CREATED_LOOKBACK_DAYS * 86_400_000);
  const list = stripe.invoices.list({
    limit: 100,
    expand: ['data.customer'],
    created: { gte: dateToUnix(lookbackFrom, false), lte: dateToUnix(yesterday, true) },
  });

  let scanned = 0;
  const facts: VatInvoiceFact[] = [];
  for await (const inv of list) {
    if (++scanned % 100 === 0) onProgress({ invoicesScanned: scanned });
    if (!inv.status || !VAT_STATUSES.has(inv.status)) continue;
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
  return buildVatReport(facts, (cur, date) => fx.rate(cur, date), period, { fxSource: FX_SOURCE_VAT, invoicesScanned: scanned });
}
