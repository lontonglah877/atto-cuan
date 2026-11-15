// Journal transaksi tulis-dulu: atomisitas state + events + outbox lintas-berkas.
import { open, readFile, writeFile, rename, unlink, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

async function fsyncFile(file) {
  const fh = await open(file, 'r+');
  try { await fh.sync(); } finally { await fh.close(); }
}

export async function writeJournal(journalDir, txn) {
  const txnId = txn.txnId || randomUUID();
  const file = path.join(journalDir, `${txnId}.json`);
  const payload = JSON.stringify({ ...txn, txnId });
  await writeFile(file, payload);
  await fsyncFile(file);
  return { txnId, file };
}

export async function removeJournal(file) {
  try { await unlink(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

export async function listJournals(journalDir) {
  const names = await readdir(journalDir).catch(() => []);
  return names.filter((n) => n.endsWith('.json')).sort().map((n) => path.join(journalDir, n));
}

export function sha256OfValue(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
