// Uji unit untuk positionAlerts (jalankan: node test-monitor.mjs)
import { positionAlerts, nextGuardState } from './monitor.mjs';
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

// Histeresis guardrail (§11 v1.3.1)
const G = (prev, dev) => nextGuardState(prev, dev, 2.0, 1.8);
const gCases = [
  ['normal + 2,03 -> anomali', G(true, 2.03), false],
  ['anomali + 1,95 -> tetap anomali', G(false, 1.95), false],
  ['anomali + 1,79 -> normal', G(false, 1.79), true],
  ['normal + 1,95 -> tetap normal', G(true, 1.95), true],
  ['normal + dev -2,5 (absolut) -> anomali', G(true, -2.5), false],
  ['anomali + data gagal (null) -> tetap anomali', G(false, null), false],
  ['normal + data gagal (null) -> tetap normal', G(true, null), true],
];
// Urutan dari §11 (d): harus tepat 2 transisi pesan.
let s = true, transisi = 0;
for (const d of [2.03, 2.06, 1.95, 2.09, 1.9, 1.7]) { const n = G(s, d); if (n !== s) transisi++; s = n; }
gCases.push(['urutan 2,03→2,06→1,95→2,09→1,9→1,7 = 2 transisi', transisi, 2]);
let gfail = 0;
for (const [name, got, want] of gCases) {
  const ok = got === want; if (!ok) gfail++;
  console.log(ok ? 'OK  ' : 'GAGAL', name, ok ? '' : `(dapat ${got}, harap ${want})`);
}
console.log(gfail ? `${gfail} guardrail gagal` : `semua ${gCases.length} tes guardrail lulus`);
process.exit(fail || gfail ? 1 : 0);

