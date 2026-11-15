// Lock kokoh: wx, token acak, PID + processStartTime, takeover via rename atomik.
import { open, readFile, unlink, rename, mkdir, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function processStartTimeOf(pid) {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = s.slice(s.lastIndexOf(')') + 2).split(' ');
    // field 22 (starttime) => index 19 setelah nama proses dan state
    return Number(fields[19]) || null;
  } catch { /* bukan Linux atau proses tidak ada */ }
  return null;
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export class Lock {
  constructor({ dir, name, config, log = () => {}, now }) {
    if (typeof now !== 'function') throw new Error('CLOCK_REQUIRED:lock');
    this.now = now;
    this.file = path.join(dir, `${name}.lock`);
    this.name = name;
    this.config = config;
    this.log = log;
    this.held = false;
    this.token = null;
  }

  async acquire() {
    await mkdir(path.dirname(this.file), { recursive: true });
    const deadline = this.now() + (this.config.acquireTimeoutMs ?? 5000);
    while (this.now() <= deadline) {
      const token = randomUUID();
      const payload = {
        token,
        pid: process.pid,
        processName: this.name,
        processStartTime: processStartTimeOf(process.pid),
        hostname: process.env.HOSTNAME || 'local',
        acquiredAtMs: this.now(),
      };
      try {
        const fh = await open(this.file, 'wx');
        await fh.writeFile(JSON.stringify(payload));
        await fh.sync();
        await fh.close();
        this.held = true;
        this.token = token;
        return true;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        if (await this.#reclaimStale()) continue;
        await sleep(25 + Math.floor(Math.random() * 50));
      }
    }
    return false;
  }

  async #reclaimStale() {
    let raw;
    try { raw = await readFile(this.file, 'utf8'); } catch { 
      // Berkas hilang di antara EEXIST dan read: coba lagi.
      return true;
    }
    let info = null;
    try { info = JSON.parse(raw); } catch { info = null; }
    let ageMs = 0;
    try { ageMs = this.now() - (await stat(this.file)).mtimeMs; } catch { return true; }
    const staleAfter = this.config.staleAfterMs ?? 15000;
    if (ageMs <= staleAfter) return false;
    const pid = info?.pid;
    const startTime = info?.processStartTime;
    const alive = pidAlive(pid);
    const sameProcess = alive && (!startTime || !processStartTimeOf(pid) || processStartTimeOf(pid) === startTime);
    if (sameProcess) {
      if (ageMs > (this.config.hardMaxHoldMs ?? 60000)) this.log('LOCK_HELD_TOO_LONG', { name: this.name, pid, ageMs });
      return false;
    }
    // Takeover atomik: hanya satu proses berhasil rename.
    const stale = `${this.file}.stale.${randomUUID()}`;
    try {
      await rename(this.file, stale);
    } catch (e) {
      if (e.code === 'ENOENT') return true;
      throw e;
    }
    this.log('STALE_LOCK_RECOVERED', { name: this.name, ageMs, pid });
    try { await unlink(stale); } catch { /* diabaikan */ }
    return true;
  }

  async release() {
    if (!this.held) return;
    this.held = false;
    try {
      const info = JSON.parse(await readFile(this.file, 'utf8'));
      if (info.token === this.token) await unlink(this.file);
      else this.log('LOCK_OWNERSHIP_LOST', { name: this.name, owner: info.token, mine: this.token });
    } catch (e) {
      if (e.code !== 'ENOENT') this.log('LOCK_RELEASE_ERROR', { name: this.name, error: e.message });
    }
    this.token = null;
  }
}

export class LockSet {
  constructor({ dir, config, log, now }) {
    this.dir = dir;
    this.config = config;
    this.log = log;
    this.now = now;
  }
  /** Urutan tetap anti-deadlock: instance -> state -> outbox. */
  async acquire(names) {
    const locks = names.map((n) => new Lock({ dir: this.dir, name: n, config: this.config, log: this.log, now: this.now }));
    const acquired = [];
    for (const l of locks) {
      const ok = await l.acquire();
      if (!ok) {
        for (const a of acquired.reverse()) await a.release();
        return { ok: false, failed: l.name };
      }
      acquired.push(l);
    }
    return { ok: true, release: async () => { for (const l of acquired.reverse()) await l.release(); } };
  }
}
