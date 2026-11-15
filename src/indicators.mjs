// Indikator murni (tanpa I/O, tanpa waktu) atas candle tertutup yang sudah divalidasi.
// Aritmetika double, tanpa pembulatan perantara.

export function sma(values, period, endExclusive = values.length) {
  if (period <= 0 || endExclusive - period < 0) return null;
  let sum = 0;
  for (let i = endExclusive - period; i < endExclusive; i += 1) sum += values[i];
  return sum / period;
}

/** EMA standar; seed pada index period-1 = SMA(close[0..period-1]). */
export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const alpha = 2 / (period + 1);
  out[period - 1] = sma(values, period, period);
  for (let i = period; i < values.length; i += 1) {
    out[i] = alpha * values[i] + (1 - alpha) * out[i - 1];
  }
  return out;
}

/** RSI Wilder RMA (alpha = 1/period). */
export function rsiWilder(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i += 1) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gainSum += ch; else lossSum -= ch;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  const value = () => (avgLoss === 0 ? (avgGain > 0 ? 100 : 50) : 100 - 100 / (1 + avgGain / avgLoss));
  out[period] = value();
  for (let i = period + 1; i < closes.length; i += 1) {
    const ch = closes[i] - closes[i - 1];
    const gain = ch > 0 ? ch : 0;
    const loss = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = value();
  }
  return out;
}

/** ATR Wilder RMA. */
export function atrWilder(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length < period) return out;
  const tr = new Array(candles.length);
  tr[0] = candles[0].high - candles[0].low;
  for (let i = 1; i < candles.length; i += 1) {
    const prevClose = candles[i - 1].close;
    tr[i] = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - prevClose),
      Math.abs(candles[i].low - prevClose),
    );
  }
  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += tr[i];
  out[period - 1] = seed / period;
  for (let i = period; i < candles.length; i += 1) {
    out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  }
  return out;
}

/** SMA volume dengan candle pemicu DIKELUARKAN dari rata-ratanya sendiri. */
export function volumeMaExcludingTrigger(candles, period = 20, triggerIndex = candles.length - 1) {
  if (triggerIndex - period < 0) return null;
  let sum = 0;
  for (let i = triggerIndex - period; i < triggerIndex; i += 1) sum += candles[i].volume;
  return sum / period;
}
