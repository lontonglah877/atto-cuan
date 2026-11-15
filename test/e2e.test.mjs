// Uji integrasi runOnce: direktori data sementara, jaringan dipalsukan, transport palsu.
// Membuktikan alur utuh berjalan dan audit berantai tetap valid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runOnce } from '../src/sentinel.v150.mjs';
import { readEvents, verifyChain } from '../src/audit.mjs';

const NOW = Date.parse('2026-11-14T02:00:00Z');

/** Jam lokal yang maju 25 ms per pembacaan: RTT > 0 seperti jaringan nyata. */
function stepClock() {
  let t = NOW;
  return () => { t += 25; return t; };
}

function fakeFetch(url) {
  const u = String(url);
  const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  if (u.includes('/api/v3/time')) return ok({ serverTime: NOW });
  if (u.includes('/server_time')) return ok({ timezone: 'UTC', server_time: NOW });
  if (u.includes('/ticker/')) return ok({ ticker: { buy: '1000000000', sell: '1000100000', last: '1000050000', high: '1010000000', low: '990000000', vol_idr: '1', server_time: Math.floor(NOW / 1000) } });
  // Klines/book: kosong -> pipeline harus menolak dengan aman (fail-closed), bukan crash.
  if (u.includes('/api/v3/klines')) return ok([]);
  if (u.includes('/bookTicker')) return ok({ bidPrice: '1', askPrice: '2' });
  if (u.includes('/depth/')) return ok({ sell: [], buy: [] });
  return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
}

test('runOnce: alur utuh tanpa data sah -> fail-closed, tidak ada sinyal, audit valid', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'atto-e2e-'));
  try {
    await cp('config.json', path.join(dir, 'config.json'));
    await cp('strategy.json', path.join(dir, 'strategy.json'));
    const logs = [];
    const r = await runOnce({ dir, dataDir: path.join(dir, 'data'), env: {}, transport: { send: async () => ({ ok: true, messageId: 1 }), name: 'fake' }, fetchImpl: fakeFetch, rawNow: stepClock(), log: (k, d) => logs.push({ k, ...d }) });
    assert.equal(r.skipped, undefined, JSON.stringify(r));
    assert.equal(r.clock?.ok, true, 'jam sinkron dari sumber palsu');
    assert.equal(r.signal.symbols.every((s) => s.status !== 'ISSUED'), true, 'tanpa data sah tidak boleh ada sinyal');
    assert.ok(Array.isArray(r.errors));
    const events = await readEvents(path.join(dir, 'data', 'events.jsonl')).catch(() => []);
    const v = await verifyChain(events);
    assert.equal(v.ok, true, JSON.stringify(v.problems));
    // Lock harus sudah dilepas.
    await assert.doesNotReject(readFile(path.join(dir, 'data', 'locks', 'instance.lock'), 'utf8').then(() => { throw new Error('lock masih ada'); }, () => null));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runOnce: token dan chat ID kosong -> dry-run, bukan error', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'atto-e2e-'));
  try {
    await cp('config.json', path.join(dir, 'config.json'));
    await cp('strategy.json', path.join(dir, 'strategy.json'));
    const r = await runOnce({ dir, dataDir: path.join(dir, 'data'), env: {}, fetchImpl: fakeFetch, nowMs: NOW });
    assert.equal(r.skipped, undefined);
    assert.equal(r.notifier.failed, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
