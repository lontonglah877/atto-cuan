#!/usr/bin/env node
// Fase 0 — Verifikasi sumber eksternal (read-only, tanpa kredensial).
// Menulis docs/FASE0-VERIFIKASI.md dan nilai siap tempel untuk config.json.
import { writeFile, mkdir } from 'node:fs/promises';

const BINANCE = ['https://data-api.binance.vision', 'https://api.binance.com'];
const INDODAX = 'https://indodax.com/api';

async function getJson(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'atto-cuan/1.5.0 (fase0)' } });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 200); }
    return { ok: res.ok, status: res.status, body, ms: 0 };
  } finally { clearTimeout(t); }
}

const results = [];
function record(area, url, fn) {
  return async () => {
    const t0 = Date.now();
    const r = await getJson(url);
    const ms = Date.now() - t0;
    let detail = r.body;
    if (r.ok && fn) detail = fn(r.body);
    results.push({ area, url, ok: r.ok, status: r.status, ms, detail });
    return { r, detail };
  };
}

const out = {};

// 1) Binance: waktu, klines, bookTicker, failover
const timeRun = await record('binance.time', `${BINANCE[0]}/api/v3/time`, (b) => b)().catch((e) => ({ detail: { error: e.message } }));
out.binanceTime = timeRun.detail;
const k1h = await record('binance.klines.1h', `${BINANCE[0]}/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=1000`, (b) => ({ n: b.length, first: b[0] && { openTime: b[0][0], closeTime: b[0][6] }, last: b[b.length - 1] && { openTime: b[b.length - 1][0], closeTime: b[b.length - 1][6] } })())().catch((e) => ({ detail: { error: e.message } }));
out.binanceKlines = k1h.detail;
const bt = await record('binance.bookTicker', `${BINANCE[0]}/api/v3/ticker/bookTicker?symbol=BTCUSDT`, (b) => b)().catch((e) => ({ detail: { error: e.message } }));
out.bookTicker = bt.detail;
const failover = await record('binance.failover', `${BINANCE[1]}/api/v3/time`, (b) => b)().catch((e) => ({ detail: { error: e.message } }));
out.binancePrimary = failover.detail;

// 2) Indodax: ticker, depth, server_time, pairs, trades
const pairs = await record('indodax.pairs', `${INDODAX}/pairs`, (b) => b.filter((p) => ['btc_idr', 'eth_idr', 'usdt_idr'].includes(p.ticker_id)).map((p) => ({
  ticker_id: p.ticker_id, pricescale: p.pricescale, price_precision: p.price_precision, quantity_increment: p.quantity_increment,
  minIdr: p.trade_min_base_currency, minQty: p.trade_min_traded_currency,
  feeTakerPct: p.trade_fee_percent_taker, feeMakerPct: p.trade_fee_percent_maker,
})))().catch((e) => ({ detail: { error: e.message } }));
out.pairs = pairs.detail;
const srv = await record('indodax.server_time', `${INDODAX}/server_time`, (b) => b)().catch((e) => ({ detail: { error: e.message } }));
out.serverTime = srv.detail;
const tB = await record('indodax.ticker.btc_idr', `${INDODAX}/ticker/btc_idr`, (b) => b.ticker)().catch((e) => ({ detail: { error: e.message } }));
const tE = await record('indodax.ticker.eth_idr', `${INDODAX}/ticker/eth_idr`, (b) => b.ticker)().catch((e) => ({ detail: { error: e.message } }));
const tU = await record('indodax.ticker.usdt_idr', `${INDODAX}/ticker/usdt_idr`, (b) => b.ticker)().catch((e) => ({ detail: { error: e.message } }));
out.tickers = { btc_idr: tB.detail, eth_idr: tE.detail, usdt_idr: tU.detail };
const depth = await record('indodax.depth.btc_idr', `${INDODAX}/depth?pair=btc_idr`, (b) => ({ keys: Object.keys(b), askLevels: b.sell?.length, bidLevels: b.buy?.length, bestAsk: b.sell?.[0] }))().catch((e) => ({ detail: { error: e.message } }));
out.depth = depth.detail;
const trades = await record('indodax.trades.btc_idr', `${INDODAX}/trades?pair=btc_idr&limit=500`, (b) => ({ n: b.length, spanSec: b.length ? Number(b[0].date) - Number(b[b.length - 1].date) : 0, fields: b.length ? Object.keys(b[0]) : [] }))().catch((e) => ({ detail: { error: e.message } }));
out.trades = trades.detail;

// 3) Turunan: tick/tickSize nyata dari sampel harga
const tickFromTicker = (t) => {
  if (!t) return null;
  const bid = Number(t.buy), ask = Number(t.sell);
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const g = gcd(Math.round(bid), Math.round(ask));
  return g;
};
out.derivedTicks = { btc_idr: tickFromTicker(out.tickers.btc_idr), eth_idr: tickFromTicker(out.tickers.eth_idr), usdt_idr: tickFromTicker(out.tickers.usdt_idr) };

const lines = [];
lines.push('# Fase 0 — Verifikasi Sumber Eksternal');
lines.push('');
lines.push(`Dijalankan: ${new Date().toISOString()} (UTC). Mode: read-only, tanpa kredensial.`);
lines.push('');
lines.push('| Area | URL | HTTP | ms | Ringkasan |');
lines.push('|---|---|---|---|---|');
for (const r of results) lines.push(`| ${r.area} | ${r.url} | ${r.status} | ${r.ms} | ${JSON.stringify(r.detail).slice(0, 220)} |`);
lines.push('');
lines.push('## Nilai terverifikasi (tempel ke config.json)');
lines.push('```json');
lines.push(JSON.stringify(out, null, 2));
lines.push('```');
await mkdir('docs', { recursive: true });
await writeFile('docs/FASE0-VERIFIKASI.md', lines.join('\n'));
console.log(lines.slice(0, 40).join('\n'));
console.log('\n--- nilai turunan ---\n' + JSON.stringify(out, null, 2));
