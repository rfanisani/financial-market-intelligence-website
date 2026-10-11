// Mathematical and conversion utilities for Gold & Silver Market Analysis.
// Zero runtime dependencies. Used by both the static generator, client-side JS,
// and the automated test suite.

export const OUNCE_GRAMS = 31.1034768;
export const KILOGRAM_GRAMS = 1000;

export const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'AED', 'TOMAN', 'IRR', 'GBP'];
export const SUPPORTED_UNITS = ['oz', 'g', 'kg'];
export const SUPPORTED_RANGES = [
  '1d', '3d', '7d', '30d', '60d', '6m', '1y',
  '2y', '5y', '10y', '15y', '20y', '30y', 'all',
];

/**
 * Convert price per troy ounce to target weight unit.
 * @param {number} pricePerOz
 * @param {'oz'|'g'|'kg'} unit
 * @returns {number|null}
 */
export function convertWeight(pricePerOz, unit) {
  if (!Number.isFinite(pricePerOz) || pricePerOz <= 0) return null;
  if (unit === 'oz') return pricePerOz;
  if (unit === 'g') return pricePerOz / OUNCE_GRAMS;
  if (unit === 'kg') return (pricePerOz / OUNCE_GRAMS) * KILOGRAM_GRAMS;
  return null;
}

/**
 * Convert USD-denominated value into target currency using reference rates.
 * @param {number} valUsd
 * @param {string} currency
 * @param {Record<string, number>} rates
 * @returns {number|null}
 */
export function convertCurrency(valUsd, currency, rates = {}) {
  if (!Number.isFinite(valUsd) || valUsd <= 0) return null;
  const curr = String(currency).toUpperCase();
  if (curr === 'USD') return valUsd;
  const r = rates[curr];
  if (!Number.isFinite(r) || r <= 0) return null;
  return valUsd * r;
}

/**
 * Calculate Gold-to-Silver ratio: Gold price / Silver price per same unit.
 * Dimensionless, invariant to currency and weight unit.
 * @param {number} goldPrice
 * @param {number} silverPrice
 * @returns {number|null}
 */
export function goldSilverRatio(goldPrice, silverPrice) {
  if (!Number.isFinite(goldPrice) || goldPrice <= 0) return null;
  if (!Number.isFinite(silverPrice) || silverPrice <= 0) return null;
  return +(goldPrice / silverPrice).toFixed(4);
}

/**
 * Filter historical dataset by requested time range.
 * @param {{ daily?: { t0: number, dt: number, gold: number[], silver: number[], usdIrr?: number[] }, monthly?: Array<{ d: string, t: number, g: number, s: number }> }} dataset
 * @param {string} rangeKey
 * @returns {{ points: Array<{ date: string, timestamp: number, gold: number, silver: number, ratio: number, usdIrr?: number }>, note?: string }}
 */
export function filterTimeRange(dataset, rangeKey = '1y') {
  if (!dataset || typeof dataset !== 'object') return { points: [] };

  const daily = dataset.daily;
  const monthly = dataset.monthly || [];

  // Range definitions:
  // <= 1y uses daily series
  // > 1y uses monthly series back to 2000
  const dailyCountMap = {
    '1d': 1,
    '3d': 3,
    '7d': 7,
    '30d': 30,
    '60d': 60,
    '6m': 180,
    '1y': 365,
  };

  const monthlyCountMap = {
    '2y': 24,
    '5y': 60,
    '10y': 120,
    '15y': 180,
    '20y': 240,
    '30y': 360,
    'all': Infinity,
  };

  if (daily && dailyCountMap[rangeKey] !== undefined) {
    const count = Math.min(dailyCountMap[rangeKey], daily.gold.length);
    const startIdx = daily.gold.length - count;
    const points = [];
    for (let i = startIdx; i < daily.gold.length; i++) {
      const ts = daily.t0 + i * daily.dt;
      const dStr = new Date(ts * 1000).toISOString().split('T')[0];
      const g = daily.gold[i];
      const s = daily.silver[i];
      const ratio = goldSilverRatio(g, s);
      const row = {
        date: dStr,
        timestamp: ts,
        gold: g,
        silver: s,
        ratio: ratio ?? 0,
      };
      if (Array.isArray(daily.usdIrr) && Number.isFinite(daily.usdIrr[i])) {
        row.usdIrr = daily.usdIrr[i];
      }
      points.push(row);
    }
    return { points };
  }

  if (monthlyCountMap[rangeKey] !== undefined) {
    const limit = monthlyCountMap[rangeKey];
    const slice = limit === Infinity ? monthly : monthly.slice(-limit);
    const points = slice.map((m) => ({
      date: m.d,
      timestamp: m.t,
      gold: m.g,
      silver: m.s,
      ratio: goldSilverRatio(m.g, m.s) ?? 0,
    }));
    let note;
    if (rangeKey === '30y' && monthly.length < 360) {
      note = `COMEX historical series begins in September 2000 (${points.length} verified monthly observations available).`;
    }
    return { points, note };
  }

  return { points: [] };
}

/**
 * Compute key statistics over a sequence of numbers.
 * @param {number[]} values
 * @returns {{ min: number, max: number, avg: number, first: number, last: number, change: number, changePct: number }|null}
 */
export function computeSeriesStats(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const valid = values.filter((v) => Number.isFinite(v) && v > 0);
  if (valid.length === 0) return null;
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  const sum = valid.reduce((acc, v) => acc + v, 0);
  const avg = +(sum / valid.length).toFixed(2);
  const first = valid[0];
  const last = valid[valid.length - 1];
  const change = +(last - first).toFixed(2);
  const changePct = first > 0 ? +(((last - first) / first) * 100).toFixed(2) : 0;
  return { min, max, avg, first, last, change, changePct };
}
