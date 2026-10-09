// Financial Intelligence Lab — pure analysis functions.
// Single source of truth for the lab tools, shared by the Node test suite and
// the browser module (public/js/lab.js). No DOM, no fetch, no dependencies.
//
// Every function validates its inputs and returns null when the data is
// missing, malformed, or insufficient — callers must show a localized error
// instead of a fabricated result.

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
