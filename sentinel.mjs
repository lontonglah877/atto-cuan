#!/usr/bin/env node
// Atto Cuan — pemantau pasar pribadi. READ-ONLY: tidak pernah mengirim order.
// Arsitektur: STRATEGI.md v1.1 (terkunci). Mode 1: siklus 15 menit (GitHub Actions cron
// atau `node sentinel.mjs cycle` lokal). Mode 2: `node sentinel.mjs once` = uji sekali.
// Prinsip: semua angka dari API terverifikasi; guardrail silang; closed-candle only.

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// ---------- util ----------
const nowWIB = () => new Date(Date.now() + 7 * 3600e3);
const wibStamp = () => nowWIB().toISOString().replace('T', ' ').slice(0, 19) + ' WIB';
const log = (...a) => console.log(wibStamp(), ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function jget(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(1500 * (i + 1));
    }
  }
}
const jget1 = async (u) => jget(u, 1);

// ---------- env: secret tidak pernah di kode ----------
function loadEnv() {
  if (process.env.TELEGRAM_BOT_TOKEN) return;
  const envPath = join(__dirname, '.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  }
}

// ---------- state (JSON per hari; SQLite menyusul bila butuh kueri) ----------
const statePath = join(DATA_DIR, 'state.json');
function loadState() {
  if (!existsSync(statePath)) return { lastSignalAt: {}, openRiskPct: 0, trades: [], signals: [], anomalies: [], lastCycle: null };
  try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return { lastSignalAt: {}, openRiskPct: 0, trades: [], signals: [], anomalies: [], lastCycle: null }; }
}
function saveState(s) { writeFileSync(statePath, JSON.stringify(s, null, 1)); }
function appendEvent(kind, obj) {
  const p = join(DATA_DIR, 'events.jsonl');
  appendFileSync(p, JSON.stringify({ t: wibStamp(), kind, ...obj }) + '\n');
}
const strategyHash = () => createHash('sha256').update(readFileSync(join(__dirname, 'strategy.json'))).digest('hex').slice(0, 12);

// ---------- konfigurasi ----------
const cfg = JSON.parse(readFileSync(join(__dirname, 'strategy.json'), 'utf8'));
const TF = cfg.poll.timeframe; // "1h"
const BINANCE_BASES = ['https://api.binance.com', 'https://data-api.binance.vision'];
const SYMBOLS = Object.entries(cfg.symbols).filter(([, v]) => v.enabled).map(([k]) => k);

// ---------- kolektor ----------
async function binanceKlines(symbol, interval, limit) {
  for (const base of BINANCE_BASES) {
    try {
      return await jget(`${base}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    } catch (e) { log(`  klines ${symbol} gagal di ${base}: ${e.message}`); }
  }
  throw new Error(`klines ${symbol}: semua sumber gagal`);
}
async function binanceTicker(symbol) {
  for (const base of BINANCE_BASES) {
    try { return await jget1(`${base}/api/v3/ticker/price?symbol=${symbol}`); }
    catch (e) { log(`  ticker ${symbol} gagal di ${base}: ${e.message}`); }
  }
  throw new Error(`ticker ${symbol}: semua sumber gagal`);
}
async function indodaxTicker(pair) { return jget(`https://indodax.com/api/ticker/${pair}`); }
async function usdIdr() {
  const r = await jget('https://api.frankfurter.app/latest?from=USD&to=IDR');
  return r.rates.IDR;
}

// ---------- indikator (closed candle only) ----------
function ema(vals, p) {
  const k = 2 / (p + 1); let e = vals[0];
  for (let i = 1; i < vals.length; i++) e = vals[i] * k + e * (1 - k);
  return e;
}
function rsi(closes, p = 14) {
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
  let ag = g / p, al = l / p;
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (p - 1) + Math.max(d, 0)) / p;
    al = (al * (p - 1) + Math.max(-d, 0)) / p;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}
function atr(klines, p = 14) {
  const trs = klines.map((k, i) => i === 0 ? k[2] - k[3]
    : Math.max(k[2] - k[3], Math.abs(k[2] - klines[i - 1][4]), Math.abs(k[3] - klines[i - 1][4])));
  return trs.slice(-p).reduce((a, b) => a + b, 0) / p;
}
function emaSeries(closes, p) { // EMA per titik (untuk tren 4H: harga vs EMA200)
  const k = 2 / (p + 1); const out = []; let e = closes[0];
  out.push(e);
  for (let i = 1; i < closes.length; i++) { e = closes[i] * k + e * (1 - k); out.push(e); }
  return out;
}

// ---------- guardrail silang (pelajaran "Rp 145 jt") ----------
async function guardrailBTC(usd) {
  try {
    const idr = await indodaxTicker('btcidr');
    const lastIDR = parseFloat(idr.ticker.last);
    const kurs = await usdIdr();
    const expect = usd.last * kurs;
    if (!Number.isFinite(lastIDR) || !Number.isFinite(expect) || !Number.isFinite(usd.last)) {
      return { ok: false, dev: null, lastIDR, expect: Math.round(expect) || 0, reason: 'data non-finite' };
    }
    const dev = ((lastIDR - expect) / expect) * 100;
    if (Math.abs(dev) > cfg.poll.guardrail_max_deviation_pct) {
      return { ok: false, dev: +dev.toFixed(2), lastIDR, expect: Math.round(expect) };
    }
    return { ok: true, dev: +dev.toFixed(2) };
  } catch (e) { return { ok: true, dev: null, note: `guardrail skip: ${e.message}` }; }
}

// ---------- evaluasi strategi Trend-Pullback (closed candle only) ----------
async function evaluate(symbol) {
  const S = cfg.strategy_trend_pullback;
  // 4H tren: butuh >= 201 closed candle untuk EMA200
  const k4h = await binanceKlines(symbol, '4h', 210);
  const c4 = k4h.slice(0, -1).map(k => parseFloat(k[4]));      // buang candle berjalan
  const ema4 = emaSeries(c4, S.trend_ema_period);
  const trendUp = c4[c4.length - 1] > ema4[ema4.length - 1];

  const k1h = await binanceKlines(symbol, TF, 60);
  const closed = k1h.slice(0, -1);                             // closed candle only (anti-repainting)
  const c1 = closed.map(k => parseFloat(k[4]));
  const r = rsi(c1, S.rsi_period);
  const a = atr(closed, S.atr_period);
  const last = c1[c1.length - 1];
  const rsiPrev = rsi(c1.slice(0, -1), S.rsi_period);
  const price = binanceTicker(symbol).then(t => parseFloat(t.price)).catch(() => last);

  const entry = await price;
  const sl = entry - S.sl_atr_mult * a;
  const tp = entry + S.tp_atr_mult * a;
  const slPct = ((entry - sl) / entry) * 100;
  // break-even dari stop aktual (R = jarak SL): c_total=0.7% => c_R = 0.7/slPct
  const cR = 0.7 / slPct;
  const beWin = ((1 + cR) / (1 + 2 + cR)) * 100; // RR 1:2

  // kondisi entry: tren 4H naik + RSI 1H balik dari jenuh jual
  const trigger = trendUp && rsiPrev < S.rsi_oversold && r >= S.rsi_oversold;
  return { symbol, entry, sl, tp, slPct: +slPct.toFixed(2), beWin: +beWin.toFixed(1), rsi: +r.toFixed(1), rsiPrev: +rsiPrev.toFixed(1), atr: a, trendUp, trigger };
}

// ---------- cooldown & circuit breaker ----------
function allowed(state, symbol) {
  const last = state.lastSignalAt[symbol] || 0;
  const cd = cfg.risk.cooldown_hours * 3600e3;
  if (Date.now() - last < cd) return { ok: false, why: 'cooldown' };
  if (state.openRiskPct >= cfg.risk.max_open_risk_total_pct) return { ok: false, why: 'plafon risiko terbuka' };
  return { ok: true };
}

// ---------- Telegram ----------
async function tg(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description || res.status}`);
  return j.result;
}
const tgSend = (text) => tg(process.env.TELEGRAM_BOT_TOKEN, 'sendMessage', { chat_id: process.env.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true });
const rp = (n) => 'Rp ' + Math.round(n).toLocaleString('id-ID');
const us = (n) => '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });

// ---------- mode: cycle (dipanggil cron tiap 15 menit) ----------
async function cycle() {
  const state = loadState();
  const kurs = await usdIdr();
  const lines = [`<b>Atto Cuan — siklus ${wibStamp()}</b>`, `Kurs USD/IDR: ${Math.round(kurs).toLocaleString('id-ID')}`];
  let anomaly = null;

  for (const sym of SYMBOLS) {
    try {
      const t = await binanceTicker(sym);
      const usd = { last: parseFloat(t.price) };
      lines.push(`\n<b>${sym}</b> ${us(usd.last)} ≈ ${rp(usd.last * kurs)}`);

      if (sym === 'BTCUSDT') {
        anomaly = await guardrailBTC({ last: usd.last });
        if (anomaly.ok) lines.push(`Guardrail Indodax vs Binance×kurs: dev ${anomaly.dev}% ✓`);
        else {
          lines.push(`⚠️ <b>DATA_ANOMALY</b>: Indodax ${rp(anomaly.lastIDR)} vs Binance×kurs ${rp(anomaly.expect)} (dev ${anomaly.dev}% > 2%). Sinyal DITAHAN.`);
          appendEvent('anomaly', anomaly); state.anomalies.push({ t: wibStamp(), ...anomaly }); saveState(state);
          await tgSend(`🚨 <b>DATA_ANOMALY</b>\nIndodax: ${rp(anomaly.lastIDR)}\nBinance×kurs: ${rp(anomaly.expect)}\nDev: ${anomaly.dev}%\nSinyal ditahan sampai data normal.`);
        }
      }
      if (!anomaly || anomaly.ok) {
        const ev = await evaluate(sym);
        const tag = ev.trigger ? '🎯 <b>TRIGGER</b>' : '—';
        lines.push(`${tag} RSI ${ev.rsi} (prev ${ev.rsiPrev}) | tren4H ${ev.trendUp ? '↑' : '↓'} | SL ${ev.slPct}% (BE win ${ev.beWin}%)`);
        if (ev.trigger) {
          const gate = allowed(state, sym);
          if (!gate.ok) { lines.push(`   Tertahan: ${gate.why}.`); appendEvent('signal_blocked', { sym, why: gate.why }); }
          else {
            lines.push(`   <b>SINYAL BELI ${sym}</b>\n   Entry ± ${us(ev.entry)}\n   SL ${us(ev.sl)} (-1,5 ATR)\n   TP ${us(ev.tp)} (+3,0 ATR)\n   Break-even win rate: ${ev.beWin}%\n   ⚠️ Sinyal bukan perintah. Eksekusi & ukuran risiko = keputusanmu (max 1%/trade).`);
            state.signals.push({ t: wibStamp(), sym, entry: ev.entry, sl: ev.sl, tp: ev.tp, hash: strategyHash() });
            state.lastSignalAt[sym] = Date.now(); saveState(state);
            appendEvent('signal', { sym, entry: ev.entry, sl: ev.sl, tp: ev.tp });
            await tgSend(`🎯 <b>SINYAL BELI ${sym}</b>\nEntry ± ${us(ev.entry)} (${rp(ev.entry * kurs)})\nSL ${us(ev.sl)}\nTP ${us(ev.tp)}\nBE win: ${ev.beWin}%\n<i>Sinyal ≠ perintah. Keputusan tetap milikmu.</i>`);
          }
        }
      }
      await sleep(800);
    } catch (e) { lines.push(`❌ ${sym}: ${e.message}`); appendEvent('error', { sym, err: e.message }); }
  }
  state.lastCycle = wibStamp(); saveState(state);
  log(lines.join('\n'));
  await tgSend(lines.join('\n'));
}

// ---------- mode: heartbeat 08:00 WIB ----------
async function heartbeat() {
  const state = loadState();
  const ageMin = state.lastCycle ? Math.round((Date.now() - new Date(state.lastCycle.replace(' WIB', 'Z')).getTime() - 7 * 3600e3) / 60000) : null;
  const stale = ageMin === null ? '🟡 belum ada siklus' : (ageMin > 20 ? `🟡 siklus terakhir ${ageMin} mnt lalu (>20 = cek)` : '🟢');
  const sig24 = state.signals.filter(s => Date.now() - new Date(s.t.replace(' WIB', 'Z')).getTime() - 7 * 3600e3 < 24 * 3600e3).length;
  await tgSend(`💓 <b>Heartbeat</b>\n${stale === '🟢' ? '🟢 Sistem aktif | API normal' : stale}\n24 jam terakhir: ${sig24} sinyal\nSiklus terakhir: ${state.lastCycle || '—'}`);
  log('heartbeat terkirim');
}

// ---------- mode: digest 07:00 WIB ----------
async function digest() {
  const kurs = await usdIdr();
  const lines = [`📊 <b>Digest harian — ${wibStamp()}</b>`, `Kurs: ${Math.round(kurs).toLocaleString('id-ID')}`];
  for (const sym of SYMBOLS) {
    const k = await binanceKlines(sym, '1d', 2);
    const prev = k[0], last = k[1];
    const chg = ((parseFloat(last[4]) - parseFloat(prev[4])) / parseFloat(prev[4])) * 100;
    lines.push(`\n<b>${sym}</b> ${us(parseFloat(last[4]))} (${chg >= 0 ? '+' : ''}${chg.toFixed(2)}% 1D)\n  H: ${us(parseFloat(last[2]))} · L: ${us(parseFloat(last[3]))} · Vol: ${parseFloat(last[5]).toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
    await sleep(600);
  }
  lines.push(`\n<i>Sinyal hanya dari closed candle. Sinyal ≠ perintah.</i>`);
  await tgSend(lines.join('\n')); log('digest terkirim');
}

// ---------- mode: loop (jalan terus: siklus 15 menit + digest 07:00 + heartbeat 08:00 WIB) ----------
async function loop() {
  let lastDigest = '', lastHb = '';
  log('loop mulai — siklus tiap 15 menit');
  while (true) {
    const d = nowWIB();
    const H = d.getUTCHours();
    const day = d.toISOString().slice(0, 10);
    if (H === 7 && lastDigest !== day) {
      try { await digest(); lastDigest = day; } catch (e) { log('digest gagal:', e.message); }
    }
    if (H === 8 && lastHb !== day) {
      try { await heartbeat(); lastHb = day; } catch (e) { log('heartbeat gagal:', e.message); }
    }
    try { await cycle(); } catch (e) { log('siklus gagal:', e.message); }
    const wait = msToNextQuarter();
    log(`siklus berikutnya dalam ${Math.round(wait / 1000)} detik`);
    await sleep(wait);
  }
}

// Tidur sampai batas 15 menit berikutnya (:00 :15 :30 :45 WIB), bukan "15 menit setelah siklus selesai".
// Lama siklus atau timer yang tertunda tidak lagi menggeser jadwal; jadwal dikunci ke jam dinding.
// Offset WIB (+7 jam) kelipatan 15 menit, jadi modulo di nowWIB() sejajar dengan perempat jam WIB.
function msToNextQuarter() {
  const Q = 15 * 60e3;
  const into = nowWIB().getTime() % Q;
  return Q - into + 2000; // +2 detik supaya pasti sudah melewati batas
}

// ---------- CLI ----------
const mode = process.argv[2] || 'once';
loadEnv();
if (!process.env.TELEGRAM_BOT_TOKEN) { console.error('TELEGRAM_BOT_TOKEN tidak ada (.env atau env).'); process.exit(1); }
const fn = { cycle, heartbeat, digest, loop }[mode];
if (!fn) { console.error('mode: cycle | heartbeat | digest | loop'); process.exit(1); }
fn().then(() => process.exit(0)).catch(e => { console.error('FATAL', e); process.exit(1); });
