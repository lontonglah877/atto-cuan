// Entrypoint v1.5.0. Satu putaran: sinkron jam -> sinyal -> monitor -> kirim outbox.
// Read-only: tidak pernah mengirim order. Telegram hanya menerima pesan keluar.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { loadEnvFile } from './env.mjs';
import { StateStore, defaultState } from './state-store.mjs';
import { Clock } from './clock.mjs';
import { LockSet } from './lock.mjs';
import { syncClock, runSignalCycle, newCollector } from './cycle.mjs';
import { runMonitorCycle } from './monitor.mjs';
import { drainOutbox, NullTransport } from './notifier.mjs';
import { TelegramTransport, redact } from './telegram.mjs';
import { renderHeartbeat, renderSystem } from './messages.mjs';
import { maybeSendDaily } from './daily-report.mjs';
import { enqueue, PRIORITY } from './outbox.mjs';
import { ensureDataDirs } from './audit.mjs';

export const CODE_VERSION = 'atto-cuan/1.5.0';

/** Bangun transport dari env. Tanpa token/chat -> dry-run (NullTransport), bukan error. */
export function makeTransport(config, env = process.env, { fetchImpl } = {}) {
  if (config.telegram?.enabled !== true) return new NullTransport();
  return new TelegramTransport({
    token: env.TELEGRAM_BOT_TOKEN,
    chatId: env.TELEGRAM_CHAT_ID,
    parseMode: config.telegram.parseMode,
    timeoutMs: config.http.timeoutMs,
    fetchImpl,
  });
}

export async function runOnce({
  dir = '.',
  dataDir = path.join(dir, 'data'),
  env = process.env,
  transport = null,
  fetchImpl = undefined,
  nowMs = null,
  rawNow = null,
  log = () => {},
} = {}) {
  const { config, strategy, configHash, strategyHash } = await loadConfig({ dir, env });
  await ensureDataDirs(dataDir);

  const clock = new Clock(rawNow ? { rawNow } : nowMs != null ? { rawNow: () => nowMs } : {});
  const store = new StateStore({ dataDir, config, clock, log, codeVersion: CODE_VERSION });
  await store.init();
  await store.recover();

  if (!(await store.load())) {
    await store.save({ state: defaultState({ timezone: config.operationalTimezone, equityReferenceIdr: null, nowMs: clock.trustedNow() }) });
  }

  const collector = newCollector({ config, clock, log, fetchImpl });
  const tx = transport || makeTransport(config, env, { fetchImpl });
  const locks = new LockSet({ dir: path.join(dataDir, 'locks'), config: config.lock, log, now: () => clock.rawNow() });

  const held = await locks.acquire(['instance']);
  if (!held.ok) return { skipped: 'LOCK_BUSY', lock: held.failed };
  const report = { at: null, clock: null, signal: null, monitor: null, daily: null, notifier: null, errors: [] };

  // Setiap tahap berdiri sendiri: satu tahap gagal (mis. jaringan putus) tidak boleh
  // membatalkan laporan harian atau pengiriman outbox yang sudah menunggu.
  const step = async (name, fn) => {
    try { return await fn(); } catch (e) {
      const msg = redact(String(e?.message || e), env.TELEGRAM_BOT_TOKEN);
      report.errors.push(`${name}:${msg}`);
      log('STEP_FAILED', { step: name, error: msg });
      return null;
    }
  };

  try {
    // 1. Jam. Gagal sinkron = tidak ada keputusan baru hari ini.
    const sync = await step('clock', () => syncClock({ collector, clock, config }));
    if (!sync) report.clock = { ok: false, reason: 'CLOCK_CHECK_FAILED' };
    else report.clock = sync.ok ? { ok: true, offsetMs: sync.offsetMs } : { ok: false, reason: sync.reason };
    if (!report.clock.ok) log('CLOCK_UNTRUSTED', report.clock);

    if (report.clock.ok) {
      report.signal = await step('signal', () => runSignalCycle({
        store, collector, clock, config, strategy, strategyHashHex: strategyHash, configHashHex: configHash, log,
      }));
    }

    report.monitor = await step('monitor', () => runMonitorCycle({ store, collector, config, clock, log }));

    // 2. Laporan harian: digest 07:00 & heartbeat 08:00 (waktu lokal), sekali per tanggal.
    report.daily = await step('daily', () => maybeSendDaily({ store, config, clock, log }));

    report.at = new Date(clock.trustedNow()).toISOString();
    report.notifier = await step('notifier', () => drainOutbox({ store, transport: tx, config, clock, log }));
    return report;
  } finally {
    await held.release();
  }
}

// Eksekusi langsung: `node src/sentinel.v150.mjs` (satu siklus, untuk dijadwalkan dari luar).
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  loadEnvFile(path.resolve('.env'));
  const r = await runOnce({ dir: path.resolve('.'), log: (k, d) => console.log(JSON.stringify({ t: new Date().toISOString(), k, ...d })) });
  console.log(JSON.stringify(r, null, 2));
}
