/** Small DOM and formatting helpers shared by the report tabs. */

export const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const countryNames = new Intl.DisplayNames(undefined, { type: 'region' });
export function countryName(code: string): string {
  if (code === '??') return 'Unknown';
  try {
    return countryNames.of(code) ?? code;
  } catch {
    return code;
  }
}

export function countryCell(code: string): HTMLTableCellElement {
  const td = el('td', undefined, countryName(code));
  td.append(el('span', 'code', code));
  return td;
}

export function formatMoney(amountMinor: number, currency: string, exponent: number): string {
  const amount = amountMinor / 10 ** exponent;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    }).format(amount);
  } catch {
    return `${amount.toFixed(exponent)} ${currency.toUpperCase()}`;
  }
}

export const formatEurCents = (cents: number) => formatMoney(cents, 'eur', 2);

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const pctFmt = new Intl.NumberFormat(undefined, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function setStatus(statusEl: HTMLElement, text: string, error = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', error);
}

/** Complete past days only (UTC): reports end yesterday at the latest. */
export const yesterdayUtc = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
