// Single source of truth for every financial calculation on the site.
// Used by the build (Node), the data pipeline, the tests, and the browser
// (calculator page) so the formula is never duplicated.

/** Troy ounce in grams. */
export const OUNCE_GRAMS = 31.1034768;

/** USD value of one gram of pure gold for a given ounce price. */
export function usdPerGram(ounceUsd) {
  return ounceUsd / OUNCE_GRAMS;
}

/** Pure-gold USD value of one gram of 18K gold. */
export function gold18UsdPerGram(ounceUsd) {
  return usdPerGram(ounceUsd) * 0.75;
}

/** Pure-gold USD value of one gram of 24K gold. */
export function gold24UsdPerGram(ounceUsd) {
  return usdPerGram(ounceUsd) * 0.999;
}

/**
 * Implied USD/IRR rate derived from domestic gold vs. global gold.
 *
 *   implied = domesticPrice / (weightGrams * purity * usdPerGram(globalOunceUsd))
 *
 * @param {number} domesticPrice  Domestic price in toman for one unit
 * @param {number} globalOunceUsd USD per troy ounce of pure gold (XAU)
 * @param {number} purity         Fineness 0..1 (0.750 for 18K, 0.900 for Emami coin)
 * @param {number} weightGrams    Grams per unit (1 for per-gram quotes, 8.133 for Emami coin)
 * @returns {number|null} toman per USD, or null when inputs are invalid
 */
export function impliedUsd({ domesticPrice, globalOunceUsd, purity = 1, weightGrams = 1 }) {
  const goldGrams = weightGrams * purity;
  const pureUsdPerGram = globalOunceUsd / OUNCE_GRAMS;
  if (!(goldGrams > 0) || !(pureUsdPerGram > 0) || !(domesticPrice > 0)) return null;
  return domesticPrice / (goldGrams * pureUsdPerGram);
}

/**
 * Absolute and percentage difference between actual and implied USD rate.
 * @returns {{abs: number, pct: number}|null}
 */
export function difference(actual, implied) {
  if (!(actual > 0) || !(implied > 0)) return null;
  return { abs: implied - actual, pct: ((implied - actual) / actual) * 100 };
}

/**
 * Reverse direction: expected domestic price for a given USD rate.
 * @returns {number|null} toman per unit
 */
export function expectedDomesticPrice({ usdRate, globalOunceUsd, purity = 1, weightGrams = 1 }) {
  const pureUsdPerGram = globalOunceUsd / OUNCE_GRAMS;
  if (!(pureUsdPerGram > 0) || !(usdRate > 0)) return null;
  return usdRate * weightGrams * purity * pureUsdPerGram;
}

// --- USD relation & signal ---------------------------------------------------
// The "relation" is an ordinary least-squares fit of the free-market USD rate on
// the two implied rates (gold 18K and coin) plus a constant, over the last year
// of daily observations. It is a description of past co-movement, not a forecast.

/** Solve A·x = b (square system) by Gaussian elimination with partial pivoting. */
export function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (!(Math.abs(M[p][c]) > 1e-12)) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/**
 * Ordinary least squares. rows: array of feature arrays; y: targets.
 * Columns are scaled before solving (the features differ by ~10^5), then the
 * coefficients are returned in the original units.
 * @returns {number[]|null}
 */
export function olsFit(rows, y) {
  if (!rows.length || rows.length !== y.length) return null;
  const p = rows[0].length;
  const scale = Array.from({ length: p }, (_, j) => Math.max(...rows.map((r) => Math.abs(r[j])), 1e-300));
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const v = new Array(p).fill(0);
  rows.forEach((r, i) => {
    const x = r.map((val, j) => val / scale[j]);
    for (let j = 0; j < p; j++) {
      v[j] += x[j] * y[i];
      for (let k = 0; k < p; k++) A[j][k] += x[j] * x[k];
    }
  });
  const beta = solveLinear(A, v);
  return beta ? beta.map((b, j) => b / scale[j]) : null;
}

/**
 * Fit the USD relation on daily samples [{usd, i18, icoin}].
 * Returns the coefficients (for i18, icoin, constant) and the residual spread in %.
 * @returns {{coef: number[], sd: number, n: number}|null}
 */
export function usdRelationFit(samples) {
  const clean = samples.filter((s) => s.usd > 0 && s.i18 > 0 && s.icoin > 0);
  if (clean.length < 10) return null;
  const coef = olsFit(clean.map((s) => [s.i18, s.icoin, 1]), clean.map((s) => s.usd));
  if (!coef) return null;
  const devs = clean.map((s) => {
    const fair = coef[0] * s.i18 + coef[1] * s.icoin + coef[2];
    return ((s.usd - fair) / fair) * 100;
  });
  const mean = devs.reduce((a, b) => a + b, 0) / devs.length;
  const sd = Math.sqrt(devs.reduce((a, d) => a + (d - mean) ** 2, 0) / Math.max(devs.length - 3, 1));
  return { coef, sd, n: clean.length };
}

/** Fair USD rate implied by the relation for given implied rates. */
export function relationFair(rel, { i18, icoin }) {
  if (!rel || !(i18 > 0) || !(icoin > 0)) return null;
  return rel.coef[0] * i18 + rel.coef[1] * icoin + rel.coef[2];
}

/**
 * Signal per the user's rule: free-market USD above the relation → sell,
 * below → buy. `strong` marks deviations of at least one residual standard deviation.
 * @returns {{fair:number, devPct:number, z:number, signal:'sell'|'buy'|'none', strong:boolean}|null}
 */
export function relationSignal(rel, { usd, i18, icoin }) {
  const fair = relationFair(rel, { i18, icoin });
  if (!(fair > 0) || !(usd > 0)) return null;
  const devPct = ((usd - fair) / fair) * 100;
  const z = rel.sd > 0 ? devPct / rel.sd : 0;
  const signal = devPct > 0 ? 'sell' : devPct < 0 ? 'buy' : 'none';
  return { fair, devPct, z, signal, strong: Math.abs(z) >= 1 };
}

/**
 * Walk-forward check of the signal: at each day t (after minTrain days) fit on
 * data before t, take the signal at t, and count whether USD moved the signalled
 * way over the next `horizon` days. Flat moves are skipped.
 * @returns {{hits:number, total:number, rate:number|null}}
 */
export function relationBacktest(samples, horizon = 5, minTrain = 120) {
  let hits = 0, total = 0;
  for (let t = minTrain; t + horizon < samples.length; t++) {
    const rel = usdRelationFit(samples.slice(0, t));
    const s = rel && relationSignal(rel, samples[t]);
    if (!s || s.signal === 'none') continue;
    const move = samples[t + horizon].usd - samples[t].usd;
    if (move === 0) continue;
    total++;
    if ((s.signal === 'sell' && move < 0) || (s.signal === 'buy' && move > 0)) hits++;
  }
  return { hits, total, rate: total ? (hits / total) * 100 : null };
}

// --- Gold buy / sell (trade page) ---------------------------------------------
// Purity is per mille: 1000 = 24K (pure), 750 = 18K, 500 = 12K.
export const PURITY_MIN = 500;
export const PURITY_MAX = 1000;
export const BUY_WAGE_MAX_PCT = 30;   // seller's wage (اجرت) on purchase
export const SELL_FEE_MAX_PCT = 10;   // shop deduction on sale, 0-10 %

/** Karat equivalent of a per-mille purity (750 -> 18). */
export function karatOf(purity) {
  return (purity / 1000) * 24;
}

/**
 * Toman per gram of gold at the given purity.
 *   pricePerGram = (ounceUsd / OUNCE_GRAMS) * (purity / 1000) * usdToman
 * @param {number} ounceUsd  global gold price, USD per troy ounce
 * @param {number} usdToman  free-market USD rate, toman per dollar
 * @param {number} purity    per mille, 500..1000
 * @returns {number|null}
 */
export function tomanPerGram({ ounceUsd, usdToman, purity }) {
  if (!(ounceUsd > 0) || !(usdToman > 0)) return null;
  if (!(purity >= PURITY_MIN && purity <= PURITY_MAX)) return null;
  return (ounceUsd / OUNCE_GRAMS) * (purity / 1000) * usdToman;
}

/** Customer buys gold: base value plus the seller's wage (percent of the base value). */
export function buyTotal({ grams, perGram, wagePct }) {
  if (!(grams > 0) || !(perGram > 0) || !(wagePct >= 0 && wagePct <= BUY_WAGE_MAX_PCT)) return null;
  const base = grams * perGram;
  const wage = base * (wagePct / 100);
  return { base, wage, total: base + wage };
}

/** Customer sells gold: base value minus the shop deduction (percent of the base value). */
export function sellTotal({ grams, perGram, feePct }) {
  if (!(grams > 0) || !(perGram > 0) || !(feePct >= 0 && feePct <= SELL_FEE_MAX_PCT)) return null;
  const base = grams * perGram;
  const fee = base * (feePct / 100);
  return { base, fee, total: base - fee };
}
