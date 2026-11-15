// Strategi baseline (EMA200 4H + RSI14 1H + ATR14 1H + Volume MA20) dan state machine evaluasi.

import { ema, rsiWilder, atrWilder, volumeMaExcludingTrigger } from './indicators.mjs';
import { sha256Canonical } from './canonical-json.mjs';

/** Candle 4H terakhir dengan closeTime <= T (anti look-ahead multi-timeframe). */
export function selectLatestClosed(candles, T) {
  let found = null;
  for (const c of candles) {
    if (c.closeTime <= T) found = c;
    else break;
  }
  return found;
}

export function strategyHash(strategyJson) {
  return sha256Canonical(strategyJson);
}

export function signalKeyOf({ symbol, timeframe, candleCloseTime, strategyHashHex }) {
  return `${symbol}:${timeframe}:${new Date(candleCloseTime).toISOString()}:${strategyHashHex}`;
}

export function signalIdOf({ symbol, candleCloseTime }) {
  const d = new Date(candleCloseTime);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`;
  return `SIG-${symbol}-${stamp}`;
}

/**
 * Evaluasi teknikal deterministik dari candle tertutup.
 * @param {{candles1h:Array, candles4h:Array, strategy:object, nowMs:number}} input
 */
export function evaluateStrategy({ candles1h, candles4h, strategy, nowMs }) {
  const p = strategy.strategy_trend_pullback;
  const closes1h = candles1h.map((c) => c.close);
  const closes4h = candles4h.map((c) => c.close);
  const ema4h = ema(closes4h, p.trend_ema_period);
  const rsi1h = rsiWilder(closes1h, p.rsi_period);
  const atr1h = atrWilder(candles1h, p.atr_period);

  const triggerIndex = candles1h.length - 1;
  const trigger = candles1h[triggerIndex];
  const prev = candles1h[triggerIndex - 1];
  if (!trigger || !prev) return { status: 'INSUFFICIENT_CANDLES' };

  // Tren: candle 4H tertutup terakhir dengan closeTime <= T (T = closeTime candle pemicu).
  const last4h = selectLatestClosed(candles4h, trigger.closeTime);
  if (!last4h) return { status: 'INSUFFICIENT_CANDLES', reason: 'NO_4H_AT_T' };
  const idx4h = candles4h.indexOf(last4h);
  const emaAtT = ema4h[idx4h];
  if (!Number.isFinite(emaAtT)) return { status: 'INSUFFICIENT_CANDLES', reason: 'EMA_WARMUP' };

  const trendUp = last4h.close > emaAtT;
  const rsiPrev = rsi1h[triggerIndex - 1];
  const rsiNow = rsi1h[triggerIndex];
  if (!Number.isFinite(rsiPrev) || !Number.isFinite(rsiNow)) return { status: 'INSUFFICIENT_CANDLES', reason: 'RSI_WARMUP' };
  const momentumTrigger = rsiPrev < p.rsi_oversold && rsiNow >= p.rsi_oversold;

  const volMa = volumeMaExcludingTrigger(candles1h, 20, triggerIndex);
  const volRatioMin = strategy.strategy_trend_pullback.volume_ma_ratio_min ?? 0.8;
  const volumeOk = Number.isFinite(volMa) && trigger.volume >= volRatioMin * volMa;

  const atr = atr1h[triggerIndex];
  const atrPct = Number.isFinite(atr) ? (atr / trigger.close) * 100 : null;

  const conditions = { trendUp, momentumTrigger, volumeOk };
  const allMet = trendUp && momentumTrigger && volumeOk;

  return {
    status: 'EVALUATED',
    candleCloseTime: trigger.closeTime,
    triggerIndex,
    conditions,
    allMet,
    metrics: {
      close4h: last4h.close,
      closeTime4h: last4h.closeTime,
      ema200_4h: emaAtT,
      trendPct: ((last4h.close - emaAtT) / emaAtT) * 100,
      rsiPrev,
      rsiNow,
      atrUsdt: atr,
      atrPct,
      close1h: trigger.close,
      volume: trigger.volume,
      volumeMa20Prev: volMa,
      volumeRatio: Number.isFinite(volMa) && volMa > 0 ? trigger.volume / volMa : null,
    },
  };
}

export const EVAL_STATUS = Object.freeze({
  NO_TRIGGER: 'NO_TRIGGER',
  DEFERRED: 'DEFERRED',
  ISSUED: 'ISSUED',
  BLOCKED_FINAL: 'BLOCKED_FINAL',
  EXPIRED_UNRESOLVED: 'EXPIRED_UNRESOLVED',
});

export const REASON_CLASS = Object.freeze({
  DATA_STALE: 'SEMENTARA', DATA_INVALID: 'SEMENTARA', DATA_UNKNOWN: 'SEMENTARA',
  CLOCK_DRIFT: 'SEMENTARA', GUARDRAIL_ANOMALY: 'SEMENTARA', SPREAD_WIDE: 'SEMENTARA',
  LIQUIDITY_INSUFFICIENT: 'SEMENTARA', COST_DOMINATED: 'SEMENTARA', BELOW_MIN_NOTIONAL: 'SEMENTARA',
  OPEN_RISK_LIMIT: 'SEMENTARA', CLUSTER_RISK_LIMIT: 'SEMENTARA', SYMBOL_POSITION_OPEN: 'SEMENTARA',
  EQUITY_STALE: 'SEMENTARA', RISK_UNKNOWN: 'SEMENTARA', TICK_LOT_UNKNOWN: 'SEMENTARA',
  DAILY_LOSS_LOCKED: 'FINAL', CONSECUTIVE_LOSS_LOCKED: 'FINAL', DRAWDOWN_LOCKED: 'FINAL',
  VOLATILITY_BREAKER: 'FINAL', COOLDOWN_ACTIVE: 'FINAL', SYSTEM_PAUSED: 'FINAL', NEEDS_REVIEW: 'FINAL',
});

export const NOTIFY_REASON = Object.freeze({
  SYMBOL_POSITION_OPEN: false, COOLDOWN_ACTIVE: false, SYSTEM_PAUSED: false,
});

/** Terapkan hasil gerbang pasca-strategi ke state machine evaluasi. */
export function transitionEvaluation(record, { blockReasons, nowMs, expiresAtMs }) {
  const reasons = [...new Set(blockReasons)];
  const finalReason = reasons.find((r) => REASON_CLASS[r] === 'FINAL');
  if (finalReason) {
    return { status: EVAL_STATUS.BLOCKED_FINAL, primaryReason: finalReason, blockReasons: reasons };
  }
  if (reasons.length) {
    if (nowMs > expiresAtMs) {
      return { status: EVAL_STATUS.EXPIRED_UNRESOLVED, primaryReason: reasons[0], blockReasons: reasons };
    }
    return { status: EVAL_STATUS.DEFERRED, primaryReason: reasons[0], blockReasons: reasons };
  }
  return { status: EVAL_STATUS.ISSUED, primaryReason: null, blockReasons: [] };
}
