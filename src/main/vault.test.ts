import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLock, isValidPin, openSession, rewrap, sealSession, unlock, WrongPinError } from './vault';

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const KEY = 'rk_test_abc';

test('PINs are 4 to 8 digits', () => {
  for (const ok of ['1234', '12345678', '0000']) assert.ok(isValidPin(ok), ok);
  for (const bad of ['123', '123456789', '12a4', ' 1234', '', 1234, null]) assert.ok(!isValidPin(bad), String(bad));
});

test('sessions are sealed without the PIN and opened only with the PIN and the Stripe key', async () => {
  const { lock } = await createLock('2468', KEY, false, FAST);
  assert.equal(lock.stripeKey, undefined);
  const sealed = sealSession(lock, Buffer.from('secret report'));
  assert.ok(!JSON.stringify(sealed).includes('secret'));

  const { privateKey, stripeKey } = await unlock(lock, '2468', KEY);
  assert.equal(stripeKey, KEY);
  assert.equal(openSession(privateKey, sealed).toString(), 'secret report');

  await assert.rejects(unlock(lock, '1357', KEY), WrongPinError);
  // The same PIN with another Stripe key doesn't open it either.
  await assert.rejects(unlock(lock, '2468', 'rk_test_other'), WrongPinError);
  await assert.rejects(unlock(lock, 'abcd', KEY), WrongPinError);

  // Tampering is detected.
  const data = Buffer.from(sealed.data, 'base64');
  data[0] ^= 1;
  assert.throws(() => openSession(privateKey, { ...sealed, data: data.toString('base64') }), WrongPinError);
});

test('an encrypted Stripe key comes back from the PIN alone; rewrap keeps sessions readable', async () => {
  const { lock } = await createLock('2468', KEY, true, FAST);
  assert.ok(lock.stripeKey && !JSON.stringify(lock).includes(KEY));
  const sealed = sealSession(lock, Buffer.from('report'));
  const u = await unlock(lock, '2468');
  assert.equal(u.stripeKey, KEY);
  await assert.rejects(unlock(lock, '0000'), WrongPinError);

  // New PIN, key no longer encrypted: the old session still opens with the new PIN.
  const next = await rewrap(lock, u.privateKey, '97531', KEY, false, FAST);
  assert.equal(next.stripeKey, undefined);
  await assert.rejects(unlock(next, '2468', KEY), WrongPinError);
  const u2 = await unlock(next, '97531', KEY);
  assert.equal(openSession(u2.privateKey, sealed).toString(), 'report');
  await assert.rejects(unlock(next, '97531'), /No Stripe key/);
});
