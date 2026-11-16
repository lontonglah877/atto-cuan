// Laporan harian: digest pagi dan heartbeat, tepat satu kali per tanggal lokal.
// Dijalankan di dalam siklus (masih memegang lock instance), lalu outbox dikirim notifier.

import { readEvents } from './audit.mjs';
import { enqueue, PRIORITY } from './outbox.mjs';
import { renderDigest, renderHeartbeat } from './messages.mjs';
import { localDate, timezoneOffsetMinutes, ACTIVE_POSITION_STATUSES } from './state-store.mjs';
import { openRiskTotal } from './position-manager.mjs';

export const DIGEST_HOUR_LOCAL = 7;
export const HEARTBEAT_HOUR_LOCAL = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

export function localHour(nowMs, timezone = 'Asia/Makassar') {
  return new Date(nowMs + timezoneOffsetMinutes(timezone) * 60000).getUTCHours();
}

/** Statistik 24 jam terakhir dari rantai audit (bukan tebakan dari state). */
export async function digestStats({ eventsFile, nowMs, positions = [] }) {
  const events = await readEvents(eventsFile);
  const from = nowMs - DAY_MS;
  const inWindow = events.filter((e) => {
    if (e.corrupt) return false;
    const t = Date.parse(e.timestampUtc);
    return Number.isFinite(t) && t > from && t <= nowMs;
  });
  const count = (kind) => inWindow.filter((e) => e.kind === kind).length;
  return {
    issued24h: count('SIGNAL_ISSUED'),
    blocked24h: count('SIGNAL_BLOCKED'),
    expired24h: count('SIGNAL_EXPIRED_UNRESOLVED'),
    openPositions: positions.filter((p) => ACTIVE_POSITION_STATUSES.includes(p.status)).length,
  };
}

/**
 * Enqueue digest (>= 07:00 lokal) dan heartbeat (>= 08:00 lokal) sekali per tanggal.
 * @returns {{digest:boolean, heartbeat:boolean, dateLocal:string}}
 */
export async function maybeSendDaily({ store, config, clock, log = () => {}, nowMs = null }) {
  const t = nowMs ?? clock.trustedNow();
  const tz = config.operationalTimezone;
  const dateLocal = localDate(t, tz);
  const hour = localHour(t, tz);
  const out = { digest: false, heartbeat: false, dateLocal };

  // Digest pagi.
  if (hour >= DIGEST_HOUR_LOCAL) {
    const stats = await digestStats({ eventsFile: store.eventsFile, nowMs: t, positions: (await store.load())?.positions || [] });
    const res = await store.transact((s, ob) => {
      if (s.digest?.lastSentDateLocal === dateLocal) return { skip: true };
      const text = renderDigest({
        state: s, stats, auditHead: s.lastEventHash, tz, nowMs: t,
        openRiskIdr: openRiskTotal(s.positions || []),
        equityIdr: s.portfolio?.equityReferenceIdr ?? null,
      });
      const item = enqueue(ob, { idempotencyKey: `DIGEST:${dateLocal}`, priority: PRIORITY.P1, kind: 'DIGEST', text, nowMs: t });
      s.digest = { ...(s.digest || {}), lastSentDateLocal: dateLocal, lastSentAtUtc: new Date(t).toISOString() };
      return { events: item ? [{ kind: 'DIGEST_ENQUEUED', dateLocal }] : [] };
    });
    out.digest = !res.skipped;
    if (out.digest) log('DIGEST_ENQUEUED', { dateLocal });
  }

  // Heartbeat pagi hari kerja (Senin–Sabtu).
  const dow = new Date(t + timezoneOffsetMinutes(tz) * 60000).getUTCDay();
  if (hour >= HEARTBEAT_HOUR_LOCAL && dow !== 0) {
    const res = await store.transact((s, ob) => {
      if (s.heartbeat?.lastSentDateLocal === dateLocal) return { skip: true };
      const text = renderHeartbeat({
        state: s, openRiskIdr: openRiskTotal(s.positions || []),
        equityIdr: s.portfolio?.equityReferenceIdr ?? null,
        auditHead: s.lastEventHash, breakerStatus: s.portfolio?.dailyState?.breakerStatus,
        tz, nowMs: t,
      });
      const item = enqueue(ob, { idempotencyKey: `HEARTBEAT:${dateLocal}`, priority: PRIORITY.P2, kind: 'HEARTBEAT', text, nowMs: t });
      s.heartbeat = { ...(s.heartbeat || {}), lastSentDateLocal: dateLocal, lastSentAtUtc: new Date(t).toISOString() };
      return { events: item ? [{ kind: 'HEARTBEAT_ENQUEUED', dateLocal }] : [] };
    });
    out.heartbeat = !res.skipped;
    if (out.heartbeat) log('HEARTBEAT_ENQUEUED', { dateLocal });
  }

  return out;
}
