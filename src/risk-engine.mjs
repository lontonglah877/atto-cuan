// Manajemen risiko: model ekuitas, biaya, sizing beranggaran adaptif, depth-walk,
// Cost-Aware Gate, batas portofolio, dan circuit breakers. Semua fungsi murni.

import { maxLiquidQuantity, depthWalk } from './data-quality.mjs';

export class RiskUnknownError extends Error {
  constructor(code = 'RISK_UNKNOWN', detail = '') {
    super(detail ? `${code}:${detail}` : code);
    this.code = code;
  }
}

export function isNum(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function requireNum(value, code) {
  if (!isNum(value)) throw new RiskUnknownError('RISK_UNKNOWN', code);
  return value;
}

export function roundDownToStep(value, step) {
  if (!isNum(step) || step <= 0) throw new RiskUnknownError('TICK_LOT_UNKNOWN');
  if (!isNum(value)) throw new RiskUnknownError('RISK_UNKNOWN', 'value');
  // Desimal dari notasi eksponensial (mis. 1e-8) harus dihitung dengan benar.
  const decimals = stepDecimals(step);
  const factor = 10 ** decimals;
  const scaledStep = Math.round(step * factor);
  const scaledValue = Math.floor(value * factor + 1e-9);
  const units = Math.floor(scaledValue / scaledStep);
  return Number((units * scaledStep / factor).toFixed(decimals));
}

function stepDecimals(step) {
  const [mant, exp = '0'] = String(step).toLowerCase().split('e');
  const frac = (mant.split('.')[1] || '').length;
  return Math.max(0, frac - Number(exp));
}

/** Faktor biaya per sisi (fraksi dari harga). */
export function feeFactors(costs) {
  const taker = requireNum(costs.takerFeePct, 'takerFeePct') / 100;
  const taxBuy = requireNum(costs.taxBuyPct, 'taxBuyPct') / 100;
  const taxSell = requireNum(costs.taxSellPct, 'taxSellPct') / 100;
  const slipBuy = requireNum(costs.slippageEntryPct, 'slippageEntryPct') / 100;
  const slipSell = requireNum(costs.slippageExitPct, 'slippageExitPct') / 100;
  if (costs.executionAssumption === 'MAKER') {
    const maker = requireNum(costs.makerFeePct, 'makerFeePct') / 100;
    return { fEntry: maker + taxBuy + slipBuy, fExit: maker + taxSell + slipSell, taker, maker, taxBuy, taxSell, slipBuy, slipSell };
  }
  return { fEntry: taker + taxBuy + slipBuy, fExit: taker + taxSell + slipSell, taker, maker: null, taxBuy, taxSell, slipBuy, slipSell };
}

/** Level SL/TP absolut dari EntryRef IDR + ATR_pct. */
export function planLevels({ entryRefIdr, atrPct, slAtrMult, tpAtrMult, tickSize }) {
  requireNum(entryRefIdr, 'entryRefIdr');
  requireNum(atrPct, 'atrPct');
  const atrIdr = entryRefIdr * (atrPct / 100);
  const stopLossIdr = roundDownToStep(entryRefIdr - slAtrMult * atrIdr, tickSize);
  const takeProfitIdr = roundDownToStep(entryRefIdr + tpAtrMult * atrIdr, tickSize);
  if (!(stopLossIdr > 0)) throw new RiskUnknownError('RISK_UNKNOWN', 'SL<=0');
  if (!(stopLossIdr < entryRefIdr && entryRefIdr < takeProfitIdr)) throw new RiskUnknownError('RISK_UNKNOWN', 'LEVEL_ORDER');
  return { atrIdr, stopLossIdr, takeProfitIdr };
}

export function unitRisk({ entryRefIdr, stopLossIdr, fEntry, fExit }) {
  return (entryRefIdr * (1 + fEntry)) - (stopLossIdr * (1 - fExit));
}

/** Cost-Aware Gate: Net R:R, biaya terhadap jarak SL, break-even win rate. */
export function costGate({ entryRefIdr, stopLossIdr, takeProfitIdr, fEntry, fExit, limits }) {
  const L = entryRefIdr - stopLossIdr;
  const W = takeProfitIdr - entryRefIdr;
  const cLoss = entryRefIdr * fEntry + stopLossIdr * fExit;
  const cWin = entryRefIdr * fEntry + takeProfitIdr * fExit;
  const netLoss = L + cLoss;
  const netWin = W - cWin;
  const netRR = netWin / netLoss;
  const beWinPct = (netLoss / (netWin + netLoss)) * 100;
  const costToStop = cLoss / L;
  const reasons = [];
  if (!(netRR >= limits.minNetRR)) reasons.push('COST_DOMINATED');
  if (!(costToStop <= limits.maxCostToStopRatio)) reasons.push('COST_DOMINATED');
  if (isNum(limits.maxBeWinRatePct) && !(beWinPct <= limits.maxBeWinRatePct)) reasons.push('COST_DOMINATED');
  return { L, W, cLoss, cWin, netLoss, netWin, netRR, beWinPct, costToStop, ok: reasons.length === 0, reasons };
}

export function openRiskOf(positions) {
  return positions
    .filter((p) => ['OPEN', 'PARTIALLY_CLOSED', 'CLOSE_PENDING_CONFIRMATION'].includes(p.status))
    .reduce((s, p) => s + Math.max(p.risk?.currentOpenRiskIdr || 0, 0), 0);
}

export function clusterOpenRisk(positions, bucketSymbols) {
  return positions
    .filter((p) => ['OPEN', 'PARTIALLY_CLOSED', 'CLOSE_PENDING_CONFIRMATION'].includes(p.status))
    .filter((p) => bucketSymbols.includes(p.symbol))
    .reduce((s, p) => s + Math.max(p.risk?.currentOpenRiskIdr || 0, 0), 0);
}

/**
 * Pre-trade sizing dengan anggaran risiko adaptif + Spot cash cap + likuiditas.
 * @returns {{ok:boolean, reasons:string[], capStatus:string, ...}}
 */
export function sizePosition({
  equityReferenceIdr,
  availableCashIdr,
  openRiskNow,
  clusterRiskNow,
  entryRefIdr,
  stopLossIdr,
  fEntry,
  fExit,
  asks,
  lots,
  limits,
}) {
  const E = requireNum(equityReferenceIdr, 'equityReferenceIdr');
  const cash = requireNum(availableCashIdr, 'availableCashIdr');
  const perTradeCap = (limits.maxRiskPerTradePct / 100) * E;
  const riskBudget = Math.min(
    perTradeCap,
    (limits.maxOpenRiskPct / 100) * E - openRiskNow,
    (limits.maxClusterOpenRiskPct / 100) * E - clusterRiskNow,
  );
  const minBudget = (limits.minRiskBudgetFraction ?? 0.5) * perTradeCap;
  if (!(riskBudget > 0) || riskBudget < minBudget) {
    const reasons = [];
    if (riskBudget <= 0 || (limits.maxOpenRiskPct / 100) * E - openRiskNow < minBudget) reasons.push('OPEN_RISK_LIMIT');
    if (riskBudget <= 0 || (limits.maxClusterOpenRiskPct / 100) * E - clusterRiskNow < minBudget) reasons.push('CLUSTER_RISK_LIMIT');
    return { ok: false, reasons: reasons.length ? reasons : ['OPEN_RISK_LIMIT'], riskBudget, perTradeCap };
  }

  const uRisk = unitRisk({ entryRefIdr, stopLossIdr, fEntry, fExit });
  if (!(uRisk > 0)) return { ok: false, reasons: ['RISK_UNKNOWN'], riskBudget, perTradeCap };

  const qRisk = riskBudget / uRisk;
  const maxNotional = Math.min(cash, (limits.maxSpotAllocationPct / 100) * E);
  const qCap = maxNotional / (entryRefIdr * (1 + fEntry));

  // Iterasi slippage terukur (maks 3, monoton tidak naik).
  let slipFloor = fEntry;
  let qLiq = null;
  let measuredSlipPct = null;
  let decision = null;
  for (let i = 0; i < 3; i += 1) {
    const liq = maxLiquidQuantity(asks, entryRefIdr, {
      maxSlippagePct: limits.maxSlippagePct,
      maxBookParticipationPct: limits.maxBookParticipationPct,
    });
    qLiq = liq.qty;
    const probe = Math.min(qRisk, qCap, qLiq);
    const dw = depthWalk(asks, probe, entryRefIdr);
    measuredSlipPct = dw.slippagePct;
    if (dw.insufficient) break;
    const slipFrac = Math.max(dw.slippagePct / 100, (limits.slippageEntryFloor ?? 0));
    if (slipFrac <= slipFloor) break;
    slipFloor = slipFrac;
    decision = { liq, probe };
  }
  const fEntryEff = Math.max(fEntry, slipFloor);

  const qRaw = Math.min(qRisk, qCap, qLiq);
  const qty = roundDownToStep(qRaw, lots.lotStep);
  const notionalIdr = qty * entryRefIdr;
  const capStatus = qRisk <= qCap && qRisk <= qLiq
    ? 'RISK_BASED'
    : (qCap <= qLiq ? (maxNotional === cash ? 'CASH_CAPPED' : 'ALLOCATION_CAPPED') : 'LIQUIDITY_CAPPED');

  const reasons = [];
  if (!(qty > 0) || qty < lots.minQty || notionalIdr < lots.minNotionalIdr) reasons.push('BELOW_MIN_NOTIONAL');
  if (qLiq < lots.minQty) reasons.push('LIQUIDITY_INSUFFICIENT');

  const finalUnitRisk = unitRisk({ entryRefIdr, stopLossIdr, fEntry: fEntryEff, fExit });
  const plannedNetRiskIdr = qty * finalUnitRisk;
  return {
    ok: reasons.length === 0,
    reasons,
    qty,
    notionalIdr,
    capStatus: qLiq < qCap && qLiq < qRisk ? 'LIQUIDITY_CAPPED' : capStatus,
    riskBudget,
    perTradeCap,
    qRisk,
    qCap,
    qLiq,
    fEntryEff,
    fExit,
    unitRiskIdr: finalUnitRisk,
    plannedNetRiskIdr,
    plannedRiskPct: (plannedNetRiskIdr / E) * 100,
    projectedOpenRiskIdr: openRiskNow + plannedNetRiskIdr,
    projectedOpenRiskPct: ((openRiskNow + plannedNetRiskIdr) / E) * 100,
    measuredSlipPct,
  };
}

/** Breaker evaluasi (dipakai sebelum sizing). */
export function evaluateBreakers({ state, equityReferenceIdr, atrPct, config, nowMs }) {
  const reasons = [];
  const info = {};
  const ds = state.portfolio.dailyState;
  const dailyOneR = ds.dailyInitialRiskUnitIdr;
  if (isNum(dailyOneR) && dailyOneR > 0) {
    const realizedR = ds.realizedNetPnlIdr / dailyOneR;
    info.realizedR = realizedR;
    if (realizedR <= -Math.abs(config.risk.dailyLossLimitR)) reasons.push('DAILY_LOSS_LOCKED');
  }
  const cl = state.portfolio.consecutiveLosses || 0;
  info.consecutiveLosses = cl;
  if (cl >= config.risk.consecutiveLossLimit) {
    const until = state.portfolio.lockedUntil?.consecutiveLoss;
    if (!until || nowMs < Date.parse(until)) reasons.push('CONSECUTIVE_LOSS_LOCKED');
  }
  const peak = state.portfolio.peakEquityReferenceIdr;
  if (isNum(peak) && peak > 0) {
    const dd = ((peak - equityReferenceIdr) / peak) * 100;
    info.drawdownPct = dd;
    if (dd >= config.risk.drawdownBreakerPct) reasons.push('DRAWDOWN_LOCKED');
  }
  const p99 = state.symbols?.[info.symbol]?.volPercentileP99;
  info.atrPct = atrPct;
  if (isNum(atrPct)) {
    const vsState = isNum(p99) ? p99 : null;
    info.volP99 = vsState;
    if ((vsState != null && atrPct >= vsState) || atrPct >= config.risk.volatilityAbsoluteMaxPct) {
      reasons.push('VOLATILITY_BREAKER');
    }
  }
  return { reasons, info, blocked: reasons.length > 0 };
}

export function equityInvariantOk(state, toleranceIdr = 1) {
  const equity = state.portfolio.equityReferenceIdr;
  const cash = state.portfolio.availableCashIdr;
  const basis = state.positions
    .filter((p) => ['OPEN', 'PARTIALLY_CLOSED', 'CLOSE_PENDING_CONFIRMATION'].includes(p.status))
    .reduce((s, p) => s + (p.costBasis?.remainingCostBasisIdr || 0), 0);
  return Math.abs(equity - (cash + basis)) <= toleranceIdr;
}
