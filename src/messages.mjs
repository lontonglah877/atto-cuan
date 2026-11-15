// Render pesan keluar (HTML). Nilai dinamis selalu di-escape. Tidak ada kata "beli sekarang".

import { localTimeString, timezoneOffsetMinutes } from './state-store.mjs';

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 1234567.891 -> "1.234.567,89" (deterministik, tanpa Intl). */
export function num(n, decimals = 0) {
  if (!Number.isFinite(n)) return 'N/A';
  const neg = n < 0;
  const fixed = Math.abs(n).toFixed(decimals);
  const [int, frac] = fixed.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${neg ? '-' : ''}${grouped}${frac != null ? `,${frac}` : ''}`;
}

export const idr = (n, decimals = 0) => `Rp ${num(n, decimals)}`;
export const pct = (n, decimals = 3) => `${num(n, decimals)}%`;

export function fmtUtc(ms) {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function fmtLocal(ms, tz = 'Asia/Makassar') {
  const d = new Date(ms + timezoneOffsetMinutes(tz) * 60000);
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} WITA`;
}

export function bothTimes(ms, tz = 'Asia/Makassar') {
  return `${fmtUtc(ms)} / ${fmtLocal(ms, tz)}`;
}

export function symbolLabel(signal) {
  return String(signal.symbol || '').replace('USDT', '');
}

/** 8.1 Sinyal lolos. */
export function renderSignal({ signal, metrics, snapshot, config, tz = 'Asia/Makassar' }) {
  const s = signal.sizing;
  const lines = [
    `<b>SINYAL TERDETEKSI - ${esc(symbolLabel(signal))} (LONG SPOT)</b>`,
    '',
    'Status: LOLOS ATURAN (bukan perintah beli)',
    `ID Sinyal: <code>${esc(signal.signalId)}</code>`,
    `Candle 1H: ${esc(bothTimes(Date.parse(signal.candleCloseTimeUtc), tz))}`,
    `Berlaku sampai: ${esc(fmtLocal(Date.parse(signal.expiresAtUtc), tz))}`,
    '',
    '<b>ANALISIS TEKNIKAL (candle tertutup)</b>',
    `- Tren EMA200 4H: ${metrics.trendUp ? 'BULLISH' : 'BEARISH'} (Close 4H ${num(metrics.close4h, 2)} vs EMA ${num(metrics.ema200_4h, 2)})`,
    `- RSI14 1H (Wilder): ${num(metrics.rsiPrev, 2)} -> ${num(metrics.rsiNow, 2)} (cross &gt;= ${num(metrics.rsiOversold, 1)})`,
    `- Volume 1H: ${num(metrics.volume, 3)} (&gt;= ${num(metrics.volumeRatio, 3)} x MA20 sebelumnya ${num(metrics.volumeMa20Prev, 3)})`,
    `- ATR14 1H: ${num(metrics.atrUsdt, 2)} USDT (${pct(metrics.atrPct, 3)} dari harga)`,
    '',
    '<b>VALIDASI DATA &amp; PASAR</b>',
    `- Binance ${esc(signal.symbol)}: ${esc(snapshot.analysisStatus)} (offset ${num(snapshot.clockOffsetMs, 0)} ms)`,
    `- Indodax ${esc(signal.pair)}: ${esc(snapshot.localStatus)} (spread ${pct(snapshot.spreadPct, 3)})`,
    `- Indodax USDT/IDR: ${esc(snapshot.usdtStatus)} (${num(snapshot.usdtMidIdr, 2)} IDR)`,
    `- Deviasi lintas-venue: ${pct(snapshot.devPct, 3)} - ${esc(snapshot.guardrailStatus)}`,
    `- Slippage terukur (depth-walk): ${pct(s.measuredSlipPct, 3)} untuk ${num(s.qty, 8)} ${esc(symbolLabel(signal))}`,
    '',
    '<b>RENCANA &amp; ESTIMASI RISIKO (acuan Indodax)</b>',
    `- Entry acuan (Ask, umur ${num(signal.entryReferenceAgeSec, 0)} dtk): ${idr(signal.entryReferenceIdr, 0)} (toleransi +${pct(signal.maxEntryDeviationPct, 2).replace('%', '')}%)`,
    `- Stop Loss (${num(metrics.slAtrMult, 1)} ATR): ${idr(signal.stopLossIdr)}`,
    `- Take Profit (${num(metrics.tpAtrMult, 1)} ATR): ${idr(signal.takeProfitIdr)}`,
    `- Ukuran rekomendasi: ${num(s.qty, 8)} ${esc(symbolLabel(signal))} (${idr(s.notionalIdr)}) - ${esc(s.capStatus)}`,
    `- Risiko terencana (net): ${idr(s.plannedNetRiskIdr)} (${pct(s.plannedRiskPct, 3)} ekuitas)`,
    `- Total Open Risk jika diambil: ${idr(s.projectedOpenRiskIdr)} (${pct(s.projectedOpenRiskPct, 3)} / maks ${num(config.risk.maxOpenRiskPct, 1)}%)`,
    `- Net R:R: ${num(s.netRR, 3)} | Break-even win rate (net): ${pct(s.beWinRatePct, 2)}`,
    '',
    'Periksa order book dan biaya aktual di Indodax. Sinyal dapat kedaluwarsa.',
    'Keputusan transaksi sepenuhnya milik Anda. Bot READ-ONLY dan tidak mengirim order.',
    `Ambil posisi: <code>/open ${esc(signal.symbol)} &lt;qty&gt; &lt;harga&gt; signal=${esc(signal.signalId)}</code>   |   Tolak: <code>/reject ${esc(signal.signalId)}</code>`,
    `<i>${esc(signal.signalId)}</i>`,
  ];
  return lines.join('\n');
}

/** 8.2 Sinyal ditahan. */
export function renderBlocked({ symbol, pair, candleCloseTimeMs, status, reason, detail, dataStatus, expiresAtMs, tz = 'Asia/Makassar' }) {
  const deferred = status === 'DEFERRED';
  return [
    `<b>SINYAL DITAHAN - ${esc(String(symbol).replace('USDT', ''))}</b>`,
    '',
    `Trigger teknikal: TERDETEKSI (candle ${esc(bothTimes(candleCloseTimeMs, tz))})`,
    'Keputusan: DIBLOKIR (SIGNAL_BLOCKED)',
    `Alasan utama: <code>${esc(reason)}</code>`,
    `Parameter terdampak: ${esc(detail || '-')}`,
    `Data terakhir: ${esc(bothTimes(candleCloseTimeMs, tz))}`,
    deferred
      ? `Status: DEFERRED - dievaluasi ulang sampai ${esc(fmtLocal(expiresAtMs, tz))}`
      : 'Status: FINAL - tidak dievaluasi ulang',
    `Status data ${esc(pair)}: ${esc(dataStatus || 'N/A')}`,
    'Tindakan: sinyal tidak diterbitkan.',
  ].join('\n');
}

/** 8.3 Alert posisi. */
export function renderAlert({ alert, position, tz = 'Asia/Makassar' }) {
  return [
    `<b>PERINGATAN POSISI - ${esc(String(position.symbol).replace('USDT', ''))} (${esc(position.positionId)})</b>`,
    '',
    `Jenis: ${esc(alert.kindLabel || alert.kind)}`,
    `Sumber: ${esc(alert.source)}  Kepercayaan: ${esc(alert.confidence)}`,
    `Waktu pengamatan: ${esc(fmtLocal(alert.observedAtMs, tz))}`,
    `Harga teramati: ${idr(alert.observedPriceIdr)}`,
    `Batas tercatat: ${idr(alert.targetIdr)}`,
    `Kuantitas terdampak: ${num(position.remainingQuantity, 8)} (sisa)`,
    'Status eksekusi di exchange: TIDAK DIKETAHUI',
    '',
    `Periksa akun Indodax secara manual. Perbarui status: <code>/close ${esc(position.positionId)} &lt;qty&gt; &lt;harga&gt;</code> atau <code>/sl ${esc(position.positionId)}</code> atau <code>/ack ${esc(alert.alertId)}</code>`,
    alert.reminderIndex > 0 ? `(Pengingat ke-${alert.reminderIndex}. Akan diulang sampai Anda mengakui.)` : '(Pengingat: 3x tiap 15 menit, lalu tiap jam sampai Anda mengakui.)',
    `<i>${esc(alert.alertId)}</i>`,
  ].join('\n');
}

/** 8.4 Pesan sistem. */
export function renderSystem({ kind, title, lines, tz = 'Asia/Makassar', ref = null, nowMs }) {
  return [
    `<b>${esc(title || kind)}</b>`,
    '',
    ...lines.map((l) => esc(l)),
    '',
    `<i>${esc(ref || kind)} | ${esc(fmtLocal(nowMs, tz))}</i>`,
  ].join('\n');
}

export function renderHeartbeat({ state, openRiskIdr, equityIdr, auditHead, breakerStatus, tz = 'Asia/Makassar', nowMs }) {
  return [
    '<b>HEARTBEAT ATTO CUAN</b>',
    '',
    `Waktu: ${esc(bothTimes(nowMs, tz))}`,
    `Mode sistem: ${esc(state.systemMode)}`,
    `Ekuitas acuan: ${idr(equityIdr)} | Open Risk: ${idr(openRiskIdr)}`,
    `Breaker harian: ${esc(breakerStatus)}`,
    `Posisi aktif: ${num(state.positions.filter((p) => ['OPEN', 'PARTIALLY_CLOSED', 'CLOSE_PENDING_CONFIRMATION'].includes(p.status)).length, 0)}`,
    `Head audit: <code>${esc(String(auditHead).slice(0, 16))}...</code>`,
    'Sinyal adalah informasi, bukan perintah.',
  ].join('\n');
}

export function renderDigest({ state, stats, auditHead, tz = 'Asia/Makassar', nowMs, openRiskIdr, equityIdr }) {
  return [
    '<b>DAILY DIGEST ATTO CUAN</b>',
    '',
    `Tanggal: ${esc(localTimeString(nowMs, tz, true))}`,
    `Sinyal terbit 24 jam: ${num(stats.issued24h, 0)} | ditahan: ${num(stats.blocked24h, 0)} | kedaluwarsa: ${num(stats.expired24h, 0)}`,
    `Ekuitas acuan: ${idr(equityIdr)} | Open Risk: ${idr(openRiskIdr)}`,
    `Realized R hari ini: ${num(state.portfolio.dailyState.realizedR, 3)} | Breaker: ${esc(state.portfolio.dailyState.breakerStatus)}`,
    `Posisi aktif: ${num(stats.openPositions, 0)} | Korelasi BTC-ETH: satu bucket risiko (informasi)`,
    `Head audit: <code>${esc(String(auditHead).slice(0, 16))}...</code>`,
    'Sinyal adalah informasi, bukan perintah.',
  ].join('\n');
}
