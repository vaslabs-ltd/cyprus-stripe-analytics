import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FxRateStore, type FetchJson } from './fx';

// Fri 2026-10-02, Mon 2026-10-05 are ECB publication days; the weekend in between is not.
const RATES: Record<string, Record<string, number>> = {
  '2026-09-25': { USD: 1.1, GBP: 0.8 },
  '2026-10-01': { USD: 1.12, GBP: 0.85 },
  '2026-10-02': { USD: 1.13, GBP: 0.86 },
  '2026-10-05': { USD: 1.15, GBP: 0.87 },
};

function fakeApi() {
  const urls: string[] = [];
  const fetchJson: FetchJson = async (url) => {
    urls.push(url);
    const m = /\/(\d{4}-\d\d-\d\d)\.\.(\d{4}-\d\d-\d\d)\?base=EUR&symbols=([A-Z,]+)$/.exec(url)!;
    const [, from, to, symbols] = m;
    const rates: Record<string, Record<string, number>> = {};
    for (const [d, r] of Object.entries(RATES)) {
      if (d < from || d > to) continue;
      rates[d] = Object.fromEntries(symbols.split(',').map((s) => [s, r[s]]));
    }
    return { base: 'EUR', rates };
  };
  return { urls, fetchJson };
}

const tmpFile = () => path.join(mkdtempSync(path.join(tmpdir(), 'fx-')), 'data', 'fx-rates.csv');

test('fills weekends from the previous publication day and persists every calendar day', async () => {
  const file = tmpFile();
  const api = fakeApi();
  const fx = new FxRateStore(file, api.fetchJson, () => '2026-11-01');
  await fx.ensure(['usd', 'eur'], ['2026-10-02', '2026-10-04']);

  assert.equal(api.urls.length, 1);
  assert.match(api.urls[0], /\/2026-09-25\.\.2026-10-04\?base=EUR&symbols=USD$/);
  assert.equal(fx.rate('usd', '2026-10-04'), 1.13); // Sunday -> Friday's rate
  assert.equal(fx.rate('eur', '2026-10-04'), 1);
  assert.deepEqual(readFileSync(file, 'utf8').trim().split('\n'), [
    'date,base,currency,rate,ecb_date',
    '2026-10-02,eur,usd,1.13,2026-10-02',
    '2026-10-03,eur,usd,1.13,2026-10-02',
    '2026-10-04,eur,usd,1.13,2026-10-02',
  ]);
});

test('does not refetch dates already in the file, only the gaps', async () => {
  const file = tmpFile();
  const first = fakeApi();
  await new FxRateStore(file, first.fetchJson, () => '2026-11-01').ensure(['usd'], ['2026-10-02', '2026-10-03']);
  assert.equal(first.urls.length, 1);

  const second = fakeApi();
  const fx = new FxRateStore(file, second.fetchJson, () => '2026-11-01');
  await fx.ensure(['usd'], ['2026-10-02', '2026-10-03']);
  assert.equal(second.urls.length, 0, 'everything cached');

  await fx.ensure(['usd', 'gbp'], ['2026-10-03', '2026-10-05']);
  assert.equal(second.urls.length, 1);
  assert.match(second.urls[0], /\/2026-09-26\.\.2026-10-05\?base=EUR&symbols=GBP,USD$/);
  assert.equal(fx.rate('gbp', '2026-10-03'), 0.86);
  assert.equal(fx.rate('usd', '2026-10-05'), 1.15);
});

test('refuses today and future dates without making a request', async () => {
  const api = fakeApi();
  const fx = new FxRateStore(tmpFile(), api.fetchJson, () => '2026-10-05');
  await assert.rejects(fx.ensure(['usd'], ['2026-10-02', '2026-10-05']), /only available for past dates \(got 2026-10-05\)/);
  assert.equal(api.urls.length, 0);
});

test('rejects currencies other than EUR, GBP and USD', async () => {
  const file = tmpFile();
  const fx = new FxRateStore(file, fakeApi().fetchJson);
  await assert.rejects(fx.ensure(['jpy'], ['2026-10-02']), /Unsupported currency "JPY"/);
  assert.throws(() => fx.rate('aed', '2026-10-02'), /Unsupported currency "AED"/);
});
