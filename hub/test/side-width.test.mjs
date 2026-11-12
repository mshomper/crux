// The resizable sidebar (side-width.js): limits and the stored width.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SIDE_DEFAULT, sideMax, clampSide, storedSide } from '../public/side-width.js';

test('default is today\'s width and the narrowest it goes', () => {
  assert.equal(SIDE_DEFAULT, 268);
  assert.equal(clampSide(100, 1600), 268);
});

test('at most 40% of the window, never under the default', () => {
  assert.equal(sideMax(2000), 800);
  assert.equal(clampSide(900, 2000), 800);
  assert.equal(clampSide(420.4, 2000), 420);
  assert.equal(sideMax(600), 268, 'a narrow window keeps the default');
  assert.equal(clampSide(500, 600), 268);
});

test('a stored width comes back clamped; junk or nothing means the default', () => {
  assert.equal(storedSide('400', 1600), 400);
  assert.equal(storedSide('5000', 1600), 640);
  assert.equal(storedSide(null, 1600), null);
  assert.equal(storedSide('', 1600), null);
  assert.equal(storedSide('wide', 1600), null);
  assert.equal(storedSide('500', Infinity), 500, 'read once without a window: kept as chosen');
});
