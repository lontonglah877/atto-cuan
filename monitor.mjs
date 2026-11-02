// Pemantauan posisi terbuka (strategy.json v1.2.0, exit_monitor: alert-only).
// Fungsi murni: tidak ada I/O, tidak ada aksi jual. Menentukan alert mana yang belum pernah dikirim.
// Setiap alert hanya sekali per posisi: pos.alerted diisi oleh pemanggil SETELAH Telegram berhasil dikirim.
export function positionAlerts(pos, price, trendUp) {
  const pending = [];
  if (!pos.alerted?.sl && price <= pos.sl) pending.push('SL');
  if (!pos.alerted?.tp && price >= pos.tp) pending.push('TP');
  if (!pos.alerted?.trend && trendUp === false) pending.push('TREND');
  return pending;
}

// Guardrail dengan histeresis (§11 v1.3.1). Fungsi murni.
// prevOk: true = normal, false = anomali. dev: selisih % Indodax vs Binance×kurs, atau null jika data gagal.
// Masuk anomali saat |dev| > enterPct. Keluar ke normal hanya saat |dev| < recoverPct.
// Di antara keduanya status dipertahankan. Data gagal (dev null) tidak mengubah status.
export function nextGuardState(prevOk, dev, enterPct, recoverPct) {
  if (dev === null || dev === undefined || !Number.isFinite(dev)) return prevOk;
  const a = Math.abs(dev);
  if (prevOk) return !(a > enterPct);
  return a < recoverPct;
}

