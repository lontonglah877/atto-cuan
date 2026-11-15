// Monitor posisi: SL/TP/tren + eskalasi MONITOR_BLIND. Read-only: baca pasar, tulis state/outbox.

import { ACTIVE_POSITION_STATUSES } from './state-store.mjs';
import { openRiskTotal } from './position-manager.mjs';
import { renderAlert } from './messages.mjs';
import { enqueue, PRIORITY } from './outbox.mjs';
import { validateTicker, validateCandles } from './data-quality.mjs';
import { ema } from './indicators.mjs';

const KIND_LABEL = {
  SL_TOUCHED: 'SL TERSENTUH (perlu tindakan)',
  TP_TOUCHED: 'TP TERSENTUH (perlu tindakan)',
  TREND_WEAKENING: 'TREN MELEMAH (informasi)',
};

function alertIdOf(positionId, kind, index) {
  return `ALR-${positionId}-${kind}-${String(index).padStart(3, '0')}`;
}

/** Satu putaran monitor. Kegagalan data -> blind state, bukan diam. */
export async function runMonitorCycle({ store, collector, config, clock, log = () => {}, nowMs = null }) {
  const t = nowMs ?? clock.trustedNow();
  const state = await store.load();
  if (!state) throw new Error('STATE_MISSING');
  const positions = (state.positions || []).filter((p) => ACTIVE_POSITION_STATUSES.includes(p.status));

  if (!positions.length) {
    await store.transact((s) => {
      s.monitor = { ...(s.monitor || {}), lastCycleAtUtc: new Date(t).toISOString(), blindSinceUtc: null };
      s.heartbeat = { ...(s.heartbeat || {}), sentinelLastCycleAtUtc: new Date(t).toISOString() };
      return { events: [] };
    });
    return { atUtc: new Date(t).toISOString(), positions: 0, alerts: [], openRiskIdr: 0 };
  }

  // 1. Harga acuan per simbol (Indodax).
  const snaps = {};
  let dataOk = true;
  for (const p of positions) {
    try {
      const ticker = await collector.indodaxTicker(p.localPair);
      const v = validateTicker({ ticker, nowMs: t, maxAgeSec: config.maxAgeSec.ticker });
      snaps[p.symbol] = { status: v.status, bid: v.bid, ask: v.ask, last: v.last, timeMs: v.marketTimeMs };
      if (v.status !== 'FRESH') dataOk = false;
    } catch (e) {
      snaps[p.symbol] = { status: 'UNKNOWN', error: e.code || e.message };
      dataOk = false;
    }
  }

  // 2. Timer blind + pemulihan CLOSE_PENDING yang lewat tenggat.
  const stale = [];
  await store.transact((s) => {
    for (const p of s.positions || []) {
      if (p.status !== 'CLOSE_PENDING_CONFIRMATION') continue;
      if (!p.closePendingUntilUtc || t <= Date.parse(p.closePendingUntilUtc)) continue;
      p.status = p.previousStatus || 'OPEN';
      delete p.previousStatus;
      delete p.closePendingUntilUtc;
      stale.push({ kind: 'CLOSE_PENDING_EXPIRED', symbol: p.symbol, positionId: p.positionId });
    }
    s.monitor = { ...(s.monitor || {}), lastCycleAtUtc: new Date(t).toISOString() };
    s.monitor.blindSinceUtc = dataOk ? null : (s.monitor.blindSinceUtc || new Date(t).toISOString());
    s.heartbeat = { ...(s.heartbeat || {}), sentinelLastCycleAtUtc: new Date(t).toISOString() };
    return { events: stale };
  });

  // 3. Gerbang SL/TP berbasis Bid.
  const alerts = [];
  for (const p of positions) {
    const snap = snaps[p.symbol];
    if (!snap || snap.status !== 'FRESH') continue;
    const hits = [];
    if (p.stopLossIdr && snap.bid <= p.stopLossIdr) hits.push({ kind: 'SL_TOUCHED', target: p.stopLossIdr });
    if (p.takeProfitIdr && snap.bid >= p.takeProfitIdr) hits.push({ kind: 'TP_TOUCHED', target: p.takeProfitIdr });

    for (const hit of hits) {
      const slotName = hit.kind === 'SL_TOUCHED' ? 'sl' : 'tp';
      const current = p.alerts?.[slotName];
      if (!current || current.status === 'ACKED') continue;
      const first = current.status === 'NOT_TRIGGERED';
      const index = first ? 0 : (current.reminderCount || 0) + 1;
      const alertId = alertIdOf(p.positionId, hit.kind, index);
      const alert = {
        alertId,
        kind: hit.kind,
        kindLabel: KIND_LABEL[hit.kind],
        source: 'Indodax ticker (bid)',
        confidence: 'TICKER_BASED',
        observedAtMs: t,
        observedPriceIdr: snap.bid,
        targetIdr: hit.target,
        reminderIndex: index,
      };
      const text = renderAlert({ alert, position: p, tz: config.operationalTimezone });

      await store.transact((s, ob) => {
        const pos = (s.positions || []).find((x) => x.positionId === p.positionId);
        if (!pos) return { events: [] };
        const slot = pos.alerts[slotName];
        if (!slot || slot.status === 'ACKED') return { events: [] };
        slot.status = 'TRIGGERED';
        slot.triggeredAtUtc = slot.triggeredAtUtc || new Date(t).toISOString();
        slot.observedAtUtc = new Date(t).toISOString();
        slot.lastObservedPriceIdr = snap.bid;
        slot.reminderCount = index;
        slot.lastNotifiedAtUtc = new Date(t).toISOString();
        enqueue(ob, { idempotencyKey: `ALERT:${alertId}`, priority: PRIORITY.P0, kind: 'POSITION_ALERT', text, nowMs: t });
        return { events: [{ kind: 'POSITION_ALERT', symbol: p.symbol, positionId: p.positionId, alertKind: hit.kind, alertId, observedPriceIdr: snap.bid, targetIdr: hit.target }] };
      });
      alerts.push({ positionId: p.positionId, kind: hit.kind, alertId, observedPriceIdr: snap.bid });
    }
  }

  // 4. Tren melemah (close 4H di bawah EMA200) — informasi, sekali per posisi.
  for (const p of positions) {
    if (p.alerts?.trend?.status === 'TRIGGERED') continue;
    try {
      const k4h = await collector.klines(p.symbol, '4h', 300);
      const c4h = validateCandles({ candles: k4h.candles, nowMs: t, timeframeMs: 14_400_000, minCandles: 220, graceMs: config.candleGraceSec['4h'] * 1000 });
      if (c4h.status !== 'FRESH') continue;
      const series = ema(c4h.closed.map((c) => c.close), 200);
      const emaLast = series[series.length - 1];
      const closeLast = c4h.closed[c4h.closed.length - 1].close;
      if (!Number.isFinite(emaLast) || !(closeLast < emaLast)) continue;
      const alert = {
        alertId: alertIdOf(p.positionId, 'TREND', 0), kind: 'TREND_WEAKENING', kindLabel: KIND_LABEL.TREND_WEAKENING,
        source: 'Binance 4H candle tertutup', confidence: 'CLOSED_CANDLE', observedAtMs: t,
        observedPriceIdr: closeLast, targetIdr: emaLast, reminderIndex: 0,
      };
      const text = renderAlert({ alert, position: p, tz: config.operationalTimezone });
      await store.transact((s, ob) => {
        const pos = (s.positions || []).find((x) => x.positionId === p.positionId);
        if (!pos || pos.alerts.trend.status === 'TRIGGERED') return { events: [] };
        pos.alerts.trend = { ...pos.alerts.trend, status: 'TRIGGERED', lastNotifiedAtUtc: new Date(t).toISOString() };
        enqueue(ob, { idempotencyKey: `ALERT:${alert.alertId}`, priority: PRIORITY.P1, kind: 'POSITION_ALERT', text, nowMs: t });
        return { events: [{ kind: 'POSITION_ALERT', symbol: p.symbol, positionId: p.positionId, alertKind: 'TREND_WEAKENING', observedPriceIdr: closeLast, targetIdr: emaLast }] };
      });
      alerts.push({ positionId: p.positionId, kind: 'TREND_WEAKENING', alertId: alert.alertId });
    } catch (e) {
      log('MONITOR_TREND_SKIP', { error: e.code || e.message });
    }
  }

  // 5. Eskalasi MONITOR_BLIND (satu pesan per jendela 10 menit).
  const after = await store.load();
  const blindSince = after?.monitor?.blindSinceUtc;
  if (blindSince) {
    const blindMin = Math.floor((t - Date.parse(blindSince)) / 60_000);
    if (blindMin >= config.monitor.blindMinutes) {
      const bucket = String(Math.floor(Date.parse(blindSince) / 600_000));
      await store.transact((s, ob) => {
        const text = [
          '<b>SISTEM TIDAK DAPAT MEMANTAU</b>',
          '',
          `Data harga tidak tersedia sejak ${blindSince} (${blindMin} menit).`,
          `Posisi aktif: ${positions.length}. Status SL/TP TIDAK DIKETAHUI.`,
          'Periksa Indodax manual dan pastikan level Anda masih berlaku.',
          'Sinyal adalah informasi, bukan perintah.',
        ].join('\n');
        enqueue(ob, { idempotencyKey: `MONITOR_BLIND:${bucket}`, priority: PRIORITY.P0, kind: 'MONITOR_BLIND', text, nowMs: t });
        return { events: [{ kind: 'MONITOR_BLIND', minutes: blindMin, positions: positions.length }] };
      });
      alerts.push({ kind: 'MONITOR_BLIND', minutes: blindMin });
    }
  }

  return { atUtc: new Date(t).toISOString(), positions: positions.length, dataOk, alerts, openRiskIdr: openRiskTotal(positions) };
}
