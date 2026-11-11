/**
 * Demo mode: entering the key `rk_demo` replaces Stripe with generated invoices, so the app can be
 * tried (or shown) without a Stripe account. Nothing about it is saved: the key stays in memory
 * and the invoices are generated on the fly.
 *
 * The data is deterministic per calendar month: customers who start in a month, and the invoices
 * they get, depend only on that month, so a quarter shows the same numbers every time. Statuses
 * still move with time (an invoice due last week is open today and paid later).
 *
 * Every name, email (.example) and VAT number ("DEMO" in it) is fictional and generated
 * automatically. Business names are marked "(demo)" and private customers get well-known
 * placeholder names (John Doe, …); any resemblance to real people or businesses is coincidental.
 */
import { isoDate } from './fx';
import type { CustomerLike, InvoiceLike, InvoiceListParams, InvoiceSource, LineItemLike, ProductLike, ServiceSource } from './stripe';

export const DEMO_KEY = 'rk_demo';
export const isDemoKey = (key: string | undefined): boolean => key?.trim() === DEMO_KEY;

/** First month with demo customers. */
const START = { year: 2025, month: 1 };
const DAY = 86_400;

/** Small deterministic PRNG (mulberry32) seeded from a string. */
function rng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, items: readonly T[]): T => items[Math.floor(r() * items.length)];

type Segment = 'cy_b2b' | 'cy_b2c' | 'eu' | 'gb' | 'us' | 'other';
const SEGMENTS: [Segment, number][] = [
  ['cy_b2b', 0.18],
  ['cy_b2c', 0.1],
  ['eu', 0.32],
  ['gb', 0.15],
  ['us', 0.15],
  ['other', 0.1],
];
// EU VAT number prefixes differ from ISO codes for Greece (EL).
const EU = [['DE', 'DE'], ['FR', 'FR'], ['NL', 'NL'], ['IE', 'IE'], ['IT', 'IT'], ['ES', 'ES'], ['GR', 'EL'], ['AT', 'AT'], ['BE', 'BE'], ['PT', 'PT']] as const;
const OTHER = ['CH', 'NO', 'CA', 'AU', 'IL', 'SG', 'AE'] as const;

const WORDS_A = ['Blue', 'Cedar', 'Harbor', 'Granite', 'Copper', 'Lumen', 'Orbit', 'Juniper', 'Kestrel', 'Meridian', 'Nimbus', 'Olive', 'Pixel', 'Quartz', 'Saffron', 'Tidal'];
const WORDS_B = ['Labs', 'Studio', 'Systems', 'Analytics', 'Works', 'Digital', 'Partners', 'Software', 'Media', 'Robotics'];
// Private customers get well-known placeholder names, so none can look like a real person.
const PEOPLE = ['John Doe', 'Jane Doe', 'Joe Bloggs', 'Jane Roe', 'Richard Roe', 'John Q. Public', 'Max Mustermann', 'Erika Mustermann'];
const PRICES = [49, 99, 149, 249, 499, 1200]; // major units per month

/** Demo products: almost all revenue is software (computer services), with a few minor services. */
export const DEMO_PRODUCTS = {
  platform: { id: 'prod_demo_platform', name: 'Analytics platform subscription' },
  support: { id: 'prod_demo_support', name: 'Priority support' },
  setup: { id: 'prod_demo_setup', name: 'Onboarding and setup' },
  tutoring: { id: 'prod_demo_tutoring', name: 'Private tutoring' },
} as const satisfies Record<string, ProductLike>;

/** Larger plans include priority support, billed as a second line (this share of the price). */
const SUPPORT_SHARE = 0.1;

function demoLines(c: DemoCustomer, net: number, setupFee: boolean): LineItemLike[] {
  const line = (product: ProductLike, amount: number): LineItemLike => ({
    amount,
    description: product.name,
    pricing: { price_details: { product: product.id } },
  });
  if (setupFee) return [line(DEMO_PRODUCTS.setup, net)];
  if (c.segment === 'cy_b2c') return [line(DEMO_PRODUCTS.tutoring, net)];
  if (c.priceMinor < 499_00) return [line(DEMO_PRODUCTS.platform, net)];
  const support = Math.round(net * SUPPORT_SHARE);
  return [line(DEMO_PRODUCTS.platform, net - support), line(DEMO_PRODUCTS.support, support)];
}

interface DemoCustomer {
  customer: CustomerLike;
  segment: Segment;
  country: string | null;
  currency: 'eur' | 'gbp' | 'usd';
  taxId: { type: string; value: string } | null;
  /** Where the country is recorded: drives which country source the report uses. */
  addressOn: 'customer' | 'invoice' | 'shipping' | 'none';
  start: { year: number; month: number };
  months: number;
  billingDay: number;
  priceMinor: number;
  numberPrefix: string;
}

function segmentFor(r: number): Segment {
  let acc = 0;
  for (const [s, w] of SEGMENTS) if (r < (acc += w)) return s;
  return 'other';
}

function newCustomer(year: number, month: number, i: number): DemoCustomer {
  const r = rng(`customer:${year}-${month}:${i}`);
  const id = `cus_demo${year}${String(month).padStart(2, '0')}${i}`;
  const segment = segmentFor(r());
  let country: string;
  let currency: DemoCustomer['currency'] = 'eur';
  let taxId: DemoCustomer['taxId'] = null;
  const serial = String(Math.floor(r() * 1e6)).padStart(6, '0');
  switch (segment) {
    case 'cy_b2b':
      country = 'CY';
      taxId = { type: 'eu_vat', value: `CYDEMO${serial}X` };
      break;
    case 'cy_b2c':
      country = 'CY';
      break;
    case 'eu': {
      const [iso, vatPrefix] = pick(r, EU);
      country = iso;
      // A few EU customers never gave a VAT number: the VIES list flags them.
      if (r() > 0.05) taxId = { type: 'eu_vat', value: `${vatPrefix}DEMO${serial}` };
      break;
    }
    case 'gb':
      country = 'GB';
      currency = 'gbp';
      if (r() > 0.3) taxId = { type: 'gb_vat', value: `GBDEMO${serial}` };
      break;
    case 'us':
      country = 'US';
      currency = 'usd';
      break;
    default:
      country = pick(r, OTHER);
      currency = r() < 0.6 ? 'usd' : 'eur';
  }
  const a = r();
  const addressOn = a < 0.82 ? 'customer' : a < 0.92 ? 'invoice' : a < 0.97 ? 'shipping' : 'none';
  // Random word pairs can match a real business: the "(demo)" marks them as made up.
  const name = segment === 'cy_b2c' ? pick(r, PEOPLE) : `${pick(r, WORDS_A)} ${pick(r, WORDS_B)} (demo)`;
  const slug = name.toLowerCase().replace(/[^a-z]+/g, '');
  const addr = { country };
  return {
    customer: {
      id,
      name,
      email: `billing@${slug}${i}.example`,
      address: addressOn === 'customer' ? addr : null,
      shipping: addressOn === 'shipping' ? { address: addr } : null,
    },
    segment,
    country: addressOn === 'none' ? null : country,
    currency,
    taxId,
    addressOn,
    start: { year, month },
    months: 3 + Math.floor(r() * 28),
    billingDay: 1 + Math.floor(r() * 28),
    // B2C (private tutoring) is cheaper.
    priceMinor: (segment === 'cy_b2c' ? pick(r, [40, 60, 80]) : pick(r, PRICES)) * 100,
    numberPrefix: `DEMO${(year % 100) * 100 + month}${i}`,
  };
}

function* monthsFrom(start: { year: number; month: number }, until: { year: number; month: number }) {
  let { year, month } = start;
  while (year < until.year || (year === until.year && month <= until.month)) {
    yield { year, month };
    if (++month > 12) [year, month] = [year + 1, 1];
  }
}

function invoicesFor(c: DemoCustomer, k: number, nowSec: number): InvoiceLike[] {
  const r = rng(`invoice:${c.customer.id}:${k}`);
  const m0 = c.start.month - 1 + k;
  const created = Date.UTC(c.start.year + Math.floor(m0 / 12), m0 % 12, c.billingDay, 8 + Math.floor(r() * 9), Math.floor(r() * 60)) / 1000;
  if (created > nowSec) return [];

  const lines = [c.priceMinor];
  if (k === 0 && c.segment !== 'cy_b2c' && r() < 0.25) lines.push(pick(r, [250, 500, 1500]) * 100); // one-off setup fee
  return lines.map((net, j) => {
    const ir = rng(`invoice:${c.customer.id}:${k}:${j}`);
    let tax: { amount: number; taxability_reason: string } | null;
    switch (c.segment) {
      case 'cy_b2b':
        tax = { amount: Math.round(net * 0.19), taxability_reason: 'standard_rated' };
        break;
      case 'cy_b2c':
        tax = { amount: 0, taxability_reason: 'product_exempt' };
        break;
      case 'eu':
        tax = { amount: 0, taxability_reason: 'reverse_charge' };
        break;
      default:
        tax = { amount: 0, taxability_reason: 'not_subject_to_tax' };
    }
    // A few mistakes for the VAT tab to flag.
    if (c.country === 'CY' && ir() < 0.03) tax = null; // no tax calculated
    if (c.segment === 'eu' && ir() < 0.02) tax = { amount: Math.round(net * 0.19), taxability_reason: 'standard_rated' };

    const total = net + (tax?.amount ?? 0);
    const finalizedAt = created + 3600 + j * 60;
    const s = ir();
    let status: string;
    let paidAt: number | null = null;
    if (s < 0.03) status = 'void';
    else if (s < 0.05 && finalizedAt < nowSec - 60 * DAY) status = 'uncollectible';
    else {
      paidAt = finalizedAt + Math.floor(ir() ** 2 * 25 * DAY);
      status = paidAt <= nowSec ? 'paid' : 'open';
      if (status === 'open') paidAt = null;
    }
    const n = k * 2 + j + 1;
    return {
      id: `in_demo_${c.customer.id.slice(4)}_${n}`,
      number: `${c.numberPrefix}-${String(n).padStart(4, '0')}`,
      status,
      created: created + j * 60,
      effective_at: null,
      status_transitions: { finalized_at: finalizedAt, paid_at: paidAt },
      currency: c.currency,
      amount_paid: status === 'paid' ? total : 0,
      total,
      total_taxes: tax ? [tax] : [],
      customer: c.customer,
      customer_name: c.customer.name ?? null,
      customer_email: c.customer.email ?? null,
      customer_tax_ids: c.taxId ? [c.taxId] : [],
      customer_address: c.addressOn === 'invoice' && c.country ? { country: c.country } : null,
      lines: { data: demoLines(c, net, j > 0), has_more: false },
    };
  });
}

/** All demo invoices created up to `nowSec`, newest first. */
export function generateDemoInvoices(nowSec: number): InvoiceLike[] {
  const now = new Date(nowSec * 1000);
  const until = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
  const out: InvoiceLike[] = [];
  let first = true;
  for (const { year, month } of monthsFrom(START, until)) {
    const r = rng(`month:${year}-${month}`);
    const count = first ? 10 : 1 + Math.floor(r() * 4);
    first = false;
    for (let i = 0; i < count; i++) {
      const c = newCustomer(year, month, i);
      for (let k = 0; k < c.months; k++) out.push(...invoicesFor(c, k, nowSec));
    }
  }
  return out.sort((a, b) => b.created - a.created);
}

/** An invoice source backed by generated data, filtered like the Stripe list endpoint. */
export function demoInvoiceSource(nowSec: () => number = () => Math.floor(Date.now() / 1000)): InvoiceSource {
  let cache: { day: string; invoices: InvoiceLike[] } | null = null;
  return async function* (params: InvoiceListParams) {
    const now = nowSec();
    const day = isoDate(now * 1000);
    if (cache?.day !== day) cache = { day, invoices: generateDemoInvoices(now) };
    const { gte = 0, lte } = params.created;
    for (const inv of cache.invoices) {
      if (inv.created < gte || inv.created > lte) continue;
      if (params.status && inv.status !== params.status) continue;
      yield inv;
    }
  };
}

/** Demo products and line items (every demo invoice embeds all of its lines). */
export function demoServiceSource(): ServiceSource {
  return {
    lineItems: async function* () {},
    products: async function* () {
      yield* Object.values(DEMO_PRODUCTS);
    },
  };
}
