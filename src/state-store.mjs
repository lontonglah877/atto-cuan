// State store: skema, invariant, transaksi journal atomik lintas-berkas, recovery.

import { readFile, writeFile, rename, mkdir, open, cp } from 'node:fs/promises';
import path from 'node:path';
import { buildEvent, appendEvents, verifyChain, readEvents, ensureDataDirs, journalSizeMb } from './audit.mjs';
import { listJournals, writeJournal, removeJournal, sha256OfValue } from './journal.mjs';
import { equityInvariantOk } from './risk-engine.mjs';
import { GENESIS_HASH } from './canonical-json.mjs';

export const ACTIVE_POSITION_STATUSES = ['OPEN', 'PARTIALLY_CLOSED', 'CLOSE_PENDING_CONFIRMATION'];

export function defaultState({ timezone = 'Asia/Makassar', equityReferenceIdr = null, nowMs = null } = {}) {
  if (!Number.isFinite(nowMs)) throw new Error('CLOCK_REQUIRED:defaultState');
  return {
    schemaVersion: '1.5.0',
    stateVersion: 0,
    lastEventSequenceNo: 0,
    lastEventHash: GENESIS_HASH,
    systemMode: 'NORMAL',
    operationalTimezone: timezone,
    portfolio: {
      equityReferenceIdr,
      availableCashIdr: equityReferenceIdr,
      equityUpdatedAtUtc: equityReferenceIdr != null ? new Date(nowMs).toISOString() : null,
      equityConfirmedAtUtc: equityReferenceIdr != null ? new Date(nowMs).toISOString() : null,
      peakEquityReferenceIdr: equityReferenceIdr,
      consecutiveLosses: 0,
      lockedUntil: { consecutiveLoss: null },
      dailyState: {
        dateLocal: localDate(nowMs, timezone),
        dailyInitialEquityIdr: equityReferenceIdr,
        dailyInitialRiskUnitIdr: equityReferenceIdr != null ? equityReferenceIdr * 0.01 : null,
        realizedNetPnlIdr: 0,
        realizedR: 0,
        breakerStatus: 'NORMAL',
      },
    },
    symbols: {},
    evaluations: {},
    signals: [],
    positions: [],
    telegram: { lastUpdateId: 0 },
    timeStatus: {},
    monitor: { lastCycleAtUtc: null, blindSinceUtc: null },
    heartbeat: { lastSentAtUtc: null, sentinelLastCycleAtUtc: null, notifierLastAtUtc: null },
    digest: { lastSentDateLocal: null },
  };
}

export function localDate(nowMs, timezone = 'Asia/Makassar') {
  const offsetMin = timezoneOffsetMinutes(timezone);
  const d = new Date(nowMs + offsetMin * 60000);
  return d.toISOString().slice(0, 10);
}

export function timezoneOffsetMinutes(timezone) {
  // Asia/Makassar = UTC+8. Peta kecil agar deterministik tanpa Intl pada tes.
  const map = { 'Asia/Makassar': 480, 'Asia/Jakarta': 420, 'Asia/Jayapura': 540, UTC: 0 };
  return map[timezone] ?? 480;
}

export function localTimeString(nowMs, timezone = 'Asia/Makassar', withDate = false) {
  const d = new Date(nowMs + timezoneOffsetMinutes(timezone) * 60000);
  const iso = d.toISOString();
  const t = iso.slice(11, 19);
  return withDate ? `${iso.slice(0, 10)} ${t}` : t;
}

export function validateState(state) {
  const problems = [];
  if (!state || typeof state !== 'object') return { ok: false, problems: ['STATE_NOT_OBJECT'] };
  if (typeof state.stateVersion !== 'number') problems.push('STATE_VERSION_MISSING');
  for (const field of ['equityReferenceIdr', 'availableCashIdr']) {
    const v = state.portfolio?.[field];
    if (v != null && (!Number.isFinite(v) || v < 0)) problems.push(`EQUITY_FIELD_INVALID:${field}`);
  }
  for (const p of state.positions || []) {
    if (!(p.remainingQuantity >= 0)) problems.push(`POSITION_QTY_INVALID:${p.positionId}`);
    if (Number.isFinite(p.stopLossIdr) && Number.isFinite(p.takeProfitIdr) && !(p.stopLossIdr < p.takeProfitIdr)) {
      problems.push(`POSITION_SL_TP_INVALID:${p.positionId}`);
    }
  }
  if (state.portfolio?.equityReferenceIdr != null && !equityInvariantOk(state)) problems.push('EQUITY_INVARIANT_BROKEN');
  const ids = new Set();
  for (const s of state.signals || []) {
    if (ids.has(s.signalId)) problems.push(`DUPLICATE_SIGNAL_ID:${s.signalId}`);
    ids.add(s.signalId);
  }
  return { ok: problems.length === 0, problems };
}

export class StateStore {
  constructor({ dataDir, config, clock, log = () => {}, codeVersion = 'dev' }) {
    this.dataDir = dataDir;
    this.config = config;
    this.clock = clock;
    this.log = log;
    this.codeVersion = codeVersion;
    this.stateFile = path.join(dataDir, 'state.json');
    this.eventsFile = path.join(dataDir, 'events.jsonl');
    this.outboxFile = path.join(dataDir, 'outbox.json');
    this.journalDir = path.join(dataDir, 'journal');
  }

  async init() { await ensureDataDirs(this.dataDir); }

  async load() {
    try {
      const raw = await readFile(this.stateFile, 'utf8');
      return JSON.parse(raw);
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw new Error(`STATE_UNREADABLE:${e.message}`);
    }
  }

  async loadOutbox() {
    try { return JSON.parse(await readFile(this.outboxFile, 'utf8')); } catch { return []; }
  }

  async save({ state, outbox }) {
    const tmp = `${this.stateFile}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2));
    const fh = await open(tmp, 'r+');
    try { await fh.sync(); } finally { await fh.close(); }
    await rename(tmp, this.stateFile);
    if (outbox) await writeFile(this.outboxFile, JSON.stringify(outbox, null, 2));
  }

  /**
   * Mutasi atomik: journal dulu, lalu apply (events → outbox → state), lalu hapus journal.
   * mutate(state) harus murni dan mengembalikan { events: [...], outbox: [...], skip?:true }
   */
  async transact(mutate, { txnId } = {}) {
    const state = await this.load();
    if (!state) throw new Error('STATE_MISSING');
    const outbox = await this.loadOutbox();
    const workingState = structuredClone(state);
    const workingOutbox = structuredClone(outbox);
    const nowMs = this.clock.trustedNow();

    const result = mutate(workingState, workingOutbox, nowMs) || {};
    if (result.skip) return { skipped: true, state };

    const events = [];
    let prevHash = workingState.lastEventHash || GENESIS_HASH;
    let seq = workingState.lastEventSequenceNo || 0;
    for (const body of result.events || []) {
      seq += 1;
      const event = buildEvent({ seq, prevHash, body: { ...body, timestampUtc: body.timestampUtc || new Date(nowMs).toISOString() }, codeVersion: this.codeVersion });
      events.push(event);
      prevHash = event.eventHash;
    }
    if (events.length) {
      workingState.lastEventSequenceNo = seq;
      workingState.lastEventHash = prevHash;
    }
    workingState.stateVersion = (workingState.stateVersion || 0) + 1;

    const journal = await writeJournal(this.journalDir, {
      txnId,
      baseStateVersion: state.stateVersion,
      newState: workingState,
      events,
      outbox: workingOutbox,
    });

    // Apply berurutan dan idempoten.
    if (events.length) await appendEvents(this.eventsFile, events);
    await writeFile(this.outboxFile, JSON.stringify(workingOutbox, null, 2));
    await this.save({ state: workingState });
    await removeJournal(journal.file);
    return { state: workingState, outbox: workingOutbox, events };
  }

  /** Replay journal yang tertinggal saat startup. */
  async recover() {
    const journals = await listJournals(this.journalDir);
    if (!journals.length) return { replayed: 0 };
    const state = await this.load();
    let replayed = 0;
    for (const file of journals) {
      let j;
      try { j = JSON.parse(await readFile(file, 'utf8')); } catch { this.log('JOURNAL_CORRUPT', { file }); continue; }
      if (!state || state.stateVersion === j.baseStateVersion) {
        if (j.events?.length) await appendEvents(this.eventsFile, j.events);
        if (j.outbox) await writeFile(this.outboxFile, JSON.stringify(j.outbox, null, 2));
        if (j.newState) await this.save({ state: j.newState });
        replayed += 1;
      } else if (state.stateVersion === j.baseStateVersion + 1 && sha256OfValue(state) === sha256OfValue(j.newState)) {
        // Apply sudah selesai; hanya bersihkan journal.
      } else {
        this.log('JOURNAL_STATE_MISMATCH', { file, base: j.baseStateVersion, current: state?.stateVersion });
      }
      await removeJournal(file);
    }
    if (replayed) this.log('JOURNAL_REPLAYED', { count: replayed });
    return { replayed };
  }

  async verifyAuditChain() {
    const events = await readEvents(this.eventsFile);
    const v = await verifyChain(events);
    return v;
  }

  async appendSystemEvent(kind, detail = {}) {
    const state = await this.load();
    if (!state) return null;
    return this.transact((s) => ({ events: [{ kind, ...detail }] }));
  }

  async backup(destDir, { nowMs, keepDaily = 14 } = {}) {
    if (!Number.isFinite(nowMs)) throw new Error('CLOCK_REQUIRED:backup');
    await mkdir(destDir, { recursive: true });
    const stamp = new Date(nowMs).toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const file = path.join(destDir, `state-${stamp}.json`);
    await cp(this.stateFile, file);
    const sizeMb = await journalSizeMb(this.eventsFile);
    return { file, sizeMb };
  }
}
