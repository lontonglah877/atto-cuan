// Validasi skema, freshness, kontinuitas grid candle, spread, dan guardrail lintas-venue.

export const STATUS = Object.freeze({ FRESH: 'FRESH', STALE: 'STALE', INVALID: 'INVALID', UNKNOWN: 'UNKNOWN' });

export function isFinitePositive(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/** Candle tertutup = closeTime < trustedNow. Candle berjalan dibuang eksplisit. */
export function closedCandles(candles, nowMs) {
  return candles.filter((c) => Number.isFinite(c.closeTime) && c.closeTime < nowMs);
}

/** closeTime candle terbaru yang seharusnya sudah ada pada grid timeframe. */
export function expectedCloseTime(nowMs, timeframeMs) {
  return Math.floor(nowMs / timeframeMs) * timeframeMs - 1;
}

export function validateCandleShape(c) {
  const nums = [c.open, c.high, c.low, c.close];
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)) return 'CANDLE_NON_FINITE';
  if (typeof c.volume !== 'number' || !Number.isFinite(c.volume) || c.volume < 0) return 'CANDLE_VOLUME_INVALID';
  if (c.high < Math.max(c.open, c.close, c.low)) return 'CANDLE_HIGH_INVALID';
  if (c.low > Math.min(c.open, c.close, c.high)) return 'CANDLE_LOW_INVALID';
  if (!(c.closeTime > c.openTime)) return 'CANDLE_TIME_INVALID';
  return null;
}

/**
 * Validasi candle analisis.
 * @returns {{status:string, reason:string|null, closed:Array, latestCloseTime:number|null,
 *            expectedCloseTime:number, dropped:number, ageMs:number|null}}
 */
export function validateCandles({ candles, nowMs, timeframeMs, minCandles = 500, graceMs = 900_000 }) {
  const base = {
    status: STATUS.INVALID, reason: null, closed: [], latestCloseTime: null,
    expectedCloseTime: expectedCloseTime(nowMs, timeframeMs), dropped: 0, ageMs: null,
  };
  if (!Array.isArray(candles) || candles.length === 0) return { ...base, status: STATUS.UNKNOWN, reason: 'NO_DATA' };

  const closed = closedCandles(candles, nowMs);
  const dropped = candles.length - closed.length;
  if (closed.length < minCandles) return { ...base, closed, dropped, reason: 'WARMUP_INSUFFICIENT' };

  for (const c of closed) {
    const bad = validateCandleShape(c);
    if (bad) return { ...base, closed, dropped, reason: bad };
  }
  // Kontinuitas grid: tanpa celah, duplikat, atau waktu mundur.
  for (let i = 1; i < closed.length; i += 1) {
    const d = closed[i].openTime - closed[i - 1].openTime;
    if (d !== timeframeMs) return { ...base, closed, dropped, reason: d <= 0 ? 'CANDLE_ORDER_INVALID' : 'CANDLE_GAP' };
  }

  const latestCloseTime = closed[closed.length - 1].closeTime;
  const ageMs = nowMs - (latestCloseTime + 1);
  const expected = base.expectedCloseTime;
  if (latestCloseTime < expected && nowMs - expected > graceMs) {
    return { ...base, status: STATUS.STALE, closed, dropped, latestCloseTime, ageMs, reason: 'CANDLE_MISSING_AFTER_GRACE' };
  }
  return { ...base, status: STATUS.FRESH, closed, dropped, latestCloseTime, ageMs };
}

export function validateTicker({ ticker, nowMs, maxAgeSec, futureToleranceMs = 2000 }) {
  const rawAgeMs = nowMs - ticker.marketTimeMs;
  // Indodax memberi timestamp bulat detik: ticker "segar" bisa tampak beberapa ratus ms di masa depan.
  // Di dalam toleransi dianggap umur 0; di luar toleransi tetap ditolak (fail-closed).
  const withinTolerance = rawAgeMs < 0 && rawAgeMs >= -futureToleranceMs;
  const ageMs = withinTolerance ? 0 : rawAgeMs;
  const base = { ...ticker, ageMs };
  if (!isFinitePositive(ticker.bid) || !isFinitePositive(ticker.ask)) return { ...base, status: STATUS.INVALID, reason: 'TICKER_INVALID' };
  if (ticker.ask < ticker.bid) return { ...base, status: STATUS.INVALID, reason: 'TICKER_CROSSED' };
  if (!Number.isFinite(ageMs) || ageMs < 0) return { ...base, status: STATUS.UNKNOWN, reason: 'TICKER_TIME_INVALID' };
  if (maxAgeSec == null) return { ...base, status: STATUS.UNKNOWN, reason: 'MAX_AGE_NOT_CONFIGURED' };
  if (ageMs > maxAgeSec * 1000) return { ...base, status: STATUS.STALE, reason: 'TICKER_STALE' };
  return { ...base, status: STATUS.FRESH, reason: null };
}

export function midOf(t) {
  return (t.bid + t.ask) / 2;
}

export function spreadPct(t) {
  return ((t.ask - t.bid) / midOf(t)) * 100;
}

/** P_ref_IDR = Mid Binance USDT x Mid Indodax USDT/IDR ; deviasi lokal terhadap referensi. */
export function crossVenue({ binanceMidUsdt, usdtIdrTicker, localTicker, maxSkewMs, skewMs }) {
  const pRef = binanceMidUsdt * midOf(usdtIdrTicker);
  const localMid = midOf(localTicker);
  const devPct = ((localMid - pRef) / pRef) * 100;
  if (maxSkewMs != null && Number.isFinite(skewMs) && skewMs > maxSkewMs) {
    return { devPct, pRef, status: STATUS.UNKNOWN, reason: 'CROSS_SOURCE_SKEW' };
  }
  return { devPct, pRef, status: STATUS.FRESH, reason: null };
}

/**
 * Guardrail deviasi dengan histeresis.
 * prev: {status, consecutiveRecoveryCycles, lastDevPct}
 */
export function updateGuardrail(prev, { devPct, dataStatus, thetaInPct, thetaOutPct, recoverCycles }) {
  const p = prev || { status: 'UNKNOWN', consecutiveRecoveryCycles: 0, lastDevPct: null };
  const abs = Math.abs(devPct);
  const base = { ...p, lastDevPct: devPct };
  if (![STATUS.FRESH].includes(dataStatus) || !Number.isFinite(devPct)) {
    return { ...base, status: 'ANOMALY', consecutiveRecoveryCycles: 0, changed: p.status !== 'ANOMALY' };
  }
  if (abs >= thetaInPct) {
    return { ...base, status: 'ANOMALY', consecutiveRecoveryCycles: 0, changed: p.status !== 'ANOMALY' };
  }
  if (p.status === 'ANOMALY') {
    if (abs >= thetaOutPct) return { ...base, status: 'ANOMALY', consecutiveRecoveryCycles: 0, changed: false };
    const n = p.consecutiveRecoveryCycles + 1;
    if (n >= recoverCycles) return { ...base, status: 'NORMAL', consecutiveRecoveryCycles: 0, changed: true };
    return { ...base, status: 'ANOMALY', consecutiveRecoveryCycles: n, changed: false };
  }
  return { ...base, status: 'NORMAL', consecutiveRecoveryCycles: 0, changed: p.status !== 'NORMAL' };
}

/** Depth-walk sisi ask: VWAP untuk kuantitas Q dan slippage terukur. */
export function depthWalk(asks, qty, ask) {
  let remaining = qty;
  let cost = 0;
  let filled = 0;
  for (const [price, amount] of asks) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, amount);
    cost += take * price;
    filled += take;
    remaining -= take;
  }
  if (remaining > 0) return { filled, vwap: null, slippagePct: null, insufficient: true };
  const vwap = cost / filled;
  return { filled, vwap, slippagePct: ((vwap - ask) / ask) * 100, insufficient: false };
}

/** Kuantitas terbesar yang memenuhi batas slippage DAN partisipasi buku. */
export function maxLiquidQuantity(asks, ask, { maxSlippagePct, maxBookParticipationPct, bandPct = 0.5 }) {
  const band = asks.filter(([p]) => p <= ask * (1 + bandPct / 100));
  const bandVolume = band.reduce((s, [, q]) => s + q, 0);
  const participationCap = (bandVolume * maxBookParticipationPct) / 100;
  let cumQ = 0;
  let cumCost = 0;
  let best = 0;
  for (const [price, amount] of asks) {
    let take = amount;
    if (cumQ + take > participationCap) take = participationCap - cumQ;
    if (take <= 0) break;
    const newCost = cumCost + take * price;
    const newQ = cumQ + take;
    const slip = ((newCost / newQ - ask) / ask) * 100;
    if (slip > maxSlippagePct) break;
    cumCost = newCost;
    cumQ = newQ;
    best = cumQ;
    if (cumQ >= participationCap) break;
  }
  return { qty: best, bandVolume, participationCap, vwapAtBest: best > 0 ? cumCost / cumQ : null };
}
