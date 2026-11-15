// Loop 15 menit untuk hosting berjalan terus (Botkeep / VPS).
// Satu siklus gagal tidak menghentikan proses; error dicatat lalu siklus berikutnya tetap jalan.
// Read-only: tidak pernah mengirim order.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnvFile } from './env.mjs';
import { runOnce } from './sentinel.v150.mjs';

const INTERVAL_MS = 15 * 60 * 1000;

/** Tunggu sampai batas 15 menit berikutnya (UTC), supaya jadwal tetap rata. */
export function msUntilNextSlot(nowMs, intervalMs = INTERVAL_MS) {
  return intervalMs - (nowMs % intervalMs);
}

export async function loop({ dir = '.', once = false, log = console.log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() } = {}) {
  const logLine = (k, d = {}) => log(JSON.stringify({ t: new Date(now()).toISOString(), k, ...d }));
  for (;;) {
    try {
      const r = await runOnce({ dir: path.resolve(dir), log: (k, d) => logLine(k, d) });
      logLine('CYCLE_DONE', { errors: r.errors?.length ?? 0, skipped: r.skipped ?? null });
    } catch (e) {
      logLine('CYCLE_FAILED', { error: String(e?.message || e).slice(0, 300) });
    }
    if (once) return;
    const wait = msUntilNextSlot(now());
    logLine('SLEEP', { ms: wait });
    await sleep(wait);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  loadEnvFile(path.resolve('.env'));
  await loop({ once: process.argv.includes('--once') });
}
