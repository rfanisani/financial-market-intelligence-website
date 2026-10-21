// Financial Intelligence Lab — pure analysis functions.
// Single source of truth for the lab tools, shared by the Node test suite and
// the browser module (public/js/lab.js). No DOM, no fetch, no dependencies.
//
// Every function validates its inputs and returns null when the data is
// missing, malformed, or insufficient — callers must show a localized error
// instead of a fabricated result.

/** Time windows offered by the lab, in calendar days (matches data/history-*.json). */
export const LAB_WINDOWS = Object.freeze([7, 30, 365]);

/**
 * Map a raw form value to a supported window. Unknown or missing values fall
 * back to 7 days. Used by the browser UI so "1 year" (365) is never silently
 * replaced by the 7-day series.
 * @param {unknown} value
 * @returns {7|30|365}
 */
export function resolveWindow(value) {
  const n = Number(value);
  return LAB_WINDOWS.includes(n) ? n : 7;
}

/**
 * Validate a price series: at least two finite, strictly positive numbers.
 * @param {unknown} values
 * @returns {number[]|null} the cleaned series, or null when invalid
 */
function cleanSeries(values) {
  if (!Array.isArray(values) || values.length < 2) return null;
  const v = values.map(Number);
  if (!v.every((x) => Number.isFinite(x) && x > 0)) return null;
  return v;
}

/**
 * Simple returns between consecutive points: r[i] = (v[i] - v[i-1]) / v[i-1].
 * @param {unknown} values
 * @returns {number[]|null} one return per step (length = series length - 1)
 */
export function simpleReturns(values) {
  const v = cleanSeries(values);
  if (!v) return null;
  const r = [];
  for (let i = 1; i < v.length; i++) r.push((v[i] - v[i - 1]) / v[i - 1]);
  return r;
}

/**
 * Total return over the whole window.
 * @param {unknown} values
 * @returns {{first: number, last: number, pct: number, points: number}|null}
 */
export function periodReturn(values) {
  const v = cleanSeries(values);
  if (!v) return null;
  const first = v[0], last = v[v.length - 1];
  return { first, last, pct: ((last - first) / first) * 100, points: v.length };
}

/**
 * Annualised volatility: sample standard deviation of the daily returns,
 * scaled by sqrt(periodsPerYear) (252 trading days, by convention).
 * Needs at least 3 points (2 returns).
 * @param {unknown} values
 * @param {number} [periodsPerYear=252]
 * @returns {{n: number, dailyStd: number, annualized: number}|null}
 */
export function volatility(values, periodsPerYear = 252) {
  const r = simpleReturns(values);
  if (!r || r.length < 2) return null;
  const n = r.length;
  const mean = r.reduce((a, b) => a + b, 0) / n;
  const variance = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const dailyStd = Math.sqrt(variance);
  return { n, dailyStd, annualized: dailyStd * Math.sqrt(periodsPerYear) };
}

/**
 * Maximum drawdown: the largest peak-to-trough decline within the window.
 * @param {unknown} values
 * @returns {{pct: number, from: number, to: number, points: number}|null}
 *   pct is <= 0 (exactly 0 when the series never falls below a previous peak).
 */
export function maxDrawdown(values) {
  const v = cleanSeries(values);
  if (!v) return null;
  let peak = v[0], peakIdx = 0, worst = 0, from = 0, to = 0;
  for (let i = 1; i < v.length; i++) {
    if (v[i] > peak) { peak = v[i]; peakIdx = i; }
    const dd = (v[i] - peak) / peak;
    if (dd < worst) { worst = dd; from = peakIdx; to = i; }
  }
  return { pct: worst * 100, from, to, points: v.length };
}

/**
 * Simple moving average. Entries before the first full window are null.
 * @param {unknown} values
 * @param {unknown} window
 * @returns {(number|null)[]|null}
 */
export function sma(values, window) {
  const v = cleanSeries(values);
  if (!v || !Number.isInteger(window) || window < 1 || window > v.length) return null;
  const out = new Array(v.length).fill(null);
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    sum += v[i];
    if (i >= window) sum -= v[i - window];
    if (i >= window - 1) out[i] = sum / window;
  }
  return out;
}

/**
 * Trend signal: latest price vs. its moving average.
 * direction is 'up'/'down' when the gap exceeds ±0.05%, otherwise 'flat'.
 * @param {unknown} values
 * @param {unknown} window
 * @returns {{window: number, sma: number, last: number, vsSmaPct: number, direction: string}|null}
 */
export function trendSignal(values, window) {
  const v = cleanSeries(values);
  const s = sma(values, window);
  if (!v || !s) return null;
  const lastSma = s[s.length - 1];
  if (!Number.isFinite(lastSma)) return null;
  const last = v[v.length - 1];
  const vsSmaPct = ((last - lastSma) / lastSma) * 100;
  const direction = vsSmaPct > 0.05 ? 'up' : vsSmaPct < -0.05 ? 'down' : 'flat';
  return { window, sma: lastSma, last, vsSmaPct, direction };
}

/**
 * Rebase a series to 100 at the first point (for visual comparison).
 * @param {unknown} values
 * @returns {number[]|null}
 */
export function normalize(values) {
  const v = cleanSeries(values);
  if (!v) return null;
  return v.map((x) => (x / v[0]) * 100);
}

/**
 * Pearson correlation between the daily returns of two series.
 * Needs at least 2 return pairs and non-zero variance on both sides.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {number|null} between -1 and 1
 */
export function correlation(a, b) {
  const ra = simpleReturns(a), rb = simpleReturns(b);
  if (!ra || !rb || ra.length !== rb.length || ra.length < 2) return null;
  const n = ra.length;
  const ma = ra.reduce((x, y) => x + y, 0) / n;
  const mb = rb.reduce((x, y) => x + y, 0) / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    cov += (ra[i] - ma) * (rb[i] - mb);
    va += (ra[i] - ma) ** 2;
    vb += (rb[i] - mb) ** 2;
  }
  const denom = Math.sqrt(va * vb);
  if (!(denom > 0)) return null;
  return cov / denom;
}

/**
 * Compare two series over the same window: normalised performance, return
 * spread and return correlation.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {{aPct: number, bPct: number, spreadPct: number, correlation: number|null, a: number[], b: number[]}|null}
 */
export function compareAssets(a, b) {
  const na = normalize(a), nb = normalize(b);
  if (!na || !nb || na.length !== nb.length) return null;
  return {
    aPct: na[na.length - 1] - 100,
    bPct: nb[nb.length - 1] - 100,
    spreadPct: na[na.length - 1] - nb[nb.length - 1],
    correlation: correlation(a, b),
    a: na,
    b: nb,
  };
}

/**
 * Moving-average signal backtest (gross, no fees or taxes).
 *   state = 1 (in market) when the close is above its n-day moving average, else 0.
 *   The position decided at close t earns the return from t to t+1.
 *   Buy = state turns 1, sell = state turns 0. Trades are measured close-to-close.
 * @param {unknown} values  daily closes
 * @param {unknown} window  moving-average window (>= 2, < length - 1)
 * @returns {object|null}
 */
export function signalBacktest(values, window) {
  const v = cleanSeries(values);
  const s = sma(values, window);
  if (!v || !s) return null;
  const n = v.length;
  const start = window - 1;
  if (n - start < 3) return null;

  const signals = [];
  const trades = [];
  let state = 0, entry = null;
  let strat = 1, bh = 1, hits = 0, longDays = 0;
  const equity = [1];
  const bhSeries = [1];

  for (let t = start; t < n; t++) {
    const above = v[t] > s[t] ? 1 : 0;
    if (above !== state) {
      state = above;
      if (state === 1) {
        entry = t;
        signals.push({ i: t, type: 'buy' });
      } else {
        trades.push({ entry, exit: t, retPct: (v[t] / v[entry] - 1) * 100, win: v[t] > v[entry], open: false });
        entry = null;
        signals.push({ i: t, type: 'sell' });
      }
    }
    if (t < n - 1) {
      const r = v[t + 1] / v[t] - 1;
      strat *= 1 + state * r;
      bh *= 1 + r;
      if (state === 1 && r !== 0) { longDays++; if (r > 0) hits++; }
      equity.push(strat);
      bhSeries.push(bh);
    }
  }
  if (entry !== null) {
    trades.push({ entry, exit: n - 1, retPct: (v[n - 1] / v[entry] - 1) * 100, win: v[n - 1] > v[entry], open: true });
  }

  const closed = trades.filter((t) => !t.open);
  const wins = closed.filter((t) => t.win).length;
  const last = n - 1;
  return {
    window,
    start,
    sma: s,
    signals,
    trades,
    closedCount: closed.length,
    wins,
    winRate: closed.length ? (wins / closed.length) * 100 : null,
    avgTradePct: closed.length ? closed.reduce((a, t) => a + t.retPct, 0) / closed.length : null,
    openPosition: entry !== null,
    strategyPct: (strat - 1) * 100,
    buyHoldPct: (v[last] / v[start] - 1) * 100,
    hitLong: { hits, n: longDays, pct: longDays ? (hits / longDays) * 100 : null },
    equity,            // strategy growth index from `start`
    buyHold: bhSeries, // buy & hold growth index from `start`
    current: { inMarket: state === 1, last: v[last], sma: s[last], vsSmaPct: (v[last] / s[last] - 1) * 100 },
  };
}

/**
 * Moving-average regimes: how often the price sat above or below its moving
 * average, and how long each stretch on one side lasted (in data points).
 * Days where the price equals the average are skipped and do not end a stretch.
 * `runs` lists only finished stretches; `current` is the stretch still open at the end.
 * @param {unknown} values
 * @param {unknown} window
 * @returns {{window: number, n: number, aboveDays: number, belowDays: number,
 *   abovePct: number, belowPct: number,
 *   above: {runs: number, avg: number|null, max: number|null},
 *   below: {runs: number, avg: number|null, max: number|null},
 *   current: {side: string, len: number}|null}|null}
 */
export function smaRegimes(values, window) {
  const v = cleanSeries(values);
  const s = sma(values, window);
  if (!v || !s) return null;
  let n = 0, aboveDays = 0, belowDays = 0;
  const closed = { above: [], below: [] };
  let side = null, len = 0;
  for (let i = 0; i < v.length; i++) {
    const m = s[i];
    if (!Number.isFinite(m)) continue;
    const st = v[i] > m ? 'above' : v[i] < m ? 'below' : null;
    if (!st) continue;
    n++;
    if (st === 'above') aboveDays++; else belowDays++;
    if (st === side) {
      len++;
    } else {
      if (side) closed[side].push(len);
      side = st;
      len = 1;
    }
  }
  if (n === 0) return null;
  const summary = (runs) => ({
    runs: runs.length,
    avg: runs.length ? runs.reduce((a, b) => a + b, 0) / runs.length : null,
    max: runs.length ? Math.max(...runs) : null,
  });
  return {
    window,
    n,
    aboveDays,
    belowDays,
    abovePct: (aboveDays / n) * 100,
    belowPct: (belowDays / n) * 100,
    above: summary(closed.above),
    below: summary(closed.below),
    current: side ? { side, len } : null,
  };
}
