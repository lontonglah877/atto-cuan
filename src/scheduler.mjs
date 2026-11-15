// Penjadwal selaras grid: tick berikutnya dihitung dari trustedNow, tanpa akumulasi drift.

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/** Waktu absolut tick berikutnya pada grid intervalMs + offsetMs. */
export function nextTick(nowMs, intervalMs, offsetMs = 0) {
  const grid = Math.floor((nowMs - offsetMs) / intervalMs) + 1;
  return grid * intervalMs + offsetMs;
}

/** true bila siklus sebelumnya belum selesai -> siklus ini dilewati (tanpa burst). */
export function shouldSkip({ running, lastStartedAtMs, nowMs, intervalMs, minGapMs = 1000 }) {
  if (running) return { skip: true, reason: 'CYCLE_OVERLAP' };
  if (lastStartedAtMs != null && nowMs - lastStartedAtMs < minGapMs) return { skip: true, reason: 'TOO_SOON' };
  if (lastStartedAtMs != null && nowMs - lastStartedAtMs > 2 * intervalMs) return { skip: false, reason: 'CATCH_UP_SINGLE' };
  return { skip: false, reason: null };
}

/** Selisih ke waktu lokal "HH:MM" berikutnya (detik ke-0). */
export function msUntilLocalTime(nowMs, localTime, timezoneOffsetMinutes) {
  const shifted = nowMs + timezoneOffsetMinutes * MINUTE;
  const dayStart = Math.floor(shifted / DAY) * DAY;
  const [h, m] = localTime.split(':').map(Number);
  const target = dayStart + h * HOUR + m * MINUTE;
  if (target > shifted) return target - shifted;
  return target + DAY - shifted;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}
