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
