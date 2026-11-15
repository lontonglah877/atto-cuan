// Audit trail berantai (events.jsonl). Kanonikalisasi satu implementasi.

import { appendFile, readFile, mkdir, stat } from 'node:fs/promises';
import { sha256Canonical, GENESIS_HASH } from './canonical-json.mjs';

export function buildEvent({ seq, prevHash, body, codeVersion = 'unknown' }) {
  const event = { sequenceNo: seq, codeVersion, ...body, previousEventHash: prevHash };
  event.eventHash = sha256Canonical(event);
  return event;
}

export async function readEvents(file) {
  const raw = await readFile(file, 'utf8').catch(() => '');
  return raw.split('\n').filter((l) => l.trim()).map((l) => {
    try { return JSON.parse(l); } catch { return { corrupt: true, raw: l.slice(0, 200) }; }
  });
}

export async function verifyChain(events) {
  let prev = GENESIS_HASH;
  const problems = [];
  for (let i = 0; i < events.length; i += 1) {
    const e = events[i];
    if (e.corrupt) { problems.push({ index: i, issue: 'JSON_CORRUPT' }); continue; }
    const { eventHash, ...rest } = e;
    if (e.previousEventHash !== prev) problems.push({ index: i, issue: 'PREV_HASH_MISMATCH', seq: e.sequenceNo });
    const recomputed = sha256Canonical(rest);
    if (recomputed !== eventHash) problems.push({ index: i, issue: 'EVENT_HASH_MISMATCH', seq: e.sequenceNo });
    prev = eventHash;
  }
  return { ok: problems.length === 0, problems, lastHash: prev, count: events.length };
}

export function appendEvents(file, events) {
  if (!events.length) return Promise.resolve();
  return appendFile(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

export async function journalSizeMb(file) {
  try { return (await stat(file)).size / (1024 * 1024); } catch { return 0; }
}

export async function ensureDataDirs(dataDir) {
  await mkdir(dataDir, { recursive: true });
  await mkdir(`${dataDir}/journal`, { recursive: true });
  await mkdir(`${dataDir}/locks`, { recursive: true });
}
