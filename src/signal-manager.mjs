// Siklus hidup sinyal: pembentukan, kedaluwarsa, dan invalidasi. Semua fungsi murni.

import { signalIdOf } from './strategy-engine.mjs';

export const SIGNAL_STATUS = {
  ACTIVE: 'ACTIVE',
  EXPIRED: 'EXPIRED',
  INVALIDATED: 'INVALIDATED',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
};

export const INVALIDATION = {
  SL_TOUCHED: 'SL_TOUCHED',
  TP_TOUCHED: 'TP_TOUCHED',
  ENTRY_TOLERANCE_EXCEEDED: 'ENTRY_TOLERANCE_EXCEEDED',
};

const ACTIVE = new Set([SIGNAL_STATUS.ACTIVE]);

export function buildSignal({
  symbol,
  pair,
  signalKey,
  candleCloseTimeMs,
  strategyHashHex,
  configHashHex,
  entryReferenceIdr,
  entryReferenceAgeSec,
  stopLossIdr,
  takeProfitIdr,
  atrPct,
  atrIdr,
  sizing,
  dataSnapshot,
  maxEntryDeviationPct,
  expiryMinutes,
  strategyVersion,
  nowMs,
}) {
  return {
    signalId: signalIdOf({ symbol, candleCloseTime: candleCloseTimeMs }),
    signalKey,
    symbol,
    pair,
    timeframe: '1h',
    status: SIGNAL_STATUS.ACTIVE,
    strategyVersion: strategyVersion ?? null,
    strategyHash: strategyHashHex,
    configHash: configHashHex,
    createdAtUtc: new Date(nowMs).toISOString(),
    candleCloseTimeUtc: new Date(candleCloseTimeMs).toISOString(),
    expiresAtUtc: new Date(candleCloseTimeMs + (expiryMinutes ?? 45) * 60_000).toISOString(),
    entryReferenceIdr,
    entryReferenceAgeSec,
    stopLossIdr,
    takeProfitIdr,
    atrPct,
    atrIdr,
    maxEntryDeviationPct,
    sizing: {
      recommendedQuantity: sizing.qty,
      notionalIdr: sizing.notionalIdr,
      capStatus: sizing.capStatus,
      plannedNetRiskIdr: sizing.plannedNetRiskIdr,
      plannedRiskPct: sizing.plannedRiskPct,
      projectedOpenRiskIdr: sizing.projectedOpenRiskIdr,
      projectedOpenRiskPct: sizing.projectedOpenRiskPct,
      netRR: sizing.netRR,
      breakEvenWinRatePct: sizing.beWinPct,
      measuredSlipPct: sizing.measuredSlipPct,
    },
    dataSnapshot,
  };
}

/** Tandai ACTIVE yang melewati expiresAt. Mengembalikan event, tidak memutasi. */
export function expireSignals(state, nowMs) {
  const events = [];
  for (const s of state.signals || []) {
    if (!ACTIVE.has(s.status)) continue;
    if (nowMs <= Date.parse(s.expiresAtUtc)) continue;
    s.status = SIGNAL_STATUS.EXPIRED;
    s.closedAtUtc = new Date(nowMs).toISOString();
    const record = state.evaluations?.[s.signalKey];
    if (record && record.status === 'ISSUED') {
      record.status = 'EXPIRED_UNRESOLVED';
      record.updatedAtUtc = new Date(nowMs).toISOString();
    }
    events.push({ kind: 'SIGNAL_EXPIRED_UNRESOLVED', symbol: s.symbol, signalId: s.signalId, signalKey: s.signalKey });
  }
  return events;
}

/** Invalidasi sinyal ACTIVE karena harga acuan sudah tidak layak (4.5). */
export function invalidateSignal(state, { signalId, reason, observedPriceIdr, nowMs }) {
  const s = (state.signals || []).find((x) => x.signalId === signalId);
  if (!s || s.status !== SIGNAL_STATUS.ACTIVE) return null;
  s.status = SIGNAL_STATUS.INVALIDATED;
  s.invalidationReason = reason;
  s.invalidatedAtUtc = new Date(nowMs).toISOString();
  s.invalidationObservedPriceIdr = observedPriceIdr;
  return { kind: 'SIGNAL_INVALIDATED', symbol: s.symbol, signalId: s.signalId, reason };
}

/** Sinyal ACTIVE untuk simbol tertentu. */
export function activeSignalOf(state, symbol) {
  return (state.signals || []).find((s) => s.symbol === symbol && s.status === SIGNAL_STATUS.ACTIVE) || null;
}

export function setSignalStatus(state, { signalId, status, commandId, nowMs, extra = {} }) {
  const s = (state.signals || []).find((x) => x.signalId === signalId);
  if (!s) return { error: `SIGNAL_NOT_FOUND:${signalId}` };
  if (s.status !== SIGNAL_STATUS.ACTIVE) return { error: `SIGNAL_NOT_ACTIVE:${s.status}` };
  s.status = status;
  s.closedAtUtc = new Date(nowMs).toISOString();
  s.commandId = commandId;
  Object.assign(s, extra);
  const record = state.evaluations?.[s.signalKey];
  if (record) record.status = status;
  return { signal: s };
}

/** Buang sinyal/evaluasi di luar retensi (30 hari). */
export function pruneSignals(state, nowMs, days = 30) {
  const cutoff = nowMs - days * 86_400_000;
  const keep = (s) => s.status === SIGNAL_STATUS.ACTIVE || Date.parse(s.createdAtUtc) >= cutoff;
  state.signals = (state.signals || []).filter(keep);
  for (const [key, rec] of Object.entries(state.evaluations || {})) {
    const stamp = rec.closedAtUtc || rec.firstSeenAtUtc || rec.updatedAtUtc;
    if (stamp && Date.parse(stamp) < cutoff) delete state.evaluations[key];
  }
}
