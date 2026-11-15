// Tes Telegram & entrypoint. fetch dipalsukan: tidak ada pesan sungguhan yang terkirim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TelegramTransport, redact } from '../src/telegram.mjs';
import { parseEnv } from '../src/env.mjs';
import { drainOutbox } from '../src/notifier.mjs';
import { enqueue, PRIORITY } from '../src/outbox.mjs';
import { renderSignal, esc } from '../src/messages.mjs';

const TOKEN = '123456789:AAFAKE_TOKEN_FOR_TESTS_0123456789abcdef';

const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('telegram: sukses -> ok + message_id', async () => {
  let call;
  const t = new TelegramTransport({ token: TOKEN, chatId: '42', fetchImpl: async (url, opt) => { call = { url, opt }; return jsonRes(200, { ok: true, result: { message_id: 7 } }); } });
  const r = await t.send({ text: 'halo' });
  assert.equal(r.ok, true);
  assert.equal(r.messageId, 7);
  assert.ok(call.url.endsWith('/sendMessage'));
  const body = JSON.parse(call.opt.body);
  assert.equal(body.chat_id, '42');
  assert.equal(body.parse_mode, 'HTML');
});

test('telegram: 429 -> sementara dengan retry_after', async () => {
  const t = new TelegramTransport({ token: TOKEN, chatId: '42', fetchImpl: async () => jsonRes(429, { ok: false, description: 'Too Many Requests', parameters: { retry_after: 12 } }) });
  const r = await t.send({ text: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.permanent, false);
  assert.equal(r.retryAfterSec, 12);
});

test('telegram: 5xx dan jaringan -> sementara', async () => {
  const t1 = new TelegramTransport({ token: TOKEN, chatId: '42', fetchImpl: async () => jsonRes(503, { ok: false }) });
  assert.equal((await t1.send({ text: 'x' })).permanent, false);
  const t2 = new TelegramTransport({ token: TOKEN, chatId: '42', fetchImpl: async () => { throw Object.assign(new Error('boom'), { name: 'TypeError' }); } });
  const r2 = await t2.send({ text: 'x' });
  assert.equal(r2.permanent, false);
});

test('telegram: 400/403 -> permanen (jangan diulang)', async () => {
  const t = new TelegramTransport({ token: TOKEN, chatId: '42', fetchImpl: async () => jsonRes(403, { ok: false, description: 'Forbidden: bot was blocked' }) });
  const r = await t.send({ text: 'x' });
  assert.equal(r.permanent, true);
});

test('telegram: config kosong menolak konstruksi (fail-closed)', () => {
  assert.throws(() => new TelegramTransport({ token: '', chatId: '42' }), /TELEGRAM_CONFIG_MISSING/);
  assert.throws(() => new TelegramTransport({ token: TOKEN, chatId: '' }), /TELEGRAM_CONFIG_MISSING/);
});

test('telegram: redact menghapus token dari teks error', () => {
  assert.equal(redact(`gagal ${TOKEN} selesai`, TOKEN), 'gagal [REDACTED] selesai');
});

test('env: parse dan kutip, komentar diabaikan', () => {
  const env = parseEnv('# c\nA=1\nB="dua"\nC=\'tiga\'\n\nD=empat=5\n');
  assert.deepEqual(env, { A: '1', B: 'dua', C: 'tiga', D: 'empat=5' });
});

test('notifier: kirim, lalu tandai SENT; pesan kedua dengan kunci sama tidak terkirim ulang', async () => {
  const sent = [];
  const transport = { send: async (m) => { sent.push(m); return { ok: true, messageId: sent.length }; } };
  const now = Date.parse('2026-11-14T01:00:00Z');
  const outbox = [];
  enqueue(outbox, { idempotencyKey: 'K1', priority: PRIORITY.P0, kind: 'X', text: 'satu', nowMs: now });
  enqueue(outbox, { idempotencyKey: 'K1', priority: PRIORITY.P0, kind: 'X', text: 'satu', nowMs: now });
  assert.equal(outbox.length, 1);

  let stored = outbox;
  const store = {
    loadOutbox: async () => structuredClone(stored),
    transact: async (fn) => {
      const state = {};
      const ob = structuredClone(stored);
      const r = fn(state, ob) || {};
      if (!r.skip) stored = ob;
      return r;
    },
  };
  const config = { telegram: { rateLimitPerMinute: 20, maxMessageChars: 4096 } };
  const clock = { trustedNow: () => now };
  const s1 = await drainOutbox({ store, transport, config, clock, nowMs: now });
  assert.equal(s1.sent, 1);
  assert.equal(sent.length, 1);
  const s2 = await drainOutbox({ store, transport, config, clock, nowMs: now + 1000 });
  assert.equal(s2.sent, 0, 'item SENT tidak dikirim ulang');
});

test('notifier: gagal permanen ditandai FAILED_PERMANENT, tidak diulang', async () => {
  const transport = { send: async () => ({ ok: false, error: 'REJECTED:403', permanent: true }) };
  const now = Date.parse('2026-11-14T01:00:00Z');
  let stored = [];
  enqueue(stored, { idempotencyKey: 'K', priority: PRIORITY.P1, kind: 'X', text: 't', nowMs: now });
  const store = {
    loadOutbox: async () => structuredClone(stored),
    transact: async (fn) => { const ob = structuredClone(stored); const r = fn({}, ob) || {}; if (!r.skip) stored = ob; return r; },
  };
  const stats = await drainOutbox({ store, transport, config: { telegram: { rateLimitPerMinute: 20, maxMessageChars: 4096 } }, clock: { trustedNow: () => now }, nowMs: now });
  assert.equal(stats.failed, 1);
  assert.equal(stored[0].status, 'FAILED_PERMANENT');
});

test('messages: HTML di data pasar di-escape (tidak bisa menyisipkan tag)', () => {
  assert.equal(esc('<script>&'), '&lt;script&gt;&amp;');
  const text = renderSignal({
    signal: {
      signalId: 'BTC-1', symbol: 'BTCUSDT', pair: 'btc_idr', candleCloseTimeUtc: '2026-11-14T01:00:00.000Z', expiresAtUtc: '2026-11-14T01:45:00.000Z',
      sizing: { qty: 0.001, notionalIdr: 1e6, netRR: 1.5, breakEvenWinRatePct: 40, plannedNetRiskIdr: 1e4, plannedRiskPct: 0.02, projectedOpenRiskPct: 0.02, measuredSlipPct: 0.05, capStatus: 'RISK_BASED' },
      entryReferenceIdr: 1e9, stopLossIdr: 9.7e8, takeProfitIdr: 1.06e9, atrPct: 2, atrIdr: 2e7,
    },
    metrics: { trendUp: true, close4h: 1e9, ema200_4h: 9e8, rsiPrev: 28, rsiNow: 32, rsiOversold: 30, volume: 10, volumeMa20Prev: 12, volumeRatio: 0.8, atrUsdt: 2000, atrPct: 2, slAtrMult: 1.5, tpAtrMult: 3 },
    snapshot: { analysisStatus: 'FRESH', clockOffsetMs: 10, localStatus: 'FRESH', spreadPct: 0.1, devPct: 0.2, guardrailStatus: 'NORMAL', usdtMidIdr: 16000 },
    config: JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8')),
    tz: 'Asia/Makassar',
  });
  assert.ok(text.includes('bukan perintah beli'));
  assert.ok(!/beli sekarang/i.test(text));
  assert.ok(text.includes('Candle 1H:'));
});
