// Outbox idempoten: enqueue dalam transaksi, dikirim notifier di luar lock.

export const PRIORITY = Object.freeze({ P0: 'P0', P1: 'P1', P2: 'P2' });

export function enqueue(outbox, { idempotencyKey, priority = PRIORITY.P1, kind, text, parseMode = 'HTML', nowMs }) {
  if (outbox.some((o) => o.idempotencyKey === idempotencyKey)) return null;
  const item = {
    outboxId: `OB-${String(outbox.length + 1).padStart(6, '0')}`,
    idempotencyKey,
    priority,
    kind,
    payload: { parseMode, text },
    status: 'PENDING',
    retryCount: 0,
    nextAttemptAtUtc: new Date(nowMs).toISOString(),
    leaseUntilUtc: null,
    createdAtUtc: new Date(nowMs).toISOString(),
    sentAtUtc: null,
    telegramMessageId: null,
  };
  outbox.push(item);
  return item;
}

export function dueItems(outbox, nowMs, limit = 20) {
  return outbox
    .filter((o) => ['PENDING', 'SENDING'].includes(o.status))
    .filter((o) => {
      if (o.status === 'SENDING' && o.leaseUntilUtc && Date.parse(o.leaseUntilUtc) > nowMs) return false;
      return Date.parse(o.nextAttemptAtUtc || o.createdAtUtc) <= nowMs;
    })
    .sort((a, b) => (a.priority === b.priority ? Date.parse(a.createdAtUtc) - Date.parse(b.createdAtUtc) : a.priority === 'P0' ? -1 : 1))
    .slice(0, limit);
}

export function backoffMs(retryCount, priority) {
  const base = 5000 * (2 ** retryCount);
  const cap = priority === PRIORITY.P0 ? 300000 : 900000;
  const jitter = 1 + (Math.random() * 0.4 - 0.2);
  return Math.min(base * jitter, cap);
}

export function markSent(item, { nowMs, telegramMessageId }) {
  item.status = 'SENT';
  item.sentAtUtc = new Date(nowMs).toISOString();
  item.telegramMessageId = telegramMessageId ?? null;
  item.leaseUntilUtc = null;
}

export function markFailed(item, { nowMs, permanent, error, retryAfterMs = null }) {
  item.retryCount += 1;
  item.lastError = error;
  item.leaseUntilUtc = null;
  if (permanent) {
    item.status = 'FAILED_PERMANENT';
    return;
  }
  const delay = retryAfterMs ?? backoffMs(item.retryCount, item.priority);
  item.status = 'PENDING';
  item.nextAttemptAtUtc = new Date(nowMs + delay).toISOString();
}

export function pruneOutbox(outbox, { nowMs, sentDays = 7, failedDays = 30 }) {
  const sentCut = nowMs - sentDays * 86400000;
  const failedCut = nowMs - failedDays * 86400000;
  return outbox.filter((o) => {
    if (o.status === 'SENT') return Date.parse(o.sentAtUtc) >= sentCut;
    if (o.status === 'FAILED_PERMANENT') return Date.parse(o.createdAtUtc) >= failedCut;
    return true;
  });
}

export function splitMessage(text, max = 4096) {
  if (text.length <= max) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) parts.push(rest);
  return parts;
}
