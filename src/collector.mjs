// Adapter data publik Binance & Indodax. Read-only. Failover endpoint + anggaran rate-limit.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `eth_idr` -> `ethidr`. Indodax memakai slug tanpa garis bawah pada path (bukan query). */
export function pairSlug(pair) {
  return String(pair).replace(/_/g, '').toLowerCase();
}

export class HttpBudget {
  constructor({ minIntervalMs = 0, maxPerCycle = 60, now }) {
    if (typeof now !== 'function') throw new Error('CLOCK_REQUIRED:HttpBudget');
    this.now = now;
    this.minIntervalMs = minIntervalMs;
    this.maxPerCycle = maxPerCycle;
    this.used = 0;
    this.lastAt = 0;
  }
  reset() { this.used = 0; this.lastAt = 0; }
  async take(label) {
    if (this.used >= this.maxPerCycle) throw new Error(`RATE_BUDGET_EXHAUSTED:${label}`);
    const wait = this.lastAt + this.minIntervalMs - this.now();
    if (wait > 0) await sleep(wait);
    this.used += 1;
    this.lastAt = this.now();
  }
}

async function httpJson(url, { timeoutMs = 8000, budget = null, label = url, fetchImpl = globalThis.fetch } = {}) {
  if (budget) await budget.take(label);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'atto-cuan/1.5.0 (+read-only)' },
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`HTTP_${res.status}`);
      err.httpStatus = res.status;
      err.retryAfterSec = Number(res.headers.get('retry-after')) || null;
      err.body = text.slice(0, 300);
      throw err;
    }
    try { return JSON.parse(text); } catch { throw new Error('JSON_PARSE_ERROR'); }
  } finally { clearTimeout(timer); }
}

/** Coba endpoint berurutan; hanya lanjut setelah timeout/5xx/429/parse error. */
async function withFailover(endpoints, path, opts = {}) {
  let lastErr = null;
  for (const base of endpoints) {
    try {
      const body = await httpJson(base + path, { ...opts, label: path });
      return { body, endpoint: base };
    } catch (e) {
      lastErr = e;
      if (e.httpStatus === 404) break;
      if (e.retryAfterSec) await sleep(Math.min(e.retryAfterSec * 1000, 5000));
    }
  }
  throw lastErr || new Error('NO_ENDPOINT');
}

export function parseKlines(raw) {
  return raw.map((k) => ({
    openTime: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    closeTime: Number(k[6]),
  }));
}

export class Collector {
  constructor({ config, clock, budget, log = () => {}, fetchImpl = globalThis.fetch }) {
    this.config = config;
    this.clock = clock;
    this.fetchImpl = fetchImpl;
    this.budget = budget || new HttpBudget({ maxPerCycle: 80, now: () => clock.rawNow() });
    this.log = log;
    this.endpoints = {
      binance: config.sources.binance.endpoints.map((e) => e.replace(/\/$/, '')),
      indodax: config.sources.indodax.endpoints.map((e) => e.replace(/\/$/, '')),
    };
  }

  async binanceTime() {
    const { body, endpoint } = await withFailover(this.endpoints.binance, '/api/v3/time', { fetchImpl: this.fetchImpl, budget: this.budget });
    return { serverTimeMs: Number(body.serverTime), endpoint };
  }

  /** Estimasi offset gaya NTP: 3 sampel berjarak 200 ms. */
  async clockSamples(samples = this.config.clock.samples || 3) {
    const out = [];
    for (let i = 0; i < samples; i += 1) {
      const t0 = this.clock.rawNow();
      const { serverTimeMs, endpoint } = await this.binanceTime();
      const t1 = this.clock.rawNow();
      out.push({ t0, t1, serverTimeMs, endpoint });
      if (i < samples - 1) await sleep(200);
    }
    return out;
  }

  async indodaxServerTime() {
    const { body, endpoint } = await withFailover(this.endpoints.indodax, '/server_time', { fetchImpl: this.fetchImpl, budget: this.budget });
    return { serverTimeMs: Number(body.server_time), endpoint };
  }

  async indodaxClockSamples(samples = this.config.clock.samples || 3) {
    const out = [];
    for (let i = 0; i < samples; i += 1) {
      const t0 = this.clock.rawNow();
      const { serverTimeMs, endpoint } = await this.indodaxServerTime();
      const t1 = this.clock.rawNow();
      out.push({ t0, t1, serverTimeMs, endpoint });
      if (i < samples - 1) await sleep(200);
    }
    return out;
  }

  async klines(symbol, interval, limit = 1000) {
    const { body, endpoint } = await withFailover(
      this.endpoints.binance,
      `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
      { fetchImpl: this.fetchImpl, budget: this.budget, timeoutMs: 12000 },
    );
    return { candles: parseKlines(body), endpoint };
  }

  async bookTicker(symbol) {
    const { body, endpoint } = await withFailover(
      this.endpoints.binance,
      `/api/v3/ticker/bookTicker?symbol=${symbol}`,
      { fetchImpl: this.fetchImpl, budget: this.budget },
    );
    return { bid: Number(body.bidPrice), ask: Number(body.askPrice), endpoint };
  }

  async indodaxTicker(pair) {
    const { body, endpoint } = await withFailover(this.endpoints.indodax, `/ticker/${pair}`, { fetchImpl: this.fetchImpl, budget: this.budget });
    const t = body.ticker;
    return {
      pair,
      bid: Number(t.buy),
      ask: Number(t.sell),
      last: Number(t.last),
      high24h: Number(t.high),
      low24h: Number(t.low),
      marketTimeMs: Number(t.server_time) * 1000,
      volIdr: Number(t.vol_idr),
      endpoint,
    };
  }

  async indodaxDepth(pair) {
    // Terverifikasi 2026-11-14: `/depth?pair=eth_idr` mengabaikan parameter dan mengembalikan
    // buku BTC. Bentuk yang benar adalah slug tanpa garis bawah: `/depth/ethidr`.
    const { body, endpoint } = await withFailover(this.endpoints.indodax, `/depth/${pairSlug(pair)}`, { fetchImpl: this.fetchImpl, budget: this.budget });
    const asks = (body.sell || []).map(([p, q]) => [Number(p), Number(q)]).sort((a, b) => a[0] - b[0]);
    const bids = (body.buy || []).map(([p, q]) => [Number(p), Number(q)]).sort((a, b) => b[0] - a[0]);
    return { asks, bids, endpoint };
  }

  /** Indodax tidak menyediakan OHLC 1m; candle dibentuk dari trade summary. */
  async indodaxTrades(pair, limit = 500) {
    const { body, endpoint } = await withFailover(
      this.endpoints.indodax, `/trades/${pairSlug(pair)}?limit=${limit}`, { fetchImpl: this.fetchImpl, budget: this.budget },
    );
    return { trades: body.map((t) => ({ ts: Number(t.date) * 1000, price: Number(t.price), amount: Number(t.amount) })), endpoint };
  }
}

/** Agregasi trade menjadi candle 1m tertutup. */
export function tradesToCandles(trades) {
  const buckets = new Map();
  for (const t of trades) {
    const openTime = Math.floor(t.ts / 60000) * 60000;
    const cur = buckets.get(openTime);
    if (!cur) {
      buckets.set(openTime, { openTime, open: t.price, high: t.price, low: t.price, close: t.price, volume: t.amount });
    } else {
      cur.high = Math.max(cur.high, t.price);
      cur.low = Math.min(cur.low, t.price);
      cur.close = t.price;
      cur.volume += t.amount;
    }
  }
  return [...buckets.values()]
    .sort((a, b) => a.openTime - b.openTime)
    .map((c) => ({ ...c, closeTime: c.openTime + 59999, source: 'indodax-trades' }));
}
