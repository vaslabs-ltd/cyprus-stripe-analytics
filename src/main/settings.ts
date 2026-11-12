import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Contractor, InvoiceStatus, Settings } from '../shared/types';

export const INVOICE_STATUSES: readonly InvoiceStatus[] = ['paid', 'open', 'uncollectible', 'draft', 'void'];

/** Lookback choices offered in Options, in days. */
export const LOOKBACK_DAYS = [0, 31, 92, 365] as const;

/**
 * Defaults: finalized, non-void invoices created within the VAT period. Fastest, and right
 * when invoices are finalized on the day they're created and never back-dated.
 */
export const DEFAULT_SETTINGS: Settings = {
  vatFetch: { statuses: ['paid', 'open', 'uncollectible'], lookbackDays: 0, includeCreatedAfter: false },
  contractors: [],
  productContractors: {},
  productNames: {},
};

const MAX_ID = 64;
const MAX_NAME = 100;
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID && /^[\w-]+$/.test(v);

/** Contractors with a valid ID and a non-empty name, first one wins on duplicate IDs. */
function normalizeContractors(raw: unknown): Contractor[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Contractor[] = [];
  for (const c of raw as Array<{ id?: unknown; name?: unknown }>) {
    const name = typeof c?.name === 'string' ? c.name.trim().slice(0, MAX_NAME) : '';
    if (!isId(c?.id) || !name || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push({ id: c.id, name });
  }
  return out;
}

/** Assignments to contractors that exist; anything else is dropped. */
function normalizeAssignments(raw: unknown, contractors: Contractor[]): Record<string, string> {
  const ids = new Set(contractors.map((c) => c.id));
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [product, contractor] of Object.entries(raw)) {
    if (isId(product) && typeof contractor === 'string' && ids.has(contractor)) out[product] = contractor;
  }
  return out;
}

const isStatus = (s: unknown): s is InvoiceStatus => INVOICE_STATUSES.includes(s as InvoiceStatus);

/** Names of assigned products only (others aren't needed). */
function normalizeProductNames(raw: unknown, assigned: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, name] of Object.entries(raw)) {
    const n = typeof name === 'string' ? name.trim().slice(0, 200) : '';
    if (n && id in assigned) out[id] = n;
  }
  return out;
}

/** Turn anything (a parsed file, an IPC payload) into valid settings, falling back to defaults per field. */
export function normalizeSettings(raw: unknown): Settings {
  const d = DEFAULT_SETTINGS.vatFetch;
  const v = (raw as { vatFetch?: Record<string, unknown> } | null)?.vatFetch ?? {};
  const statuses = Array.isArray(v.statuses) ? INVOICE_STATUSES.filter((s) => (v.statuses as unknown[]).filter(isStatus).includes(s)) : [];
  const lookback = v.lookbackDays;
  const contractors = normalizeContractors((raw as { contractors?: unknown } | null)?.contractors);
  const productContractors = normalizeAssignments((raw as { productContractors?: unknown } | null)?.productContractors, contractors);
  return {
    vatFetch: {
      statuses: statuses.length ? statuses : [...d.statuses],
      lookbackDays: typeof lookback === 'number' && Number.isInteger(lookback) && lookback >= 0 && lookback <= 731 ? lookback : d.lookbackDays,
      includeCreatedAfter: typeof v.includeCreatedAfter === 'boolean' ? v.includeCreatedAfter : d.includeCreatedAfter,
    },
    contractors,
    productContractors,
    productNames: normalizeProductNames((raw as { productNames?: unknown } | null)?.productNames, productContractors),
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
  // Owner-only: it names contractors.
  await writeFile(file, JSON.stringify(settings, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  await chmod(file, 0o600).catch(() => {}); // writeFile's mode only applies to a new file
  return settings;
}
