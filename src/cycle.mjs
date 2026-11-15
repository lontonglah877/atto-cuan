// Siklus sinyal: FETCH -> COMPUTE -> LOCK -> COMMIT. Tidak ada order; hanya membaca pasar.

import { activeSymbols } from './config.mjs';
import { Clock, estimateOffset, combineOffsets, classifyClock } from './clock.mjs';
import { Collector, HttpBudget } from './collector.mjs';
import { validateCandles, validateTicker, spreadPct, midOf, crossVenue, updateGuardrail } from './data-quality.mjs';
import { evaluateStrategy, signalKeyOf, strategyHash, transitionEvaluation, EVAL_STATUS } from './strategy-engine.mjs';
import { feeFactors, planLevels, sizePosition, costGate, openRiskOf, clusterOpenRisk, evaluateBreakers } from './risk-engine.mjs';
import { expireSignals, buildSignal, SIGNAL_STATUS } from './signal-manager.mjs';
import { enqueue, PRIORITY } from './outbox.mjs';
import { renderSignal, renderBlocked } from './messages.mjs';

const TF_MS = { '1h': 3_600_000, '4h': 14_400_000 };
const REASON_TEXT = {
  DATA_STALE: 'Data pasar basi (melewati batas umur).',
  DATA_INVALID: 'Data pasar tidak valid (bentuk/crossed book).',
  DATA_UNKNOWN: 'Status data tidak diketahui (umur belum terverifikasi).',
  CLOCK_DRIFT: 'Selisih jam melewati ambang blokir.',
  GUARDRAIL_ANOMALY: 'Deviasi lintas-venue melewati ambang guardrail.',
  SPREAD_WIDE: 'Spread Indodax melebar melewati batas.',
  LIQUIDITY_INSUFFICIENT: 'Kedalaman buku tidak cukup untuk ukuran minimum.',
  COST_DOMINATED: 'Biaya memakan sebagian besar jarak stop (Net R:R tidak layak).',
  BELOW_MIN_NOTIONAL: 'Nilai transaksi di bawah minimum exchange.',
  OPEN_RISK_LIMIT: 'Batas total risiko terbuka tercapai.',
  CLUSTER_RISK_LIMIT: 'Batas risiko klaster crypto-beta tercapai.',
  SYMBOL_POSITION_OPEN: 'Sudah ada posisi aktif pada simbol ini.',
  EQUITY_STALE: 'Ekuitas acuan belum dikonfirmasi dalam batas TTL.',
  RISK_UNKNOWN: 'Parameter risiko tidak diketahui (tick/lot/ekuitas).',
  TICK_LOT_UNKNOWN: 'Tick size / lot step belum terverifikasi.',
  COOLDOWN_ACTIVE: 'Cooldown 24 jam pasca sinyal terbit.',
  SYSTEM_PAUSED: 'Sistem dalam mode PAUSED.',
  NEEDS_REVIEW: 'Sistem memerlukan peninjauan manual.',
};

export function makeClock() {
  return new Clock();
}

/** Sinkronisasi jam dua sumber (Binance + Indodax). Fail-closed bila tidak sepakat. */
export async function syncClock({ collector, clock, config }) {
  const [binanceSamples, indodaxSamples] = await Promise.all([
    collector.clockSamples(config.clock.samples),
    collector.indodaxClockSamples(config.clock.samples),
  ]);
  const b = estimateOffset({ samples: binanceSamples, rttMaxMs: config.clock.rttMaxMs });
  const i = estimateOffset({ samples: indodaxSamples, rttMaxMs: config.clock.rttMaxMs });
  const combined = combineOffsets({ a: b.offsetMs, b: i.offsetMs, maxAgreeMs: config.clock.maxSourceDisagreeMs });
  if (combined.status !== 'OK') {
    return { ok: false, reason: combined.reason || 'CLOCK_UNKNOWN', binance: b, indodax: i };
  }
  clock.setOffset(combined.offsetMs, 'OK');
  const klass = classifyClock(combined.offsetMs, { warnMs: config.clock.warnMs, blockMs: config.clock.blockMs });
  return { ok: klass !== 'CLOCK_INVALID', klass, offsetMs: combined.offsetMs, binance: b, indodax: i };
}

/** Ambil data pasar untuk satu simbol; mengembalikan status per sumber (tanpa throw). */
export async function fetchSymbolData({ collector, config, symbol, pair, nowMs }) {
  const result = { ok: false, reasons: [], data: {} };
  const grab = async (fn) => {
    try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: e.code || e.message }; }
  };

  const [k1h, k4h, book, ticker, usdt] = await Promise.all([
    grab(() => collector.klines(symbol, '1h', config.candleHistory.target)),
    grab(() => collector.klines(symbol, '4h', config.candleHistory.minClosed)),
    grab(() => collector.bookTicker(symbol)),
    grab(() => collector.indodaxTicker(pair)),
    grab(() => collector.indodaxTicker('usdt_idr')),
  ]);

  const fail = (label, r) => { if (!r.ok) result.reasons.push(`DATA_UNKNOWN:${label}:${r.error}`); return r.ok; };

  const c1h = k1h.ok ? validateCandles({ candles: k1h.value.candles, nowMs, timeframeMs: TF_MS['1h'], minCandles: config.candleHistory.minClosed, graceMs: config.candleGraceSec['1h'] * 1000 }) : { status: 'UNKNOWN', reason: 'FETCH_FAILED' };
  const c4h = k4h.ok ? validateCandles({ candles: k4h.value.candles, nowMs, timeframeMs: TF_MS['4h'], minCandles: config.candleHistory.minClosed, graceMs: config.candleGraceSec['4h'] * 1000 }) : { status: 'UNKNOWN', reason: 'FETCH_FAILED' };

  if (c1h.status !== 'FRESH') result.reasons.push(`DATA_${c1h.status === 'STALE' ? 'STALE' : c1h.status === 'INVALID' ? 'INVALID' : 'UNKNOWN'}:1h`);
  if (c4h.status !== 'FRESH') result.reasons.push(`DATA_${c4h.status === 'STALE' ? 'STALE' : c4h.status === 'INVALID' ? 'INVALID' : 'UNKNOWN'}:4h`);

  const binanceMid = book.ok ? (book.value.bid + book.value.ask) / 2 : null;
  const local = ticker.ok ? validateTicker({ ticker: ticker.value, nowMs, maxAgeSec: config.maxAgeSec.ticker }) : { status: 'UNKNOWN', reason: 'FETCH_FAILED' };
  const usdtT = usdt.ok ? validateTicker({ ticker: { ...usdt.value, marketTimeMs: usdt.value.marketTimeMs }, nowMs, maxAgeSec: config.maxAgeSec.usdtIdr }) : { status: 'UNKNOWN', reason: 'FETCH_FAILED' };
  if (local.status !== 'FRESH') result.reasons.push(`DATA_${local.status === 'STALE' ? 'STALE' : local.status === 'INVALID' ? 'INVALID' : 'UNKNOWN'}:${pair}`);
  if (usdtT.status !== 'FRESH') result.reasons.push(`DATA_${usdtT.status === 'STALE' ? 'STALE' : usdtT.status === 'INVALID' ? 'INVALID' : 'UNKNOWN'}:usdt_idr`);

  const asks = book.ok && usdt.ok && local.ok
    ? (await grab(() => collector.indodaxDepth(pair, config.maxAgeSec.orderBook)))
    : null;

  if (!fail('klines1h', k1h) || !fail('klines4h', k4h) || !fail('book', book) || !fail('ticker', ticker) || !fail('usdt', usdt)) {
    return { ok: false, reasons: result.reasons, data: { c1h, c4h, local, usdtT, binanceMid } };
  }

  let depth = null;
  if (asks && asks.ok) {
    const d = asks.value;
    depth = validateDepth(d, nowMs, config.maxAgeSec.orderBook);
    if (!depth.ok) result.reasons.push(`DATA_UNKNOWN:depth:${depth.reason}`);
  } else {
    result.reasons.push('LIQUIDITY_INSUFFICIENT:depth_unavailable');
  }

  const cross = binanceMid && local.status === 'FRESH' && usdtT.status === 'FRESH'
    ? crossVenue({ binanceMidUsdt: binanceMid, usdtIdrTicker: usdtT, localTicker: local, maxSkewMs: config.guardrail.maxCrossSourceSkewMs, skewMs: Math.abs((local.marketTimeMs ?? nowMs) - nowMs) })
    : { status: 'UNKNOWN', devPct: null, reason: 'CROSS_UNAVAILABLE' };

  return {
    ok: true,
    reasons: result.reasons,
    data: {
      c1h, c4h, local, usdtT, binanceMid, depth, cross,
      spreadPct: local.status === 'FRESH' ? spreadPct(local) : null,
      usdtMid: usdtT.status === 'FRESH' ? midOf(usdtT) : null,
    },
  };
}

function validateDepth(d, nowMs, maxAgeSec) {
  const asks = (d.sell || d.asks || []).map(([p, q]) => [Number(p), Number(q)]).filter(([p, q]) => p > 0 && q > 0);
  const bids = (d.buy || d.bids || []).map(([p, q]) => [Number(p), Number(q)]).filter(([p, q]) => p > 0 && q > 0);
  if (!asks.length || !bids.length) return { ok: false, reason: 'DEPTH_EMPTY' };
  if (!(asks[0][0] > bids[0][0])) return { ok: false, reason: 'DEPTH_CROSSED' };
  return { ok: true, asks, bids, bestAsk: asks[0][0], bestBid: bids[0][0] };
}

/** Satu siklus sinyal lengkap. */
export async function runSignalCycle({ store, collector, clock, config, strategy, strategyHashHex, configHashHex, log = () => {}, nowMs = null }) {
  const t = nowMs ?? clock.trustedNow();
  const symbols = activeSymbols(strategy);
  const fees = feeFactors(config.costs);
  const opened = [];

  const snapshot = await store.load();
  if (!snapshot) throw new Error('STATE_MISSING');
  const openRiskNow = openRiskOf(snapshot.positions || []);
  const clusterSymbols = symbols.filter((s) => s.bucket === 'crypto-beta').map((s) => s.symbol);
  const clusterRiskNow = clusterOpenRisk(snapshot.positions || [], clusterSymbols);

  for (const { symbol, pair, bucket } of symbols) {
    const fetched = await fetchSymbolData({ collector, config, symbol, pair, nowMs: t });
    const reasons = [...fetched.reasons];
    let evaluation = null;
    let guard = snapshot.symbols?.[symbol]?.guardrail || null;

    if (fetched.data.cross && fetched.data.cross.devPct != null) {
      guard = updateGuardrail(guard, {
        devPct: fetched.data.cross.devPct,
        dataStatus: fetched.data.cross.status,
        thetaInPct: config.guardrail.thetaInPct,
        thetaOutPct: config.guardrail.thetaOutPct,
        recoverCycles: config.guardrail.recoverCycles,
      });
      if (guard.status === 'ANOMALY') reasons.push('GUARDRAIL_ANOMALY');
    }

    const spread = fetched.data.spreadPct;
    if (spread != null && spread > (config.guardrail.maxSpreadPct[pair] ?? 0.5)) reasons.push('SPREAD_WIDE');

    if (fetched.data.c1h?.status === 'FRESH' && fetched.data.c4h?.status === 'FRESH') {
      evaluation = evaluateStrategy({ candles1h: fetched.data.c1h.closed, candles4h: fetched.data.c4h.closed, strategy, nowMs: t });
    }

    const trigger = evaluation && evaluation.status === 'EVALUATED' && evaluation.allMet;
    const sigKey = evaluation && evaluation.status === 'EVALUATED'
      ? signalKeyOf({ symbol, timeframe: '1h', candleCloseTime: evaluation.candleCloseTime, strategyHashHex })
      : null;
    const expiresAtMs = evaluation && evaluation.status === 'EVALUATED'
      ? evaluation.candleCloseTime + config.signal.expiryMinutes * 60_000
      : null;

    // Cooldown & posisi aktif = alasan FINAL.
    const cooldownUntil = snapshot.symbols?.[symbol]?.cooldownUntilUtc;
    if (cooldownUntil && t < Date.parse(cooldownUntil)) reasons.push('COOLDOWN_ACTIVE');
    if ((snapshot.positions || []).some((p) => p.symbol === symbol && ['OPEN', 'PARTIALLY_CLOSED', 'CLOSE_PENDING_CONFIRMATION'].includes(p.status))) {
      reasons.push('SYMBOL_POSITION_OPEN');
    }
    if (snapshot.systemMode !== 'NORMAL') reasons.push('SYSTEM_PAUSED');
    const equityAge = snapshot.portfolio.equityConfirmedAtUtc ? (t - Date.parse(snapshot.portfolio.equityConfirmedAtUtc)) / 86_400_000 : Infinity;
    if (!(equityAge <= config.risk.equityTtlDays)) reasons.push('EQUITY_STALE');

    if (!trigger) {
      // Tidak ada trigger: hanya catat status evaluasi (tanpa pesan, tanpa gerbang).
      await store.transact((s) => {
        s.symbols = s.symbols || {};
        s.symbols[symbol] = { ...(s.symbols[symbol] || {}), guardrail: guard, lastEvaluatedAtUtc: new Date(t).toISOString(), lastStatus: evaluation?.status || 'NO_DATA' };
        const expired = expireSignals(s, t);
        return { events: expired };
      });
      continue;
    }

    const block = [...new Set(reasons)];
    const transition = transitionEvaluation(snapshot.evaluations?.[sigKey] || null, { blockReasons: block, nowMs: t, expiresAtMs });
    if (transition.status === EVAL_STATUS.BLOCKED_FINAL || transition.status === EVAL_STATUS.EXPIRED_UNRESOLVED) {
      await store.transact((s) => {
        s.evaluations = s.evaluations || {};
        s.evaluations[sigKey] = { ...(s.evaluations[sigKey] || {}), signalKey: sigKey, symbol, status: transition.status, primaryReason: transition.primaryReason, blockReasons: transition.blockReasons, updatedAtUtc: new Date(t).toISOString(), closedAtUtc: new Date(t).toISOString() };
        return { events: [{ kind: 'SIGNAL_BLOCKED', symbol, signalKey: sigKey, reason: transition.primaryReason, blockReasons: transition.blockReasons, status: transition.status }] };
      });
      opened.push({ symbol, status: transition.status, reason: transition.primaryReason, message: 'BLOCKED' });
      continue;
    }

    if (block.length) {
      // DEFERRED: simpan alasan, coba lagi pada siklus berikut sampai kedaluwarsa.
      await store.transact((s) => {
        s.evaluations = s.evaluations || {};
        const prev = s.evaluations[sigKey] || {};
        s.evaluations[sigKey] = { ...prev, signalKey: sigKey, symbol, status: EVAL_STATUS.DEFERRED, primaryReason: block[0], blockReasons: block, firstSeenAtUtc: prev.firstSeenAtUtc || new Date(t).toISOString(), updatedAtUtc: new Date(t).toISOString() };
        s.symbols[symbol] = { ...(s.symbols[symbol] || {}), guardrail: guard, lastEvaluatedAtUtc: new Date(t).toISOString(), lastStatus: 'DEFERRED' };
        return { events: [] };
      });
      const shown = renderBlocked({
        symbol, pair, candleCloseTimeMs: evaluation.candleCloseTime, status: 'DEFERRED',
        reason: block[0], detail: REASON_TEXT[block[0]] || '-', dataStatus: fetched.data.local?.status, expiresAtMs,
      });
      await enqueueMessage(store, {
        idempotencyKey: `SIGNAL_BLOCKED:${sigKey}:${block[0]}`,
        kind: 'SIGNAL_BLOCKED', text: shown, priority: PRIORITY.P2, nowMs: t,
      });
      opened.push({ symbol, status: 'DEFERRED', reason: block[0] });
      continue;
    }

    // Lolos gerbang: butuh Ask Indodax FRESH tepat sebelum penerbitan.
    if (!fetched.data.depth || !fetched.data.depth.ok) {
      opened.push({ symbol, status: 'DEFERRED', reason: 'LIQUIDITY_INSUFFICIENT' });
      continue;
    }
    const entryRef = fetched.data.depth.bestAsk;
    const askAgeSec = (t - (fetched.data.local.marketTimeMs ?? t)) / 1000;
    if (askAgeSec > config.signal.entryReferenceMaxAgeSec) {
      opened.push({ symbol, status: 'DEFERRED', reason: 'DATA_STALE' });
      continue;
    }
    const atrPct = evaluation.metrics.atrPct;
    const breaker = evaluateBreakers({ state: snapshot, equityReferenceIdr: snapshot.portfolio.equityReferenceIdr, atrPct, config, nowMs: t });
    if (breaker.blocked) {
      await store.transact((s) => {
        s.evaluations = s.evaluations || {};
        s.evaluations[sigKey] = { signalKey: sigKey, symbol, status: EVAL_STATUS.BLOCKED_FINAL, primaryReason: breaker.reasons[0], blockReasons: breaker.reasons, updatedAtUtc: new Date(t).toISOString(), closedAtUtc: new Date(t).toISOString() };
        return { events: [{ kind: 'SIGNAL_BLOCKED', symbol, signalKey: sigKey, reason: breaker.reasons[0], blockReasons: breaker.reasons }] };
      });
      opened.push({ symbol, status: 'BLOCKED_FINAL', reason: breaker.reasons[0] });
      continue;
    }

    const lots = config.exchangeRules[pair];
    if (!lots) { opened.push({ symbol, status: 'BLOCKED_FINAL', reason: 'TICK_LOT_UNKNOWN' }); continue; }

    let levels;
    try {
      levels = planLevels({ entryRefIdr: entryRef, atrPct, slAtrMult: strategy.strategy_trend_pullback.sl_atr_mult, tpAtrMult: strategy.strategy_trend_pullback.tp_atr_mult, tickSize: lots.tickSize });
    } catch (e) {
      opened.push({ symbol, status: 'BLOCKED_FINAL', reason: 'RISK_UNKNOWN' });
      continue;
    }

    const sizing = sizePosition({
      equityReferenceIdr: snapshot.portfolio.equityReferenceIdr,
      availableCashIdr: snapshot.portfolio.availableCashIdr,
      openRiskNow,
      clusterRiskNow,
      entryRefIdr: entryRef,
      stopLossIdr: levels.stopLossIdr,
      fEntry: fees.fEntry,
      fExit: fees.fExit,
      asks: fetched.data.depth.asks,
      lots,
      limits: { ...config.risk, slippageEntryFloor: fees.slipBuy },
    });
    const gate = costGate({ entryRefIdr: entryRef, stopLossIdr: levels.stopLossIdr, takeProfitIdr: levels.takeProfitIdr, fEntry: sizing.fEntryEff ?? fees.fEntry, fExit: fees.fExit, limits: config.risk });
    const allReasons = [...new Set([...(sizing.reasons || []), ...(gate.reasons || [])])];
    if (!sizing.ok || !gate.ok) {
      const shown = renderBlocked({
        symbol, pair, candleCloseTimeMs: evaluation.candleCloseTime, status: 'FINAL',
        reason: allReasons[0], detail: REASON_TEXT[allReasons[0]] || '-', dataStatus: fetched.data.local?.status, expiresAtMs,
      });
      await store.transact((s, ob) => {
        s.evaluations = s.evaluations || {};
        s.evaluations[sigKey] = { signalKey: sigKey, symbol, status: EVAL_STATUS.BLOCKED_FINAL, primaryReason: allReasons[0], blockReasons: allReasons, updatedAtUtc: new Date(t).toISOString(), closedAtUtc: new Date(t).toISOString() };
        enqueue(ob, { idempotencyKey: `SIGNAL_BLOCKED:${sigKey}:${allReasons[0]}`, priority: PRIORITY.P2, kind: 'SIGNAL_BLOCKED', text: shown, nowMs: t });
        return { events: [{ kind: 'SIGNAL_BLOCKED', symbol, signalKey: sigKey, reason: allReasons[0], blockReasons: allReasons }] };
      });
      opened.push({ symbol, status: 'BLOCKED_FINAL', reason: allReasons[0] });
      continue;
    }

    const signal = buildSignal({
      symbol, pair, signalKey: sigKey,
      candleCloseTimeMs: evaluation.candleCloseTime,
      strategyHashHex, configHashHex,
      entryReferenceIdr: entryRef, entryReferenceAgeSec: askAgeSec,
      stopLossIdr: levels.stopLossIdr, takeProfitIdr: levels.takeProfitIdr,
      atrPct, atrIdr: levels.atrIdr,
      sizing: { ...sizing, beWinPct: gate.beWinPct, netRR: gate.netRR, measuredSlipPct: sizing.measuredSlipPct },
      dataSnapshot: {
        analysisStatus: fetched.data.c1h.status,
        localStatus: fetched.data.local.status,
        usdtStatus: fetched.data.usdtT.status,
        clockOffsetMs: clock.offsetMs,
        spreadPct: fetched.data.spreadPct,
        devPct: fetched.data.cross?.devPct ?? null,
        guardrailStatus: guard?.status ?? 'NORMAL',
        usdtMidIdr: fetched.data.usdtMid,
      },
      maxEntryDeviationPct: config.signal.maxEntryDeviationPct,
      expiryMinutes: config.signal.expiryMinutes,
      strategyVersion: strategy.version,
      nowMs: t,
    });

    const text = renderSignal({
      signal,
      metrics: { ...evaluation.metrics, trendUp: evaluation.metrics.trendPct > 0, slAtrMult: strategy.strategy_trend_pullback.sl_atr_mult, tpAtrMult: strategy.strategy_trend_pullback.tp_atr_mult, rsiOversold: strategy.strategy_trend_pullback.rsi_oversold },
      snapshot: signal.dataSnapshot,
      config,
      tz: config.operationalTimezone,
    });

    await store.transact((s, ob) => {
      s.signals = s.signals || [];
      s.signals.push(signal);
      s.evaluations = s.evaluations || {};
      s.evaluations[sigKey] = { signalKey: sigKey, symbol, status: EVAL_STATUS.ISSUED, primaryReason: null, blockReasons: [], firstSeenAtUtc: new Date(t).toISOString(), updatedAtUtc: new Date(t).toISOString() };
      s.symbols = s.symbols || {};
      s.symbols[symbol] = { ...(s.symbols[symbol] || {}), guardrail: guard, lastSignalAtUtc: new Date(t).toISOString(), lastEvaluatedAtUtc: new Date(t).toISOString() };
      enqueue(ob, { idempotencyKey: `SIGNAL_ISSUED:${signal.signalId}`, priority: PRIORITY.P0, kind: 'SIGNAL_ISSUED', text, nowMs: t });
      const expired = expireSignals(s, t);
      return { events: [{ kind: 'SIGNAL_ISSUED', symbol, signalId: signal.signalId, signalKey: sigKey, entryReferenceIdr: entryRef, stopLossIdr: levels.stopLossIdr, takeProfitIdr: levels.takeProfitIdr, quantity: sizing.qty, netRR: gate.netRR }, ...expired] };
    });
    opened.push({ symbol, status: 'ISSUED', signalId: signal.signalId, qty: sizing.qty, netRR: gate.netRR });
  }

  // Kedaluwarsa sinyal ACTIVE yang lewat waktu (tanpa trigger baru).
  await store.transact((s) => ({ events: expireSignals(s, t) }));
  return { atUtc: new Date(t).toISOString(), symbols: opened, openRiskNow, clusterRiskNow };
}

export async function enqueueMessage(store, { idempotencyKey, kind, text, priority, nowMs }) {
  return store.transact((s, ob) => {
    const item = enqueue(ob, { idempotencyKey, kind, text, priority, nowMs });
    return { events: item ? [{ kind: 'OUTBOX_ENQUEUED', outboxId: item.outboxId, outboxKind: kind, priority }] : [] };
  });
}

export function newBudget(config, clock) {
  return new HttpBudget({ maxPerCycle: config.http.maxRequestsPerCycle, minIntervalMs: config.http.minIntervalMs, now: () => clock.rawNow() });
}

export function newCollector({ config, clock, log, fetchImpl = globalThis.fetch }) {
  return new Collector({ config, clock, budget: newBudget(config, clock), log, fetchImpl });
}
