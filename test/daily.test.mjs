// Uji laporan harian: digest 07:00 & heartbeat 08:00 lokal, tepat sekali per tanggal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { Clock } from '../src/clock.mjs';
import { StateStore, defaultState } from '../src/state-store.mjs';
import { buildEvent } from '../src/audit.mjs';
import { localHour, maybeSendDaily, digestStats, DIGEST_HOUR_LOCAL, HEARTBEAT_HOUR_LOCAL } from '../src/daily-report.mjs';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
config.operationalTimezone = 'Asia/Makassar';

// 2026-11-17 00:00 WITA == 2026-11-16 16:00 UTC
const WITA_MIDNIGHT_UTC = Date.UTC(2026, 10, 16, 16, 0, 0);
const at = (h, m = 0) => WITA_MIDNIGHT_UTC + h * 3600000 + m * 60000;

async function freshStore(nowMs) {
  const dir = await mkdtemp(path.join(tmpdir(), 'atto-daily-'));
  const clock = new Clock({ rawNow: () => nowMs });
  const store = new StateStore({ dataDir: path.join(dir, 'data'), config, clock, codeVersion: 'atto-cuan/1.5.0' });
  await store.init();
  const state = defaultState({ timezone: 'Asia/Makassar', equityReferenceIdr: 100000, nowMs });
  state.portfolio.equityReferenceIdr = 100000;
  state.portfolio.cashIdr = 100000;
  await store.save({ state });
  return { dir, store, clock };
}

const ob = async (store) => JSON.parse(await readFile(store.outboxFile, 'utf8').catch(() => '[]'));

test('localHour: batas pagi dihitung dalam WITA (UTC+8)', () => {
  assert.equal(localHour(at(DIGEST_HOUR_LOCAL - 1), 'Asia/Makassar'), 6);
  assert.equal(localHour(at(DIGEST_HOUR_LOCAL), 'Asia/Makassar'), 7);
  assert.equal(localHour(at(HEARTBEAT_HOUR_LOCAL), 'Asia/Makassar'), 8);
});

test('daily: sebelum 07:00 lokal belum ada pesan', async () => {
  const nowMs = at(6, 59);
  const { dir, store, clock } = await freshStore(nowMs);
  try {
    const r = await maybeSendDaily({ store, config, clock, nowMs });
    assert.deepEqual(r, { digest: false, heartbeat: false, dateLocal: '2026-11-17' });
    assert.equal((await ob(store)).length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('daily: 07:00 lokal -> digest terkirim, heartbeat belum', async () => {
  const nowMs = at(7, 1);
  const { dir, store, clock } = await freshStore(nowMs);
  try {
    const r = await maybeSendDaily({ store, config, clock, nowMs });
    assert.equal(r.digest, true);
    assert.equal(r.heartbeat, false);
    const items = await ob(store);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, 'DIGEST');
    assert.equal(items[0].idempotencyKey, 'DIGEST:2026-11-17');
    assert.match(items[0].payload.text, /DAILY DIGEST ATTO CUAN/);
    assert.match(items[0].payload.text, /Sinyal adalah informasi, bukan perintah/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('daily: 08:00 lokal -> digest + heartbeat, sekali saja per tanggal', async () => {
  const nowMs = at(8, 5);
  const { dir, store, clock } = await freshStore(nowMs);
  try {
    const first = await maybeSendDaily({ store, config, clock, nowMs });
    assert.deepEqual([first.digest, first.heartbeat], [true, true]);
    const items = await ob(store);
    assert.deepEqual(items.map((i) => i.kind).sort(), ['DIGEST', 'HEARTBEAT']);
    assert.match(items.find((i) => i.kind === 'HEARTBEAT').payload.text, /HEARTBEAT ATTO CUAN/);

    // Siklus 15 menit berikutnya di hari yang sama tidak boleh mendobel.
    const second = await maybeSendDaily({ store, config, clock, nowMs: at(8, 20) });
    assert.deepEqual([second.digest, second.heartbeat], [false, false]);
    assert.equal((await ob(store)).length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('daily: tanggal berganti -> digest terbit lagi', async () => {
  const nowMs = at(7, 5);
  const { dir, store, clock } = await freshStore(nowMs);
  try {
    await maybeSendDaily({ store, config, clock, nowMs });
    const r = await maybeSendDaily({ store, config, clock, nowMs: nowMs + 24 * 3600000 });
    assert.equal(r.dateLocal, '2026-11-18');
    assert.equal(r.digest, true);
    const keys = (await ob(store)).map((i) => i.idempotencyKey);
    assert.deepEqual(keys, ['DIGEST:2026-11-17', 'DIGEST:2026-11-18']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('digestStats: menghitung sinyal 24 jam dari rantai audit', async () => {
  const nowMs = at(7, 0);
  const { dir, store } = await freshStore(nowMs);
  try {
    const events = [];
    let prev = '0'.repeat(64);
    let seq = 0;
    for (const [kind, offset] of [['SIGNAL_ISSUED', -3600000], ['SIGNAL_BLOCKED', -7200000], ['SIGNAL_EXPIRED_UNRESOLVED', -30 * 3600000]]) {
      seq += 1;
      const e = buildEvent({ seq, prevHash: prev, body: { kind, timestampUtc: new Date(nowMs + offset).toISOString() }, codeVersion: 'atto-cuan/1.5.0' });
      events.push(e); prev = e.eventHash;
    }
    await writeFile(store.eventsFile, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const stats = await digestStats({ eventsFile: store.eventsFile, nowMs, positions: [] });
    assert.equal(stats.issued24h, 1);
    assert.equal(stats.blocked24h, 1);
    assert.equal(stats.expired24h, 0, 'kejadian 30 jam lalu di luar jendela 24 jam');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
