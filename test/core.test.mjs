// Uji unit inti v1.5.0. Jalankan: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalize, sha256Canonical, GENESIS_HASH } from '../src/canonical-json.mjs';
import { Clock, estimateOffset, combineOffsets, classifyClock, median } from '../src/clock.mjs';
import { sma, ema } from '../src/indicators.mjs';
import { roundDownToStep, planLevels, costGate, sizePosition, feeFactors } from '../src/risk-engine.mjs';
import { nextTick, shouldSkip, msUntilLocalTime, MINUTE } from '../src/scheduler.mjs';
import { enqueue, dueItems, markFailed, markSent, PRIORITY } from '../src/outbox.mjs';
import { buildEvent, verifyChain } from '../src/audit.mjs';
import { validateTicker, validateCandleShape, depthWalk, updateGuardrail } from '../src/data-quality.mjs';
import { validateConfig, validateStrategy } from '../src/config.mjs';
import { pairSlug } from '../src/collector.mjs';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const strategy = JSON.parse(readFileSync(new URL('../strategy.json', import.meta.url), 'utf8'));

test('canonical JSON: urutan kunci tidak mengubah hash', () => {
  assert.equal(sha256Canonical({ a: 1, b: [2, 3] }), sha256Canonical({ b: [2, 3], a: 1 }));
  assert.notEqual(sha256Canonical({ a: 1 }), sha256Canonical({ a: 2 }));
  assert.equal(GENESIS_HASH.length, 64);
});

test('canonical JSON: menolak NaN/Infinity', () => {
  assert.throws(() => canonicalize({ x: Number.NaN }));
  assert.throws(() => canonicalize({ x: Infinity }));
});

test('clock: offset RTT-compensated nol bila jam sama', () => {
  const samples = [
    { t0: 1000, t1: 1100, serverTimeMs: 1050 },
    { t0: 2000, t1: 2100, serverTimeMs: 2050 },
    { t0: 3000, t1: 3100, serverTimeMs: 3050 },
  ];
  const r = estimateOffset({ samples, rttMaxMs: 2000 });
  assert.equal(r.status, 'OK');
  assert.equal(r.offsetMs, 0);
});

test('clock: RTT terlalu besar ditolak', () => {
  const r = estimateOffset({ samples: [{ t0: 0, t1: 5000, serverTimeMs: 2500 }, { t0: 0, t1: 5000, serverTimeMs: 2500 }], rttMaxMs: 2000 });
  assert.equal(r.status, 'UNKNOWN');
});

test('clock: dua sumber tidak sepakat -> UNKNOWN (fail-closed)', () => {
  assert.equal(combineOffsets({ a: 0, b: 5000, maxAgreeMs: 2000 }).status, 'UNKNOWN');
  assert.equal(combineOffsets({ a: 100, b: 300, maxAgreeMs: 2000 }).status, 'OK');
});

test('clock: klasifikasi ambang warn/block', () => {
  assert.equal(classifyClock(500, { warnMs: 10000, blockMs: 30000 }), 'OK');
  assert.equal(classifyClock(15000, { warnMs: 10000, blockMs: 30000 }), 'CLOCK_DRIFT_WARNING');
  assert.equal(classifyClock(40000, { warnMs: 10000, blockMs: 30000 }), 'CLOCK_INVALID');
  assert.equal(median([1, 3, 2]), 2);
});

test('clock: trustedNow mengurangi offset', () => {
  const c = new Clock({ rawNow: () => 10_000 });
  c.setOffset(2_000, 'OK');
  assert.equal(c.trustedNow(), 8_000);
});

test('indikator: SMA dan EMA pada deret konstan', () => {
  const v = Array(300).fill(42);
  assert.equal(sma(v, 20), 42);
  assert.equal(ema(v, 200).at(-1), 42);
});

test('risk: roundDownToStep selalu turun', () => {
  assert.equal(roundDownToStep(1234.5, 1000), 1000);
  assert.equal(roundDownToStep(0.000000123, 1e-8), 0.00000012);
});

test('risk: planLevels mengikuti rumus ATR', () => {
  const p = planLevels({ entryRefIdr: 1_000_000, atrPct: 2, slAtrMult: 1.5, tpAtrMult: 3, tickSize: 1000 });
  assert.equal(p.atrIdr, 20_000);
  assert.equal(p.stopLossIdr, 970_000);
  assert.equal(p.takeProfitIdr, 1_060_000);
});

test('risk: Cost-Aware Gate tanpa biaya -> netRR 1 dan BE 50%', () => {
  const g = costGate({ entryRefIdr: 1000, stopLossIdr: 900, takeProfitIdr: 1100, fEntry: 0, fExit: 0, limits: { minNetRR: 1, maxCostToStopRatio: 0.5, maxBeWinRatePct: 55 } });
  assert.equal(g.netRR, 1);
  assert.equal(g.beWinPct, 50);
  assert.equal(g.ok, true);
});

test('risk: biaya tinggi menolak sinyal (COST_DOMINATED)', () => {
  const g = costGate({ entryRefIdr: 1000, stopLossIdr: 990, takeProfitIdr: 1010, fEntry: 0.005, fExit: 0.005, limits: { minNetRR: 1.2, maxCostToStopRatio: 0.5, maxBeWinRatePct: 55 } });
  assert.equal(g.ok, false);
  assert.ok(g.reasons.includes('COST_DOMINATED'));
});

test('risk: sizing tidak pernah melebihi batas risiko per trade', () => {
  const fees = feeFactors(config.costs);
  const E = 50_000_000;
  const asks = [[1_000_000, 100], [1_001_000, 100], [1_002_000, 100]];
  const lots = config.exchangeRules.btc_idr;
  const limits = { ...config.risk, slippageEntryFloor: fees.slipBuy };
  const r = sizePosition({
    equityReferenceIdr: E, availableCashIdr: E, openRiskNow: 0, clusterRiskNow: 0,
    entryRefIdr: 1_000_000, stopLossIdr: 970_000, fEntry: fees.fEntry, fExit: fees.fExit,
    asks, lots, limits,
  });
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.ok(r.qty > 0);
  assert.ok(r.plannedNetRiskIdr <= (config.risk.maxRiskPerTradePct / 100) * E + 1e-6);
  assert.ok(r.notionalIdr <= (config.risk.maxSpotAllocationPct / 100) * E + 1e-6);
});

test('risk: batas klaster crypto-beta mengikat (kedua koin)', () => {
  const fees = feeFactors(config.costs);
  const E = 50_000_000;
  const asks = [[1_000_000, 100]];
  const r = sizePosition({
    equityReferenceIdr: E, availableCashIdr: E, openRiskNow: 0,
    clusterRiskNow: (config.risk.maxClusterOpenRiskPct / 100) * E - 1000, // sisa 1000 IDR
    entryRefIdr: 1_000_000, stopLossIdr: 970_000, fEntry: fees.fEntry, fExit: fees.fExit,
    asks, lots: config.exchangeRules.btc_idr, limits: { ...config.risk, slippageEntryFloor: fees.slipBuy },
  });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.includes('CLUSTER_RISK_LIMIT'));
});

test('data: depth-walk menandai likuiditas tidak cukup', () => {
  const w = depthWalk([[100, 1]], 5, 100);
  assert.equal(w.insufficient, true);
});

test('data: ticker stale/invalid/crossed ditolak', () => {
  const now = 1_000_000_000;
  assert.equal(validateTicker({ ticker: { bid: 9, ask: 10, marketTimeMs: now - 1000 }, nowMs: now, maxAgeSec: 30 }).status, 'FRESH');
  assert.equal(validateTicker({ ticker: { bid: 9, ask: 10, marketTimeMs: now - 60_000 }, nowMs: now, maxAgeSec: 30 }).status, 'STALE');
  assert.equal(validateTicker({ ticker: { bid: 11, ask: 10, marketTimeMs: now }, nowMs: now, maxAgeSec: 30 }).status, 'INVALID');
  assert.equal(validateTicker({ ticker: { bid: 9, ask: 10, marketTimeMs: now }, nowMs: now, maxAgeSec: null }).status, 'UNKNOWN');
});

test('data: guardrail histeresis masuk 2%, pulih <1,8%', () => {
  const base = { thetaInPct: 2, thetaOutPct: 1.8, recoverCycles: 3 };
  let g = updateGuardrail(null, { devPct: 2.5, dataStatus: 'FRESH', ...base });
  assert.equal(g.status, 'ANOMALY');
  g = updateGuardrail(g, { devPct: 1.9, dataStatus: 'FRESH', ...base });
  assert.equal(g.status, 'ANOMALY', 'tetap anomali di antara 1,8 dan 2,0');
  for (let i = 0; i < 3; i += 1) g = updateGuardrail(g, { devPct: 0.2, dataStatus: 'FRESH', ...base });
  assert.equal(g.status, 'NORMAL');
});

test('data: candle bentuk tidak valid ditolak (mengembalikan kode alasan)', () => {
  assert.equal(validateCandleShape({ open: 1, high: 0.5, low: 1, close: 1, closeTime: 2, openTime: 1, volume: 1 }), 'CANDLE_HIGH_INVALID');
  assert.equal(validateCandleShape({ open: 1, high: 2, low: 0.5, close: 1, closeTime: 2, openTime: 1, volume: 1 }), null);
});

test('jadwal: nextTick selalu tick grid berikutnya (strictly > now)', () => {
  assert.equal(nextTick(1_000, 60_000, 5_000), 5_000);
  assert.equal(nextTick(64_999, 60_000, 5_000), 65_000);
  assert.equal(nextTick(65_000, 60_000, 5_000), 125_000);
});

test('jadwal: siklus overlap dilewati, tidak burst', () => {
  assert.equal(shouldSkip({ running: true, lastStartedAtMs: 0, nowMs: 5 * MINUTE, intervalMs: MINUTE }).reason, 'CYCLE_OVERLAP');
  assert.equal(shouldSkip({ running: false, lastStartedAtMs: 0, nowMs: 5 * MINUTE, intervalMs: MINUTE }).reason, 'CATCH_UP_SINGLE');
});

test('jadwal: msUntilLocalTime WITA (UTC+8)', () => {
  const nowUtc = Date.parse('2026-11-14T00:00:00Z'); // 08:00 WITA
  assert.equal(msUntilLocalTime(nowUtc, '08:30', 480), 30 * MINUTE);
  assert.equal(msUntilLocalTime(nowUtc, '07:00', 480), 23 * 60 * MINUTE);
});

test('outbox: enqueue idempoten dan urutan P0 lebih dulu', () => {
  const ob = [];
  const now = Date.parse('2026-11-14T01:00:00Z');
  assert.ok(enqueue(ob, { idempotencyKey: 'K1', priority: PRIORITY.P2, kind: 'X', text: 'a', nowMs: now }));
  assert.equal(enqueue(ob, { idempotencyKey: 'K1', priority: PRIORITY.P2, kind: 'X', text: 'a', nowMs: now }), null);
  assert.ok(enqueue(ob, { idempotencyKey: 'K2', priority: PRIORITY.P0, kind: 'Y', text: 'b', nowMs: now + 1 }));
  const due = dueItems(ob, now + 10);
  assert.equal(due[0].priority, PRIORITY.P0);
});

test('outbox: gagal sementara menunda, tidak menghapus', () => {
  const ob = [];
  const now = Date.parse('2026-11-14T01:00:00Z');
  const item = enqueue(ob, { idempotencyKey: 'K', priority: PRIORITY.P1, kind: 'X', text: 't', nowMs: now });
  markFailed(item, { nowMs: now, permanent: false, error: 'HTTP_503' });
  assert.equal(item.status, 'PENDING');
  assert.equal(dueItems(ob, now).length, 0);
  markSent(item, { nowMs: now + 1_000_000, telegramMessageId: 7 });
  assert.equal(item.status, 'SENT');
});

test('audit: rantai hash valid, dan terdeteksi bila dimanipulasi', async () => {
  const e1 = buildEvent({ seq: 1, prevHash: GENESIS_HASH, body: { kind: 'A', timestampUtc: '2026-11-14T00:00:00Z' } });
  const e2 = buildEvent({ seq: 2, prevHash: e1.eventHash, body: { kind: 'B', timestampUtc: '2026-11-14T00:01:00Z' } });
  assert.equal((await verifyChain([e1, e2])).ok, true);
  const tampered = { ...e2, kind: 'C' };
  const v = await verifyChain([e1, tampered]);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => p.issue === 'EVENT_HASH_MISMATCH'));
});

test('collector: slug pair Indodax tanpa garis bawah', () => {
  assert.equal(pairSlug('btc_idr'), 'btcidr');
  assert.equal(pairSlug('eth_idr'), 'ethidr');
});

test('config: config.json dan strategy.json v1.5.0 lolos validasi', () => {
  assert.deepEqual(validateConfig(config), []);
  assert.deepEqual(validateStrategy(strategy, config), []);
});

test('config: placeholder ISI_FASE0 dan endpoint kosong ditolak (fail-closed)', () => {
  const bad = structuredClone(config);
  bad.sources.indodax.endpoints = ['ISI_FASE0'];
  assert.ok(validateConfig(bad).some((p) => p.includes('indodax.endpoints')));
  const badStrategy = structuredClone(strategy);
  badStrategy.strategy_trend_pullback.indicator_method = 'SMA';
  assert.ok(validateStrategy(badStrategy, config).length > 0);
});
