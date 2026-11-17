import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { COMPANY_FILE, fileStore, LOCK_FILE, memoryStore, SESSION_FILE, SessionVault } from './session';

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const KEY = 'rk_test_abc';
const session = { version: 1, savedAt: 'now', revenue: { customers: ['Acme (demo)'] } };

test('nothing is kept without a PIN; with one, the session is saved encrypted and restored after a restart', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'session-'));
  const v = new SessionVault(fileStore(dir), FAST);
  assert.equal(await v.save(session), false);
  assert.deepEqual(await v.status(), { pinSet: false, encryptsKey: false, hasSession: false, hasCompany: false, unlocked: false });

  await v.setPin({ pin: '1234', encryptStripeKey: false, stripeKey: KEY });
  assert.equal(await v.save(session), true);
  const raw = readFileSync(path.join(dir, SESSION_FILE), 'utf8');
  assert.ok(!raw.includes('Acme'));
  if (process.platform !== 'win32') assert.equal(statSync(path.join(dir, SESSION_FILE)).mode & 0o777, 0o600);
  assert.deepEqual(v.restore(), session);

  // "Restart": a new vault on the same files is locked until the PIN is entered.
  const v2 = new SessionVault(fileStore(dir), FAST);
  assert.deepEqual(await v2.status(), { pinSet: true, encryptsKey: false, hasSession: true, hasCompany: false, unlocked: false });
  assert.equal(v2.restore(), null);
  await assert.rejects(v2.unlock('9999', KEY), /Wrong PIN/);
  assert.deepEqual((await v2.unlock('1234', KEY)).session, session);
  // Locked sessions can still be replaced (sealed to the public key).
  const v3 = new SessionVault(fileStore(dir), FAST);
  await v3.save({ ...session, savedAt: 'later' });
  assert.equal(((await v3.unlock('1234', KEY)).session as { savedAt: string }).savedAt, 'later');
});

test('changing the PIN needs the current one; encrypting the key; removing and resetting', async () => {
  const v = new SessionVault(memoryStore(), FAST);
  await v.setPin({ pin: '1234', encryptStripeKey: false, stripeKey: KEY });
  await v.save(session);
  await assert.rejects(v.setPin({ currentPin: '0000', pin: '5678', encryptStripeKey: true, stripeKey: KEY }), /current PIN is wrong/);
  await v.setPin({ currentPin: '1234', pin: '5678', encryptStripeKey: true, stripeKey: KEY });
  assert.equal((await v.status()).encryptsKey, true);
  v.lockNow();
  assert.equal(v.restore(), null);
  const u = await v.unlock('5678');
  assert.equal(u.stripeKey, KEY);
  assert.deepEqual(u.session, session);

  await assert.rejects(v.removePin('1234'), /current PIN is wrong/);
  assert.equal(await v.removePin('5678'), KEY);
  assert.deepEqual(await v.status(), { pinSet: false, encryptsKey: false, hasSession: false, hasCompany: false, unlocked: false });
});

test('a new Stripe key deletes the session; the PIN is kept only while unlocked', async () => {
  const store = memoryStore();
  const v = new SessionVault(store, FAST);
  await v.setPin({ pin: '1234', encryptStripeKey: true, stripeKey: KEY });
  await v.save(session);
  assert.deepEqual(await v.stripeKeyChanged('rk_test_new'), { keptPin: true, encryptsKey: true });
  assert.equal(await store.read(SESSION_FILE), null);
  v.lockNow();
  assert.equal((await v.unlock('1234')).stripeKey, 'rk_test_new');

  v.lockNow();
  assert.deepEqual(await v.stripeKeyChanged('rk_test_newer'), { keptPin: false, encryptsKey: false });
  assert.equal(await store.read(LOCK_FILE), null);

  await v.setPin({ pin: '1234', encryptStripeKey: false, stripeKey: KEY });
  await v.reset();
  assert.equal((await v.status()).pinSet, false);
});

const company = { name: 'Acme Ltd', address: '1 Main St', country: 'Cyprus', email: '', website: '', registration: 'HE 1' };

test('company details: in memory without a PIN, encrypted with one, unreadable while locked', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'company-'));
  const v = new SessionVault(fileStore(dir), FAST);
  // No PIN: kept for this run only.
  assert.deepEqual(await v.company(), { company: null, kept: false, locked: false });
  assert.equal(await v.saveCompany(company), false);
  assert.deepEqual(await v.company(), { company, kept: false, locked: false });
  assert.equal(await fileStore(dir).read(COMPANY_FILE), null);

  // Setting a PIN keeps what was entered, encrypted.
  await v.setPin({ pin: '1234', encryptStripeKey: false, stripeKey: KEY });
  const raw = readFileSync(path.join(dir, COMPANY_FILE), 'utf8');
  assert.ok(!raw.includes('Acme'));
  if (process.platform !== 'win32') assert.equal(statSync(path.join(dir, COMPANY_FILE)).mode & 0o777, 0o600);
  assert.equal(await v.saveCompany({ ...company, name: 'Acme Edited' }), true);

  // Restart: locked until the PIN is entered, and can't be overwritten meanwhile.
  const v2 = new SessionVault(fileStore(dir), FAST);
  assert.deepEqual(await v2.company(), { company: null, kept: true, locked: true });
  assert.deepEqual(await v2.status(), { pinSet: true, encryptsKey: false, hasSession: false, hasCompany: true, unlocked: false });
  await assert.rejects(v2.saveCompany(company), /Unlock with the PIN first/);
  await v2.unlock('1234', KEY);
  assert.deepEqual(await v2.company(), { company: { ...company, name: 'Acme Edited' }, kept: true, locked: false });

  // Removing the PIN deletes the file.
  await v2.removePin('1234', KEY);
  assert.equal(await fileStore(dir).read(COMPANY_FILE), null);
});

test('a sealed company file is not accepted as a session, nor the other way round', async () => {
  const store = memoryStore();
  const v = new SessionVault(store, FAST);
  await v.setPin({ pin: '1234', encryptStripeKey: false, stripeKey: KEY });
  await v.saveCompany(company);
  await v.save(session);
  const sealedCompany = (await store.read(COMPANY_FILE))!;
  const sealedSession = (await store.read(SESSION_FILE))!;
  await store.write(SESSION_FILE, sealedCompany);
  await store.write(COMPANY_FILE, sealedSession);
  v.lockNow();
  assert.equal((await v.unlock('1234', KEY)).session, null);
  assert.deepEqual(await v.company(), { company: null, kept: true, locked: false });
});

test('a new Stripe key keeps the company details while unlocked (same PIN), drops them otherwise', async () => {
  const store = memoryStore();
  const v = new SessionVault(store, FAST);
  await v.setPin({ pin: '1234', encryptStripeKey: false, stripeKey: KEY });
  await v.saveCompany(company);
  await v.stripeKeyChanged('rk_test_new');
  v.lockNow();
  await v.unlock('1234', 'rk_test_new');
  assert.deepEqual((await v.company()).company, company);
  v.lockNow();
  await v.stripeKeyChanged('rk_test_newer');
  assert.equal(await store.read(COMPANY_FILE), null);
});
