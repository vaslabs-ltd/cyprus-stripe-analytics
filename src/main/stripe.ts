import Stripe from 'stripe';
import type { Progress, RevenueQuery, RevenueReport } from '../shared/types';
import { RevenueAggregator, type InvoiceFact } from './analytics';

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
    customerCountry: customer?.address?.country,
    invoiceCountry: inv.customer_address?.country,
    shippingCountry: customer?.shipping?.address?.country,
  };
}

/**
 * Revenue = sum of `amount_paid` over invoices with status "paid", grouped by the
 * customer's country and the invoice currency. Read-only: uses list endpoints only.
 */
export async function revenueByCountry(
  stripe: Stripe,
  query: RevenueQuery,
  onProgress: (p: Progress) => void,
): Promise<RevenueReport> {
  const created: Stripe.RangeQueryParam = {};
  if (query.from) created.gte = dateToUnix(query.from, false);
  if (query.to) created.lte = dateToUnix(query.to, true);

  const agg = new RevenueAggregator();
  const list = stripe.invoices.list({
    status: 'paid',
    limit: 100,
    expand: ['data.customer'],
    ...(Object.keys(created).length ? { created } : {}),
  });

  for await (const inv of list) {
    agg.add(toFact(inv));
    if (agg.invoicesScanned % 100 === 0) onProgress({ invoicesScanned: agg.invoicesScanned });
  }
  onProgress({ invoicesScanned: agg.invoicesScanned });
  return agg.report(query);
}
