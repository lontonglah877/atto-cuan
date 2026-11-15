// Uji loop 15 menit: jadwal rata ke batas 15 menit berikutnya.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { msUntilNextSlot } from '../src/loop.mjs';

const S = 15 * 60 * 1000;
test('loop: tepat di batas slot -> tunggu satu slot penuh', () => {
  assert.equal(msUntilNextSlot(S * 10), S);
});
test('loop: 1 ms setelah batas -> tunggu sisa slot', () => {
  assert.equal(msUntilNextSlot(S * 10 + 1), S - 1);
});
test('loop: tengah slot -> sisa tepat ke batas berikutnya', () => {
  assert.equal(msUntilNextSlot(S * 10 + 4 * 60 * 1000), 11 * 60 * 1000);
});
