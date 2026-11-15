// Siklus hidup posisi: buka, ubah level, partial/full close, akuntansi ekuitas. Fungsi murni.

import { ACTIVE_POSITION_STATUSES } from './state-store.mjs';

export const POSITION_STATUS = {
  OPEN: 'OPEN',
  PARTIALLY_CLOSED: 'PARTIALLY_CLOSED',
  CLOSE_PENDING_CONFIRMATION: 'CLOSE_PENDING_CONFIRMATION',
  CLOSED: 'CLOSED',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
};

export const ALERT_STATUS = { NOT_TRIGGERED: 'NOT_TRIGGERED', TRIGGERED: 'TRIGGERED', ACKED: 'ACKED', RE_ARMED: 'RE_ARMED' };

export const FLAG = {
  RISK_LIMIT_BREACHED: 'RISK_LIMIT_BREACHED',
  ENTRY_DEVIATION: 'ENTRY_DEVIATION',
  MANUAL: 'MANUAL',
  FEE_ESTIMATED: 'FEE_ESTIMATED',
  ESTIMATED: 'ESTIMATED',
  RISK_INCREASED: 'RISK_INCREASED',
};

export class CommandError extends Error {
  constructor(code, detail = '') {
    super(`${code}${detail ? `:${detail}` : ''}`);
    this.code = code;
    this.detail = detail;
  }
}

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

/** Risiko terbuka posisi (6.6). */
export function currentOpenRisk({ remainingCostBasisIdr, remainingQuantity, stopLossIdr, fExit }) {
  if (!isNum(remainingCostBasisIdr) || !isNum(remainingQuantity) || !isNum(stopLossIdr) || !isNum(fExit)) {
    return null;
  }
  return Math.max(remainingCostBasisIdr - remainingQuantity * stopLossIdr * (1 - fExit), 0);
}

export function openRiskTotal(positions) {
  return positions
    .filter((p) => ACTIVE_POSITION_STATUSES.includes(p.status))
    .reduce((sum, p) => sum + Math.max(p.risk?.currentOpenRiskIdr || 0, 0), 0);
}

export function nextPositionId(state, symbol, nowMs) {
  const d = new Date(nowMs);
  const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  const base = String(symbol).replace('USDT', '');
  const seq = (state.positions || []).filter((p) => p.positionId.startsWith(`${base}-${stamp}-`)).length + 1;
  return `${base}-${stamp}-${String(seq).padStart(3, '0')}`;
}

function alertSlot(nowIso) {
  return { status: ALERT_STATUS.NOT_TRIGGERED, ack: false, lastNotifiedAtUtc: null, reminderCount: 0, triggeredAtUtc: null, observedAtUtc: null };
}

/**
 * /open — mencatat posisi LONG. Validasi 6.2: simbol terdaftar, qty>0, harga dalam ±5% mid,
 * kas cukup, SL wajib, lotStep, dan risiko aktual dihitung dari fill.
 */
export function openPosition(state, {
  symbol,
  pair,
  qty,
  priceIdr,
  feeIdr = null,
  signalId = null,
  stopLossIdr = null,
  takeProfitIdr = null,
  midRefIdr = null,
  maxDeviationPct = 5,
  fExit = 0,
  limits = {},
  commandId = null,
  nowMs,
}) {
  if (!isNum(qty) || qty <= 0) throw new CommandError('INVALID_QTY', String(qty));
  if (!isNum(priceIdr) || priceIdr <= 0) throw new CommandError('INVALID_PRICE', String(priceIdr));
  if (isNum(midRefIdr) && midRefIdr > 0) {
    const dev = Math.abs((priceIdr - midRefIdr) / midRefIdr) * 100;
    if (dev > maxDeviationPct) throw new CommandError('PRICE_OUT_OF_RANGE', `${dev.toFixed(3)}%`);
  }
  if (!isNum(stopLossIdr) || !(stopLossIdr > 0)) throw new CommandError('STOP_LOSS_REQUIRED');
  if (!(stopLossIdr < priceIdr)) throw new CommandError('STOP_LOSS_ABOVE_ENTRY');
  if (isNum(takeProfitIdr) && !(takeProfitIdr > priceIdr)) throw new CommandError('TP_BELOW_ENTRY');

  const fee = isNum(feeIdr) && feeIdr >= 0 ? feeIdr : priceIdr * qty * (fExit || 0);
  const feeSource = isNum(feeIdr) ? 'ACTUAL' : 'ESTIMATED';
  const costBasis = qty * priceIdr + fee;
  const cash = state.portfolio.availableCashIdr;
  const equity = state.portfolio.equityReferenceIdr;
  if (!isNum(cash) || !isNum(equity)) throw new CommandError('RISK_UNKNOWN', 'EQUITY_NULL');
  if (costBasis > cash + 1) throw new CommandError('INSUFFICIENT_CASH', `${costBasis} > ${cash}`);

  const flags = [];
  if (!isNum(feeIdr)) flags.push(FLAG.FEE_ESTIMATED);
  if (!signalId) flags.push(FLAG.MANUAL);

  const initialRiskIdr = Math.max(costBasis - qty * stopLossIdr * (1 - fExit), 0);
  const riskPctAtEntry = (initialRiskIdr / equity) * 100;
  const breaches = [];
  if (isNum(limits.maxRiskPerTradePct) && riskPctAtEntry > limits.maxRiskPerTradePct * 1.05) breaches.push('RISK_PER_TRADE');
  const projectedOpen = openRiskTotal(state.positions) + initialRiskIdr;
  if (isNum(limits.maxOpenRiskPct) && projectedOpen > (limits.maxOpenRiskPct / 100) * equity) breaches.push('OPEN_RISK');
  if (breaches.length) flags.push(FLAG.RISK_LIMIT_BREACHED);

  const position = {
    positionId: nextPositionId(state, symbol, nowMs),
    signalId,
    origin: signalId ? 'SIGNAL' : 'MANUAL',
    symbol,
    localPair: pair,
    venue: 'indodax',
    side: 'LONG',
    status: POSITION_STATUS.OPEN,
    initialQuantity: qty,
    remainingQuantity: qty,
    averageEntryPriceIdr: priceIdr,
    stopLossIdr,
    takeProfitIdr: isNum(takeProfitIdr) ? takeProfitIdr : null,
    levelHistory: [{ atUtc: new Date(nowMs).toISOString(), stopLossIdr, takeProfitIdr: isNum(takeProfitIdr) ? takeProfitIdr : null }],
    costBasis: {
      entryFeeIdr: fee,
      feeSource,
      initialCostBasisIdr: costBasis,
      remainingCostBasisIdr: costBasis,
    },
    risk: {
      initialRiskIdr,
      currentOpenRiskIdr: initialRiskIdr,
      riskPctAtEntry,
      equityReferenceIdrAtEntry: equity,
      fExitUsed: fExit,
    },
    realizedNetPnlIdr: 0,
    openedAtUtc: new Date(nowMs).toISOString(),
    closedAtUtc: null,
    commandId,
    flags,
    breachReasons: breaches,
    alerts: { sl: alertSlot(), tp: alertSlot(), intrabar: alertSlot(), trend: { status: ALERT_STATUS.NOT_TRIGGERED, reArmCount: 0, lastNotifiedAtUtc: null } },
    history: [{ atUtc: new Date(nowMs).toISOString(), kind: 'OPENED', qty, priceIdr, fee, commandId }],
  };

  state.positions.push(position);
  state.portfolio.availableCashIdr = cash - costBasis;
  state.portfolio.equityUpdatedAtUtc = new Date(nowMs).toISOString();

  if (signalId) {
    const s = (state.signals || []).find((x) => x.signalId === signalId);
    if (s && s.status === 'ACTIVE') {
      s.status = 'ACCEPTED';
      s.closedAtUtc = new Date(nowMs).toISOString();
      if (state.evaluations?.[s.signalKey]) state.evaluations[s.signalKey].status = 'ACCEPTED';
    }
  }
  // Cooldown 24 jam per simbol sejak sinyal ISSUED (bukan sejak dibuka).
  const cooldownHours = state.__cooldownHours ?? null;
  if (isNum(cooldownHours)) {
    state.symbols[symbol] = { ...(state.symbols[symbol] || {}), cooldownUntilUtc: new Date(nowMs + cooldownHours * 3_600_000).toISOString() };
  }

  return {
    position,
    events: [{
      kind: 'POSITION_OPENED',
      symbol,
      positionId: position.positionId,
      signalId,
      commandId,
      quantity: qty,
      averageEntryPriceIdr: priceIdr,
      entryFeeIdr: fee,
      initialRiskIdr,
      flags,
    }],
  };
}

/** Partial atau full close dengan akuntansi 5.1. */
export function closePosition(state, { positionId, qty, priceIdr, feeIdr = null, fExit = 0, commandId = null, nowMs }) {
  const p = (state.positions || []).find((x) => x.positionId === positionId);
  if (!p) throw new CommandError('POSITION_NOT_FOUND', positionId);
  if (!ACTIVE_POSITION_STATUSES.includes(p.status)) throw new CommandError('POSITION_NOT_ACTIVE', p.status);

  const remaining = p.remainingQuantity;
  const q = qty === 'all' ? remaining : qty;
  if (!isNum(q) || q <= 0) throw new CommandError('INVALID_QTY', String(qty));
  if (q > remaining + 1e-12) throw new CommandError('QTY_EXCEEDS_REMAINING', `${q} > ${remaining}`);
  if (!isNum(priceIdr) || priceIdr <= 0) throw new CommandError('INVALID_PRICE', String(priceIdr));

  const fee = isNum(feeIdr) ? feeIdr : priceIdr * q * fExit;
  const feeSource = isNum(feeIdr) ? 'ACTUAL' : 'ESTIMATED';
  const proceeds = q * priceIdr - fee;
  const basisRetired = p.costBasis.remainingCostBasisIdr * (q / remaining);
  const realized = proceeds - basisRetired;

  p.costBasis.remainingCostBasisIdr -= basisRetired;
  p.remainingQuantity -= q;
  p.realizedNetPnlIdr += realized;
  state.portfolio.availableCashIdr += proceeds;
  state.portfolio.equityUpdatedAtUtc = new Date(nowMs).toISOString();

  if (!isNum(feeIdr)) p.flags = [...new Set([...(p.flags || []), FLAG.FEE_ESTIMATED])];

  const fExitUsed = p.risk?.fExitUsed ?? fExit;
  const openRisk = currentOpenRisk({
    remainingCostBasisIdr: p.costBasis.remainingCostBasisIdr,
    remainingQuantity: p.remainingQuantity,
    stopLossIdr: p.stopLossIdr,
    fExit: fExitUsed,
  });

  const partial = p.remainingQuantity > 1e-12;
  p.status = partial ? POSITION_STATUS.PARTIALLY_CLOSED : POSITION_STATUS.CLOSED;
  if (openRisk != null) p.risk.currentOpenRiskIdr = openRisk;

  const rMultiple = partial ? null : (p.risk?.initialRiskIdr > 0 ? p.realizedNetPnlIdr / p.risk.initialRiskIdr : null);
  if (!partial) {
    p.closedAtUtc = new Date(nowMs).toISOString();
    p.finalRM = rMultiple;
    p.closedPriceIdr = priceIdr;
  }
  p.history.push({ atUtc: new Date(nowMs).toISOString(), kind: partial ? 'PARTIAL_CLOSED' : 'CLOSED', qty: q, priceIdr, fee, realizedNetPnlIdr: realized, commandId });

  return {
    position: p,
    ledger: { qty: q, priceIdr, fee, feeSource, proceeds, basisRetired, realizedNetPnlIdr: realized, rMultiple },
    events: [{
      kind: partial ? 'POSITION_PARTIAL_CLOSED' : 'POSITION_CLOSED',
      symbol: p.symbol,
      positionId,
      qty: q,
      priceIdr,
      fee,
      realizedNetPnlIdr: realized,
      rMultiple,
      commandId,
    }],
  };
}

export function updateStopLoss(state, { positionId, stopLossIdr, allowRiskIncrease = false, currentBidIdr = null, commandId = null, nowMs }) {
  const p = (state.positions || []).find((x) => x.positionId === positionId);
  if (!p) throw new CommandError('POSITION_NOT_FOUND', positionId);
  if (!ACTIVE_POSITION_STATUSES.includes(p.status)) throw new CommandError('POSITION_NOT_ACTIVE', p.status);
  if (!isNum(stopLossIdr) || stopLossIdr <= 0) throw new CommandError('INVALID_PRICE', String(stopLossIdr));
  if (isNum(p.takeProfitIdr) && !(stopLossIdr < p.takeProfitIdr)) throw new CommandError('SL_ABOVE_TP');
  if (stopLossIdr < p.stopLossIdr && !allowRiskIncrease) throw new CommandError('SL_DECREASE_FORBIDDEN');

  const warnings = [];
  if (isNum(currentBidIdr) && stopLossIdr >= currentBidIdr) warnings.push('WILL_TRIGGER_IMMEDIATELY');
  const prev = p.stopLossIdr;
  p.stopLossIdr = stopLossIdr;
  p.levelHistory.push({ atUtc: new Date(nowMs).toISOString(), stopLossIdr, takeProfitIdr: p.takeProfitIdr });
  const openRisk = currentOpenRisk({
    remainingCostBasisIdr: p.costBasis.remainingCostBasisIdr,
    remainingQuantity: p.remainingQuantity,
    stopLossIdr,
    fExit: p.risk?.fExitUsed ?? 0,
  });
  if (openRisk != null) p.risk.currentOpenRiskIdr = openRisk;
  if (p.alerts.sl.status === 'TRIGGERED' && stopLossIdr > prev) {
    p.alerts.sl = alertSlot();
  }
  p.history.push({ atUtc: new Date(nowMs).toISOString(), kind: 'SL_UPDATED', from: prev, to: stopLossIdr, commandId });

  const events = [{ kind: 'POSITION_SL_UPDATED', symbol: p.symbol, positionId, from: prev, to: stopLossIdr, commandId }];
  if (stopLossIdr < prev) events.push({ kind: 'RISK_INCREASED', symbol: p.symbol, positionId, from: prev, to: stopLossIdr, commandId });
  return { position: p, warnings, events };
}

export function updateTakeProfit(state, { positionId, takeProfitIdr, commandId = null, nowMs }) {
  const p = (state.positions || []).find((x) => x.positionId === positionId);
  if (!p) throw new CommandError('POSITION_NOT_FOUND', positionId);
  if (!ACTIVE_POSITION_STATUSES.includes(p.status)) throw new CommandError('POSITION_NOT_ACTIVE', p.status);
  if (!isNum(takeProfitIdr) || takeProfitIdr <= 0) throw new CommandError('INVALID_PRICE', String(takeProfitIdr));
  if (!(takeProfitIdr > p.stopLossIdr)) throw new CommandError('TP_BELOW_SL');
  if (!(takeProfitIdr > p.averageEntryPriceIdr)) throw new CommandError('TP_BELOW_ENTRY');

  p.takeProfitIdr = takeProfitIdr;
  p.levelHistory.push({ atUtc: new Date(nowMs).toISOString(), stopLossIdr: p.stopLossIdr, takeProfitIdr });
  p.history.push({ atUtc: new Date(nowMs).toISOString(), kind: 'TP_UPDATED', to: takeProfitIdr, commandId });
  return { position: p, events: [{ kind: 'POSITION_TP_UPDATED', symbol: p.symbol, positionId, to: takeProfitIdr, commandId }] };
}

export function markClosing(state, { positionId, commandId = null, nowMs, ttlMinutes = 60 }) {
  const p = (state.positions || []).find((x) => x.positionId === positionId);
  if (!p) throw new CommandError('POSITION_NOT_FOUND', positionId);
  if (!ACTIVE_POSITION_STATUSES.includes(p.status)) throw new CommandError('POSITION_NOT_ACTIVE', p.status);
  p.previousStatus = p.status;
  p.status = POSITION_STATUS.CLOSE_PENDING_CONFIRMATION;
  p.closePendingUntilUtc = new Date(nowMs + ttlMinutes * 60_000).toISOString();
  p.history.push({ atUtc: new Date(nowMs).toISOString(), kind: 'CLOSE_PENDING', commandId });
  return { position: p, events: [{ kind: 'POSITION_CLOSE_PENDING', symbol: p.symbol, positionId, commandId }] };
}

/** Kembalikan CLOSE_PENDING yang kedaluwarsa ke status semula + peringatan. */
export function expireClosePending(state, nowMs) {
  const events = [];
  for (const p of state.positions || []) {
    if (p.status !== POSITION_STATUS.CLOSE_PENDING_CONFIRMATION) continue;
    if (!p.closePendingUntilUtc || nowMs <= Date.parse(p.closePendingUntilUtc)) continue;
    p.status = p.previousStatus || POSITION_STATUS.OPEN;
    delete p.previousStatus;
    delete p.closePendingUntilUtc;
    events.push({ kind: 'CLOSE_PENDING_EXPIRED', symbol: p.symbol, positionId: p.positionId });
  }
  return events;
}

/** Ekuitas: setoran/penarikan/penyesuaian dan konfirmasi. */
export function setEquity(state, { totalIdr = null, cashIdr = null, confirm = false, fEntry = 0, nowMs }) {
  const p = state.portfolio;
  const nowIso = new Date(nowMs).toISOString();
  const events = [];

  if (confirm) {
    p.equityConfirmedAtUtc = nowIso;
    events.push({ kind: 'EQUITY_CONFIRMED', equityReferenceIdr: p.equityReferenceIdr, availableCashIdr: p.availableCashIdr });
    return { events };
  }
  if (totalIdr == null && cashIdr == null) throw new CommandError('INVALID_EQUITY', 'total/cash kosong');

  // Jika kas eksplisit diberikan, ia menjadi sumber kebenaran kas; total hanya menetapkan ekuitas.
  // Penyesuaian otomatis (delta) hanya dipakai bila total diberikan tanpa kas.
  if (cashIdr != null) {
    if (!isNum(cashIdr) || cashIdr < 0) throw new CommandError('INVALID_EQUITY', String(cashIdr));
    if (totalIdr != null && !isNum(totalIdr)) throw new CommandError('INVALID_EQUITY', String(totalIdr));
    if (totalIdr != null && totalIdr < cashIdr) throw new CommandError('CASH_EXCEEDS_TOTAL');
    p.availableCashIdr = cashIdr;
    if (totalIdr != null) {
      p.equityReferenceIdr = totalIdr;
      events.push({ kind: 'EQUITY_ADJUSTED', equityReferenceIdr: totalIdr, availableCashIdr: cashIdr, mode: 'EXPLICIT_CASH' });
    }
  } else if (totalIdr != null) {
    if (!isNum(totalIdr) || totalIdr < 0) throw new CommandError('INVALID_EQUITY', String(totalIdr));
    if (totalIdr < (p.availableCashIdr || 0)) throw new CommandError('CASH_EXCEEDS_TOTAL');
    const derived = (p.availableCashIdr || 0) + (state.positions || [])
      .filter((x) => ACTIVE_POSITION_STATUSES.includes(x.status))
      .reduce((s, x) => s + (x.costBasis?.remainingCostBasisIdr || 0), 0);
    const delta = totalIdr - derived;
    p.equityReferenceIdr = totalIdr;
    if (delta > 0) p.availableCashIdr = (p.availableCashIdr || 0) + delta;
    else if (delta < 0) p.availableCashIdr = Math.max((p.availableCashIdr || 0) + delta, 0);
    events.push({ kind: 'EQUITY_ADJUSTED', equityReferenceIdr: totalIdr, deltaIdr: delta, derivedIdr: derived, mode: 'DELTA' });
  }
  if (p.equityReferenceIdr != null && (!isNum(p.peakEquityReferenceIdr) || p.equityReferenceIdr > p.peakEquityReferenceIdr)) {
    p.peakEquityReferenceIdr = p.equityReferenceIdr;
  }
  p.equityUpdatedAtUtc = nowIso;
  return { events };
}
