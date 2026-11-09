import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheDir } from './paths';

test('cache dir follows each platform convention', () => {
  assert.equal(cacheDir('linux', {}, '/home/a'), '/home/a/.cache/vaslabs-ltd/stripe-analytics');
  assert.equal(cacheDir('linux', { XDG_CACHE_HOME: '/x/cache' }, '/home/a'), '/x/cache/vaslabs-ltd/stripe-analytics');
  assert.equal(cacheDir('linux', { XDG_CACHE_HOME: 'relative' }, '/home/a'), '/home/a/.cache/vaslabs-ltd/stripe-analytics');
  assert.equal(
    cacheDir('win32', { LOCALAPPDATA: 'C:\\Users\\acc\\AppData\\Local' }, 'C:\\Users\\acc'),
    'C:\\Users\\acc\\AppData\\Local\\vaslabs-ltd\\stripe-analytics\\Cache',
  );
  assert.equal(cacheDir('win32', {}, 'C:\\Users\\acc'), 'C:\\Users\\acc\\AppData\\Local\\vaslabs-ltd\\stripe-analytics\\Cache');
  assert.equal(cacheDir('darwin', {}, '/Users/a'), '/Users/a/Library/Caches/vaslabs-ltd/stripe-analytics');
});
