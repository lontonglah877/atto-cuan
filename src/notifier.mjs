// Notifier: penggerak outbox at-least-once. Transport pluggable; default `NullTransport` (dry-run).
// Tidak pernah mengirim lebih dari satu kali untuk idempotencyKey yang sama (dedup di outbox + lease).

import { dueItems, markSent, markFailed, pruneOutbox, splitMessage } from './outbox.mjs';

/** Transport yang tidak mengirim apa pun; dipakai saat Telegram belum aktif. */
export class NullTransport {
  constructor({ log = () => {} } = {}) { this.name = 'null'; this.log = log; }
  async send() { return { ok: true, messageId: null }; }
  async health() { return { ok: true, detail: 'dry-run' }; }
}

/** Pembatas laju sederhana per menit (sliding window). */
function makeRateLimiter(perMinute) {
  const stamps = [];
  return {
    allow(nowMs) {
      while (stamps.length && nowMs - stamps[0] >= 60_000) stamps.shift();
      if (stamps.length >= perMinute) return false;
      stamps.push(nowMs);
      return true;
    },
  };
}

/**
 * Kirim item outbox yang jatuh tempo.
 * @returns {{sent:number, failed:number, retried:number, throttled:boolean}}
 */
export async function drainOutbox({ store, transport, config, clock, log = () => {}, nowMs = null, limit = 20 }) {
  const t = nowMs ?? clock.trustedNow();
  const outbox = await store.loadOutbox();
  const due = dueItems(outbox, t, limit);
  const stats = { sent: 0, failed: 0, retried: 0, throttled: false, skipped: 0 };
  if (!due.length) return stats;

  const limiter = makeRateLimiter(config.telegram.rateLimitPerMinute);
  const maxChars = config.telegram.maxMessageChars;

  for (const item of due) {
    if (!limiter.allow(t)) { stats.throttled = true; stats.skipped = due.length - (stats.sent + stats.failed + stats.retried); break; }

    // Klaim (lease) dulu, lalu kirim di luar transaksi.
    let claimed = false;
    await store.transact((s, ob) => {
      const it = ob.find((o) => o.outboxId === item.outboxId);
      if (!it || it.status === 'SENT' || it.status === 'FAILED_PERMANENT') return { skip: true };
      it.status = 'SENDING';
      it.leaseUntilUtc = new Date(t + 120_000).toISOString();
      claimed = true;
      return { events: [] };
    });
    if (!claimed) continue;

    const parts = splitMessage(item.payload?.text || '', maxChars);
    let lastMessageId = null;
    let error = null;
    for (let i = 0; i < parts.length; i += 1) {
      try {
        const res = await transport.send({ text: parts[i], parseMode: item.payload?.parseMode || 'HTML', idempotencyKey: `${item.idempotencyKey}#${i}` });
        if (!res || res.ok === false) throw Object.assign(new Error(res?.error || 'SEND_REJECTED'), { code: 'SEND_REJECTED', retryAfterSec: res?.retryAfterSec ?? null, permanent: res?.permanent === true });
        lastMessageId = res.messageId ?? lastMessageId;
      } catch (e) {
        error = e;
        break;
      }
    }

    if (!error) {
      await store.transact((s, ob) => {
        const it = ob.find((o) => o.outboxId === item.outboxId);
        if (!it) return { skip: true };
        markSent(it, { nowMs: t, telegramMessageId: lastMessageId });
        it.parts = parts.length;
        return { events: [{ kind: 'OUTBOX_SENT', outboxId: it.outboxId, outboxKind: it.kind, parts: parts.length }] };
      });
      stats.sent += 1;
      continue;
    }

    const permanent = error.permanent === true || error.httpStatus === 400 || error.httpStatus === 403;
    await store.transact((s, ob) => {
      const it = ob.find((o) => o.outboxId === item.outboxId);
      if (!it) return { skip: true };
      markFailed(it, { nowMs: t, permanent, error: error.code || error.message, retryAfterMs: error.retryAfterSec ? error.retryAfterSec * 1000 : null });
      return { events: [{ kind: permanent ? 'OUTBOX_FAILED_PERMANENT' : 'OUTBOX_RETRY', outboxId: it.outboxId, outboxKind: it.kind, error: error.code || error.message, retryCount: it.retryCount }] };
    });
    if (permanent) stats.failed += 1; else stats.retried += 1;
  }

  return stats;
}

/** Buang item lama yang sudah SENT/FAILED_PERMANENT sesuai retensi. */
export async function pruneOutboxIfNeeded({ store, config, clock, nowMs = null }) {
  const t = nowMs ?? clock.trustedNow();
  const before = (await store.loadOutbox()).length;
  await store.transact((s, ob) => {
    const kept = pruneOutbox(ob, { nowMs: t, sentDays: config.retention.outboxSentDays, failedDays: config.retention.outboxFailedDays });
    if (kept.length === ob.length) return { events: [] };
    ob.splice(0, ob.length, ...kept);
    return { events: [{ kind: 'OUTBOX_PRUNED', removed: before - kept.length }] };
  });
  return { before, after: (await store.loadOutbox()).length };
}
