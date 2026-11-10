import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_SETTINGS, loadSettings, normalizeSettings, saveSettings } from './settings';

test('defaults: finalized statuses, created within the period only', () => {
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(DEFAULT_SETTINGS.vatFetch, { statuses: ['paid', 'open', 'uncollectible'], lookbackDays: 0, includeCreatedAfter: false });
});

test('keeps valid fields, drops bad ones field by field', () => {
  const s = normalizeSettings({ vatFetch: { statuses: ['void', 'bogus', 'paid', 'paid'], lookbackDays: 92, includeCreatedAfter: true } });
  assert.deepEqual(s.vatFetch, { statuses: ['paid', 'void'], lookbackDays: 92, includeCreatedAfter: true });

  const bad = normalizeSettings({ vatFetch: { statuses: [], lookbackDays: -1, includeCreatedAfter: 'yes' } });
  assert.deepEqual(bad, DEFAULT_SETTINGS);
  assert.equal(normalizeSettings({ vatFetch: { lookbackDays: 1.5 } }).vatFetch.lookbackDays, 0);
});

test('saves and loads; a missing or broken file gives the defaults', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'settings-'));
  const file = path.join(dir, 'nested', 'settings.json');
  assert.deepEqual(await loadSettings(file), DEFAULT_SETTINGS);

  const saved = await saveSettings(file, { vatFetch: { statuses: ['draft'], lookbackDays: 365, includeCreatedAfter: true } });
  assert.deepEqual(await loadSettings(file), saved);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).vatFetch.statuses, ['draft']);

  writeFileSync(file, '{ not json');
  assert.deepEqual(await loadSettings(file), DEFAULT_SETTINGS);
});
