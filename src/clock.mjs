// Penyedia waktu terkoreksi. Satu-satunya modul yang boleh memanggil Date.now().

export class Clock {
  constructor({ rawNow = () => Date.now() } = {}) {
    this.rawNow = rawNow;
    this.offsetMs = 0;
    this.status = 'UNKNOWN';
    this.perSource = {};
    this.lastMeasuredAtMs = null;
  }

  trustedNow() {
    return this.rawNow() - this.offsetMs;
  }

  setOffset(offsetMs, status = 'OK') {
    this.offsetMs = offsetMs;
    this.status = status;
    this.lastMeasuredAtMs = this.rawNow();
  }
}

export function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * Estimasi offset gaya NTP.
 * samples: [{ t0, t1, serverTimeMs }]  (t0/t1 = jam lokal sebelum/sesudah request)
 * offset = serverTimeMs − (t0+t1)/2 ; positif berarti jam server lebih maju.
 */
export function estimateOffset({ samples, rttMaxMs = 2000, minValid = 2 }) {
  const accepted = [];
  let lastRtt = 0;
  for (const s of samples) {
    const rtt = s.t1 - s.t0;
    lastRtt = rtt;
    if (!Number.isFinite(rtt) || rtt <= 0 || rtt > rttMaxMs) continue;
    accepted.push({ offset: s.serverTimeMs - (s.t0 + s.t1) / 2, rtt });
  }
  if (accepted.length < minValid) {
    return { status: 'UNKNOWN', offsetMs: null, accepted: accepted.length, rejected: samples.length - accepted.length, lastRtt };
  }
  return {
    status: 'OK',
    offsetMs: median(accepted.map((a) => a.offset)),
    accepted: accepted.length,
    rejected: samples.length - accepted.length,
    lastRtt,
  };
}

export function combineOffsets({ a, b, maxAgreeMs = 2000 }) {
  if (a == null || b == null) return { status: 'UNKNOWN', offsetMs: null, reason: 'TIME_SOURCE_MISSING' };
  if (Math.abs(a - b) > maxAgreeMs) return { status: 'UNKNOWN', offsetMs: null, reason: 'TIME_SOURCES_DISAGREE' };
  return { status: 'OK', offsetMs: median([a, b]), reason: null };
}

export function classifyClock(offsetMs, { warnMs = 10000, blockMs = 30000 } = {}) {
  if (!Number.isFinite(offsetMs)) return 'CLOCK_INVALID';
  const abs = Math.abs(offsetMs);
  if (abs > blockMs) return 'CLOCK_INVALID';
  if (abs > warnMs) return 'CLOCK_DRIFT_WARNING';
  return 'OK';
}
