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

import { seedDataIfEmpty } from '../src/loop.mjs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('seed: data/ kosong -> disalin dari seed/', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'atto-seed-'));
  try {
    await mkdir(path.join(dir, 'seed'), { recursive: true });
    await writeFile(path.join(dir, 'seed', 'state.json'), '{"a":1}');
    await writeFile(path.join(dir, 'seed', 'events.jsonl'), '');
    const r = await seedDataIfEmpty(dir);
    assert.deepEqual(r, ['state.json', 'events.jsonl']);
    assert.equal(await readFile(path.join(dir, 'data', 'state.json'), 'utf8'), '{"a":1}');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('seed: data/ sudah ada -> tidak menimpa', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'atto-seed-'));
  try {
    await mkdir(path.join(dir, 'seed'), { recursive: true });
    await mkdir(path.join(dir, 'data'), { recursive: true });
    await writeFile(path.join(dir, 'seed', 'state.json'), '{"seed":true}');
    await writeFile(path.join(dir, 'data', 'state.json'), '{"live":true}');
    assert.equal(await seedDataIfEmpty(dir), false);
    assert.equal(await readFile(path.join(dir, 'data', 'state.json'), 'utf8'), '{"live":true}');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
