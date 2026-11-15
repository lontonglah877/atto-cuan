// Pemuatan dan validasi konfigurasi. Fail-closed: parameter kosong = sistem menolak start.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256Canonical } from './canonical-json.mjs';

export class ConfigInvalidError extends Error {
  constructor(problems) {
    super(`CONFIG_INVALID: ${problems.join(' | ')}`);
    this.code = 'CONFIG_INVALID';
    this.problems = problems;
  }
}

const PLACEHOLDER = 'ISI_FASE0';

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

async function loadJson(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (e) {
    throw new ConfigInvalidError([`FILE_UNREADABLE:${path.basename(file)}`]);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new ConfigInvalidError([`JSON_PARSE:${path.basename(file)}:${e.message}`]);
  }
}

function checkEndpoints(list, problems, label) {
  if (!Array.isArray(list) || list.length === 0) {
    problems.push(`${label}.endpoints kosong`);
    return;
  }
  for (const e of list) {
    if (typeof e !== 'string' || e.includes(PLACEHOLDER) || !/^https?:\/\//.test(e)) {
      problems.push(`${label}.endpoints tidak valid: ${String(e).slice(0, 40)}`);
    }
  }
}

export function validateConfig(config, env = {}) {
  const problems = [];
  if (!config || typeof config !== 'object') return ['CONFIG_NOT_OBJECT'];

  if (config.schemaVersion !== '1.5.0') problems.push(`schemaVersion harus "1.5.0" (kini ${config.schemaVersion})`);
  if (typeof config.operationalTimezone !== 'string' || !config.operationalTimezone) problems.push('operationalTimezone kosong');

  checkEndpoints(config.sources?.binance?.endpoints, problems, 'sources.binance');
  checkEndpoints(config.sources?.indodax?.endpoints, problems, 'sources.indodax');
  for (const key of ['maxAgeSec', 'candleGraceSec', 'candleHistory', 'http', 'clock', 'signal', 'monitor', 'lock', 'retention', 'schedule', 'watchdog']) {
    if (!config[key] || typeof config[key] !== 'object') problems.push(`${key} tidak ada`);
  }

  const costs = config.costs || {};
  for (const key of ['takerFeePct', 'taxBuyPct', 'taxSellPct', 'slippageEntryPct', 'slippageExitPct']) {
    if (!isNum(costs[key]) || costs[key] < 0) problems.push(`costs.${key} harus angka >= 0 (kini ${JSON.stringify(costs[key])})`);
  }
  if (costs.executionAssumption === 'MAKER' && !isNum(costs.makerFeePct)) problems.push('costs.makerFeePct wajib bila executionAssumption=MAKER');

  const rules = config.exchangeRules || {};
  for (const [pair, r] of Object.entries(rules)) {
    for (const key of ['tickSize', 'lotStep', 'minQty', 'minNotionalIdr']) {
      if (!isNum(r[key]) || r[key] <= 0) problems.push(`exchangeRules.${pair}.${key} wajib angka > 0`);
    }
  }
  if (Object.keys(rules).length === 0) problems.push('exchangeRules kosong');

  const risk = config.risk || {};
  for (const key of ['maxRiskPerTradePct', 'maxOpenRiskPct', 'maxClusterOpenRiskPct', 'maxSpotAllocationPct', 'minNetRR', 'maxCostToStopRatio']) {
    if (!isNum(risk[key]) || risk[key] <= 0) problems.push(`risk.${key} wajib angka > 0`);
  }
  if (isNum(risk.maxRiskPerTradePct) && isNum(risk.maxOpenRiskPct) && risk.maxRiskPerTradePct > risk.maxOpenRiskPct) {
    problems.push('risk.maxRiskPerTradePct tidak boleh melebihi maxOpenRiskPct');
  }
  for (const key of ['maxSlippagePct', 'maxBookParticipationPct', 'dailyLossLimitR', 'consecutiveLossLimit', 'drawdownBreakerPct', 'volatilityAbsoluteMaxPct', 'equityTtlDays']) {
    if (!isNum(risk[key]) || risk[key] <= 0) problems.push(`risk.${key} wajib angka > 0`);
  }
  if (risk.allowPyramiding === true) problems.push('risk.allowPyramiding=true tidak didukung desain v1.5.0');

  const g = config.guardrail || {};
  if (!isNum(g.thetaInPct) || !isNum(g.thetaOutPct) || !isNum(g.recoverCycles)) problems.push('guardrail.thetaInPct/thetaOutPct/recoverCycles wajib angka');
  if (!g.maxSpreadPct || typeof g.maxSpreadPct !== 'object') problems.push('guardrail.maxSpreadPct kosong');

  const clock = config.clock || {};
  if (!isNum(clock.warnMs) || !isNum(clock.blockMs) || clock.warnMs >= clock.blockMs) problems.push('clock.warnMs harus < clock.blockMs');
  if (!isNum(clock.rttMaxMs) || !isNum(clock.samples) || clock.samples < 2) problems.push('clock.rttMaxMs/samples tidak valid');

  const http = config.http || {};
  if (!isNum(http.timeoutMs) || http.timeoutMs <= 0) problems.push('http.timeoutMs tidak valid');
  if (!isNum(http.maxRequestsPerCycle) || http.maxRequestsPerCycle <= 0) problems.push('http.maxRequestsPerCycle tidak valid');

  if (config.telegram?.enabled === true) {
    // Kredensial tidak disimpan di config.json (akan di-commit): dibaca dari environment/.env.
    if (!env.TELEGRAM_BOT_TOKEN) problems.push('telegram.enabled=true tetapi TELEGRAM_BOT_TOKEN kosong di .env');
    if (!env.TELEGRAM_CHAT_ID) problems.push('telegram.enabled=true tetapi TELEGRAM_CHAT_ID kosong di .env');
  }
  return problems;
}

export function validateStrategy(strategy, config) {
  const problems = [];
  if (!strategy || typeof strategy !== 'object') return ['STRATEGY_NOT_OBJECT'];
  if (strategy.schemaVersion !== '1.5.0') problems.push('strategy.json schemaVersion harus "1.5.0"');
  const p = strategy.strategy_trend_pullback;
  if (!p || typeof p !== 'object') {
    problems.push('strategy_trend_pullback tidak ada');
    return problems;
  }
  for (const key of ['trend_ema_period', 'rsi_period', 'rsi_oversold', 'atr_period', 'sl_atr_mult', 'tp_atr_mult', 'volume_ma_period', 'volume_ma_ratio_min']) {
    if (!isNum(p[key]) || p[key] <= 0) problems.push(`strategy_trend_pullback.${key} wajib angka > 0`);
  }
  if (p.indicator_method !== 'WILDER_RMA') problems.push('strategy_trend_pullback.indicator_method harus WILDER_RMA');
  if (!strategy.symbols || typeof strategy.symbols !== 'object') problems.push('symbols kosong');
  for (const [symbol, def] of Object.entries(strategy.symbols || {})) {
    if (def.enabled !== true) continue;
    if (!def.pair) problems.push(`symbols.${symbol}.pair kosong`);
    if (!config.exchangeRules?.[def.pair]) problems.push(`exchangeRules.${def.pair} tidak ada untuk ${symbol}`);
  }
  return problems;
}

export async function loadConfig({ configFile = 'config.json', strategyFile = 'strategy.json', dir = '.', env = {} } = {}) {
  const config = await loadJson(path.join(dir, configFile));
  const strategy = await loadJson(path.join(dir, strategyFile));
  const problems = [...validateConfig(config, env), ...validateStrategy(strategy, config)];
  if (problems.length) throw new ConfigInvalidError(problems);
  return {
    config,
    strategy,
    configHash: sha256Canonical(config),
    strategyHash: sha256Canonical(strategy),
    configFile,
    strategyFile,
  };
}

/** Pair lokal (IDR) untuk simbol Binance yang aktif. */
export function activeSymbols(strategy) {
  return Object.entries(strategy.symbols || {})
    .filter(([, def]) => def.enabled === true)
    .map(([symbol, def]) => ({ symbol, pair: def.pair, bucket: def.bucket }));
}
