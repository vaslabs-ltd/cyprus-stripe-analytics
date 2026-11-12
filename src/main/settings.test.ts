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

test('contractors: valid ones kept, assignments only to contractors that exist', () => {
  const s = normalizeSettings({
    contractors: [
      { id: 'ctr_a', name: '  Ann  ' },
      { id: 'ctr_a', name: 'Duplicate' },
      { id: 'bad id!', name: 'Bad' },
      { id: 'ctr_b', name: '' },
      { id: 'ctr_c', name: 'Cat' },
      'nonsense',
    ],
    productContractors: { prod_1: 'ctr_a', prod_2: 'ctr_gone', prod_3: 'ctr_c', 'bad key': 'ctr_a', prod_4: 7 },
  });
  assert.deepEqual(s.contractors, [
    { id: 'ctr_a', name: 'Ann' },
    { id: 'ctr_c', name: 'Cat' },
  ]);
  assert.deepEqual(s.productContractors, { prod_1: 'ctr_a', prod_3: 'ctr_c' });
  // Removing a contractor drops their assignments.
  assert.deepEqual(normalizeSettings({ ...s, contractors: [s.contractors[1]] }).productContractors, { prod_3: 'ctr_c' });
  assert.deepEqual(normalizeSettings({ productContractors: [] }).productContractors, {});
});

test('product names are kept for assigned products only', () => {
  const s = normalizeSettings({
    contractors: [{ id: 'ctr_a', name: 'Ann' }],
    productContractors: { prod_1: 'ctr_a' },
    productNames: { prod_1: '  Development  ', prod_2: 'Not assigned', prod_3: 5 },
  });
  assert.deepEqual(s.productNames, { prod_1: 'Development' });
});
