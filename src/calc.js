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
