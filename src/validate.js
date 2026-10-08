// Data validation shared by the fetch pipeline, the build and the tests.

export const KNOWN_SOURCES = new Set([
  'seed', 'gold-api', 'frankfurter', 'stooq', 'tgju', 'manual',
]);

/**
 * Validate a current.json payload.
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateCurrent(data, { maxAgeSec = 3 * 86400, now = Date.now() / 1000 } = {}) {
  const errors = [];
  if (!data || typeof data !== 'object') return { ok: false, errors: ['payload is not an object'] };
  if (!Number.isFinite(data.t)) errors.push('missing timestamp t');
  else if (now - data.t > maxAgeSec) errors.push(`stale data: age ${(now - data.t) / 3600 | 0}h > ${maxAgeSec / 3600 | 0}h`);

  if (!data.a || typeof data.a !== 'object') {
    errors.push('missing asset map a');
    return { ok: errors.length === 0, errors };
  }
  // Source is either a compact top-level map ({s:{XAU:'src'}}) or per-row.
  for (const [code, row] of Object.entries(data.a)) {
    if (!Number.isFinite(row.v) || row.v <= 0) errors.push(`${code}: invalid value ${row.v}`);
    if (!Number.isFinite(row.c)) errors.push(`${code}: invalid change ${row.c}`);
    const src = row.s ?? data.s?.[code];
    if (!KNOWN_SOURCES.has(src)) errors.push(`${code}: unknown source ${src}`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Validate a history file: {t0, dt, a:{CODE:[...]}}.
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateHistory(data, { maxPoints = 400 } = {}) {
  const errors = [];
  if (!data || typeof data !== 'object') return { ok: false, errors: ['payload is not an object'] };
  if (!Number.isFinite(data.t0)) errors.push('missing t0');
  if (!Number.isFinite(data.dt) || data.dt <= 0) errors.push('invalid dt');
  if (!data.a || typeof data.a !== 'object') {
    errors.push('missing asset map a');
    return { ok: errors.length === 0, errors };
  }
  for (const [code, series] of Object.entries(data.a)) {
    if (!Array.isArray(series) || series.length === 0) {
      errors.push(`${code}: empty series`);
      continue;
    }
    if (series.length > maxPoints) errors.push(`${code}: too many points (${series.length})`);
    if (!series.every((v) => Number.isFinite(v) && v > 0)) errors.push(`${code}: invalid values`);
  }
  return { ok: errors.length === 0, errors };
}
