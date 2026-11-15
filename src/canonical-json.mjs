// Kanonikalisasi JSON (satu implementasi untuk strategyHash, configHash, eventHash).
// Aturan: kunci terurut leksikografis, tanpa spasi, UTF-8, angka tanpa notasi ambigu.

import { createHash } from 'node:crypto';

function encodeNumber(n) {
  if (!Number.isFinite(n)) throw new Error('CANONICAL_NON_FINITE_NUMBER');
  if (Object.is(n, -0)) return '0';
  return JSON.stringify(n);
}

export function canonicalize(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') return encodeNumber(value);
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (t === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
  }
  throw new Error('CANONICAL_UNSUPPORTED_TYPE:' + t);
}

export function sha256Canonical(value) {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}

/** eventId deterministik (replay byte-identik) berbentuk UUID dari hash kanonik. */
export function uuidFromCanonical(value) {
  const hex = sha256Canonical(value).slice(0, 32);
  return [hex.slice(0, 4), hex.slice(4, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 32)].join('-');
}

export const GENESIS_HASH = '0'.repeat(64);
