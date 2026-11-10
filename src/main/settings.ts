import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { InvoiceStatus, Settings } from '../shared/types';

export const INVOICE_STATUSES: readonly InvoiceStatus[] = ['paid', 'open', 'uncollectible', 'draft', 'void'];

/** Lookback choices offered in Options, in days. */
export const LOOKBACK_DAYS = [0, 31, 92, 365] as const;

/**
 * Defaults: finalized, non-void invoices created within the VAT period. Fastest, and right
 * when invoices are finalized on the day they're created and never back-dated.
 */
export const DEFAULT_SETTINGS: Settings = {
  vatFetch: { statuses: ['paid', 'open', 'uncollectible'], lookbackDays: 0, includeCreatedAfter: false },
};

const isStatus = (s: unknown): s is InvoiceStatus => INVOICE_STATUSES.includes(s as InvoiceStatus);

/** Turn anything (a parsed file, an IPC payload) into valid settings, falling back to defaults per field. */
export function normalizeSettings(raw: unknown): Settings {
  const d = DEFAULT_SETTINGS.vatFetch;
  const v = (raw as { vatFetch?: Record<string, unknown> } | null)?.vatFetch ?? {};
  const statuses = Array.isArray(v.statuses) ? INVOICE_STATUSES.filter((s) => (v.statuses as unknown[]).filter(isStatus).includes(s)) : [];
  const lookback = v.lookbackDays;
  return {
    vatFetch: {
      statuses: statuses.length ? statuses : [...d.statuses],
      lookbackDays: typeof lookback === 'number' && Number.isInteger(lookback) && lookback >= 0 && lookback <= 731 ? lookback : d.lookbackDays,
      includeCreatedAfter: typeof v.includeCreatedAfter === 'boolean' ? v.includeCreatedAfter : d.includeCreatedAfter,
    },
  };
}

/** Missing or unreadable file: defaults (a broken file is replaced on the next save). */
export async function loadSettings(file: string): Promise<Settings> {
  if (!existsSync(file)) return normalizeSettings(null);
  try {
    return normalizeSettings(JSON.parse(await readFile(file, 'utf8')));
  } catch {
    return normalizeSettings(null);
  }
}

export async function saveSettings(file: string, raw: unknown): Promise<Settings> {
  const settings = normalizeSettings(raw);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return settings;
}
