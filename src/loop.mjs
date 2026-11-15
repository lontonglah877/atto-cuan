// Loop 15 menit untuk hosting berjalan terus (Botkeep / VPS).
// Satu siklus gagal tidak menghentikan proses; error dicatat lalu siklus berikutnya tetap jalan.
// Read-only: tidak pernah mengirim order.

import path from 'node:path';
import { copyFile, mkdir, access } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { loadEnvFile } from './env.mjs';
import { runOnce } from './sentinel.v150.mjs';

const INTERVAL_MS = 15 * 60 * 1000;

/**
 * Isi data/ dari seed/ saat pertama kali jalan (hosting baru / redeploy yang menghapus data/).
 * Tidak pernah menimpa data yang sudah ada.
 */
export async function seedDataIfEmpty(dir) {
  const dataDir = path.join(dir, 'data');
  const seedDir = path.join(dir, 'seed');
  const exists = (p) => access(p).then(() => true, () => false);
  if (await exists(path.join(dataDir, 'state.json'))) return false;
  if (!(await exists(path.join(seedDir, 'state.json')))) return false;
  await mkdir(dataDir, { recursive: true });
  const copied = [];
  for (const f of ['state.json', 'events.jsonl', 'outbox.json']) {
    if (await exists(path.join(seedDir, f))) {
      await copyFile(path.join(seedDir, f), path.join(dataDir, f));
      copied.push(f);
    }
  }
  return copied.length ? copied : false;
}

/** Tunggu sampai batas 15 menit berikutnya (UTC), supaya jadwal tetap rata. */
export function msUntilNextSlot(nowMs, intervalMs = INTERVAL_MS) {
  return intervalMs - (nowMs % intervalMs);
}

export async function loop({ dir = '.', once = false, log = console.log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() } = {}) {
  const logLine = (k, d = {}) => log(JSON.stringify({ t: new Date(now()).toISOString(), k, ...d }));
  const root = path.resolve(dir);
  const seeded = await seedDataIfEmpty(root);
  logLine('START', {
    version: 'atto-cuan/1.5.0',
    dir: root,
    seeded: seeded || null,
    intervalMin: INTERVAL_MS / 60000,
    once,
  });
  for (;;) {
    try {
      const r = await runOnce({ dir: root, log: (k, d) => logLine(k, d) });
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
