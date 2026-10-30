// Uji unit untuk positionAlerts (jalankan: node test-monitor.mjs)
import { positionAlerts } from './monitor.mjs';
import assert from 'node:assert/strict';

const fresh = { sl: 100, tp: 200, alerted: { sl: false, tp: false, trend: false } };
const cases = [
  ['harga di antara SL dan TP, tren naik', fresh, 150, true, []],
  ['harga <= SL', fresh, 100, true, ['SL']],
  ['harga >= TP', fresh, 200, true, ['TP']],
  ['tren 4H berbalik (close < EMA200)', fresh, 150, false, ['TREND']],
  ['data tren tidak ada (null) -> tidak alert tren', fresh, 150, null, []],
  ['SL dan tren sekaligus', fresh, 90, false, ['SL', 'TREND']],
  ['SL sudah pernah dikirim -> tidak diulang', { ...fresh, alerted: { sl: true, tp: false, trend: false } }, 90, true, []],
  ['TREND sudah pernah dikirim -> tidak diulang', { ...fresh, alerted: { sl: false, tp: false, trend: true } }, 150, false, []],
  ['alerted belum ada (posisi lama) -> dianggap belum dikirim', { sl: 100, tp: 200 }, 90, true, ['SL']],
];
let fail = 0;
for (const [name, pos, price, trend, want] of cases) {
  try { assert.deepEqual(positionAlerts(pos, price, trend), want); console.log('OK  ', name); }
  catch (e) { fail++; console.log('GAGAL', name, '\n  dapat:', positionAlerts(pos, price, trend), 'harap:', want); }
}
console.log(fail ? `${fail} gagal` : `semua ${cases.length} lulus`);
process.exit(fail ? 1 : 0);
