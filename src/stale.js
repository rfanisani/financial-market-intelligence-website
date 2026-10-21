// Freshness rule for the market tiles (homepage strip and market pages).
//
// A tile is fresh only when its source sent a timestamped update less than
// FRESH_WITHIN_MS ago. Otherwise it is stale and shown in light purple. That covers
// weekends, a source that does not update, a source with no timestamp (daily rows),
// and a failed request.

export const FRESH_WITHIN_MS = 60_000;
const FUTURE_TOLERANCE_MS = 30_000;

/**
 * @param {number|null|undefined} sourceSec the source's own update time, in unix seconds
 * @param {number} nowMs current time in milliseconds
 * @param {number} maxAgeMs how old an update may be and still count as fresh
 * @returns {{fresh: boolean, reason: 'ok'|'no-time'|'future'|'old'}}
 */
export function freshness(sourceSec, nowMs, maxAgeMs = FRESH_WITHIN_MS) {
  if (!Number.isFinite(sourceSec) || sourceSec <= 0) return { fresh: false, reason: 'no-time' };
  const ageMs = nowMs - sourceSec * 1000;
  if (ageMs < -FUTURE_TOLERANCE_MS) return { fresh: false, reason: 'future' };
  if (ageMs > maxAgeMs) return { fresh: false, reason: 'old' };
  return { fresh: true, reason: 'ok' };
}
