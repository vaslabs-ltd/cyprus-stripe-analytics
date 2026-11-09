/**
 * ECB reference exchange rates, cached in a committed CSV file and gap-filled from
 * api.frankfurter.dev. Only currency codes and dates are sent; no Stripe data leaves the machine.
 *
 * CSV columns: date,base,currency,rate,ecb_date
 *  - one row per calendar day and currency
 *  - rate = units of `currency` per 1 unit of `base`
 *  - ecb_date = the ECB publication day the rate comes from (differs from `date`
 *    on weekends/holidays, where the previous publication day's rate applies)
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const BASE_CURRENCY = 'eur';
export const SUPPORTED_CURRENCIES = ['eur', 'gbp', 'usd'] as const;
export const FX_SOURCE = 'ECB reference rate on the payment date (cached in data/fx-rates.csv, gaps from api.frankfurter.dev)';

const API = 'https://api.frankfurter.dev/v1';
const DAY_MS = 86_400_000;
const LOOKBACK_DAYS = 7;
const HEADER = 'date,base,currency,rate,ecb_date';

export type FetchJson = (url: string) => Promise<unknown>;

interface RateRow {
  date: string;
  base: string;
  currency: string;
  rate: number;
  ecbDate: string;
}

export function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  return isoDate(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS);
}

export function assertSupportedCurrency(currency: string): void {
  if (!(SUPPORTED_CURRENCIES as readonly string[]).includes(currency.toLowerCase())) {
    throw new Error(
      `Unsupported currency "${currency.toUpperCase()}". Only ${SUPPORTED_CURRENCIES.map((c) => c.toUpperCase()).join(', ')} are supported.`,
    );
  }
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Exchange rate request failed (${url}): HTTP ${res.status}`);
  return res.json();
}

export class FxRateStore {
  private readonly rows = new Map<string, RateRow>(); // key: date|currency
  private loaded = false;
  /** Number of HTTP requests made to the rate API by this store (for tests/diagnostics). */
  requests = 0;

  constructor(
    private readonly file: string,
    private readonly fetchJson: FetchJson = defaultFetchJson,
    private readonly today: () => string = () => isoDate(Date.now()),
  ) {}

  private key(date: string, currency: string) {
    return `${date}|${currency}`;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.file)) return;
    const lines = (await readFile(this.file, 'utf8')).split(/\r?\n/);
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const [date, base, currency, rate, ecbDate] = line.split(',');
      if (base !== BASE_CURRENCY) continue;
      this.rows.set(this.key(date, currency), { date, base, currency, rate: Number(rate), ecbDate });
    }
  }

  private async save(): Promise<void> {
    const rows = [...this.rows.values()].sort((a, b) => a.date.localeCompare(b.date) || a.currency.localeCompare(b.currency));
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, [HEADER, ...rows.map((r) => `${r.date},${r.base},${r.currency},${r.rate},${r.ecbDate}`)].join('\n') + '\n');
  }

  /** Make sure rates exist for every (currency, date) pair, fetching only what's missing. */
  async ensure(currencies: string[], dates: string[]): Promise<void> {
    await this.load();
    const curs = [...new Set(currencies.map((c) => c.toLowerCase()))];
    curs.forEach(assertSupportedCurrency);
    const foreign = curs.filter((c) => c !== BASE_CURRENCY);
    // Reports cover past days only; today's rate may not be published yet.
    const today = this.today();
    const future = dates.find((d) => d >= today);
    if (future) throw new Error(`Exchange rates are only available for past dates (got ${future}).`);

    const missingDates = new Set<string>();
    const missingCurs = new Set<string>();
    for (const d of new Set(dates)) {
      for (const c of foreign) {
        if (!this.rows.has(this.key(d, c))) {
          missingDates.add(d);
          missingCurs.add(c);
        }
      }
    }
    if (missingDates.size === 0) return;

    const sorted = [...missingDates].sort();
    const start = sorted[0];
    const end = sorted[sorted.length - 1];
    const symbols = [...missingCurs].sort().map((c) => c.toUpperCase()).join(',');
    this.requests++;
    const body = (await this.fetchJson(
      `${API}/${addDays(start, -LOOKBACK_DAYS)}..${end}?base=${BASE_CURRENCY.toUpperCase()}&symbols=${symbols}`,
    )) as { rates?: Record<string, Record<string, number>> };

    const published = Object.keys(body.rates ?? {}).sort();
    // Fill every calendar day in [start, end] with the last publication on or before it.
    for (const c of missingCurs) {
      let p = -1;
      for (let d = start; d <= end; d = addDays(d, 1)) {
        while (p + 1 < published.length && published[p + 1] <= d) p++;
        const k = this.key(d, c);
        if (this.rows.has(k) || p < 0) continue;
        const rate = body.rates![published[p]][c.toUpperCase()];
        if (rate === undefined) continue;
        this.rows.set(k, { date: d, base: BASE_CURRENCY, currency: c, rate, ecbDate: published[p] });
      }
    }

    await this.save();
  }

  /** Units of `currency` per 1 EUR on `date`. Call `ensure` first. */
  rate(currency: string, date: string): number {
    const c = currency.toLowerCase();
    assertSupportedCurrency(c);
    if (c === BASE_CURRENCY) return 1;
    const row = this.rows.get(this.key(date, c));
    if (!row) throw new Error(`No ${c.toUpperCase()} exchange rate available for ${date}.`);
    return row.rate;
  }
}
