// Live price providers — pure parsers for the browser (no DOM, no network, no eval).
// Each parser takes an already-downloaded response body and returns a plain
// { CODE: { v, c? } } object, or null/{} when the payload is not usable.
// Shared by the browser module (src/live.js) and the Node test suite, so the
// exact wire formats are verified by tests.

const pos = (x) => Number.isFinite(x) && x > 0;

/** gold-api.com/price/{XAU|XAG} -> { price, ... } */
export function parseGoldApiPrice(json, code) {
  const v = Number(json?.price);
  const ms = Date.parse(json?.updatedAt);
  if (!pos(v)) return {};
  return { [code]: Number.isFinite(ms) ? { v, t: Math.floor(ms / 1000) } : { v } };
}

/** frankfurter.dev/v1/latest?base=USD -> ECB rates (quote currency per 1 USD) */
export function parseFrankfurter(json) {
  const out = {};
  const r = json?.rates ?? {};
  if (pos(r.EUR)) out.EURUSD = { v: 1 / r.EUR };
  if (pos(r.GBP)) out.GBPUSD = { v: 1 / r.GBP };
  if (pos(r.JPY)) out.USDJPY = { v: r.JPY };
  return out;
}

/** tgju.org summary-table-data/{symbol}?length=1 -> one Iranian quote (rial -> toman) */
export function parseTgjuRow(json, code) {
  const row = json?.data?.[0];
  if (!Array.isArray(row)) return {};
  const rial = Number(String(row[0]).replace(/,/g, ''));
  const pct = Number(String(row[5] ?? '').replace(/<[^>]*>/g, '').replace('%', ''));
  if (!pos(rial)) return {};
  return { [code]: { v: rial / 10, c: Number.isFinite(pct) ? pct : undefined } };
}

const pctChange = (now, before) => (pos(before) ? ((now - before) / before) * 100 : undefined);
const shiftDay = (ymd, n) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * tgju.org summary-table-data/{symbol}?length=8 -> latest quote with its 1-day and
 * 1-week change. Rows are newest first: [close, open, high, low, change, pct%,
 * yyyy/mm/dd, jalali]. The week reference is the newest row on or before
 * (latest date - 7 days), which matches the TGJU "1 week" figure.
 * scale converts the quote (rial -> toman is 0.1; indices and ounces are 1).
 */
export function parseTgjuSeries(json, code, scale = 1) {
  const rows = Array.isArray(json?.data) ? json.data : [];
  const q = [];
  for (const r of rows) {
    const v = Number(String(r?.[0] ?? '').replace(/,/g, '')) * scale;
    const m = /^(\d{4})[/-](\d{2})[/-](\d{2})$/.exec(String(r?.[6] ?? '').trim());
    if (!pos(v) || !m) continue;
    const pct = Number(String(r[5] ?? '').replace(/<[^>]*>/g, '').replace(/[%,\s]/g, ''));
    q.push({ v, pct, d: `${m[1]}-${m[2]}-${m[3]}` });
  }
  if (!q.length) return {};
  const last = q[0];
  const ref = q.find((x) => x.d <= shiftDay(last.d, -7));
  const c = Number.isFinite(last.pct) ? last.pct : pctChange(last.v, q[1]?.v);
  return { [code]: { v: last.v, c, w: pctChange(last.v, ref?.v), d: last.d } };
}

/**
 * Yahoo Finance chart (range=1mo) -> last close, 1-day and 1-week change.
 * Used by the scheduled build only (Yahoo sends no CORS header).
 */
export function parseYahooChart(json, code) {
  const r = json?.chart?.result?.[0];
  const ts = r?.timestamp ?? [];
  const closes = r?.indicators?.quote?.[0]?.close ?? [];
  const pts = [];
  for (let i = 0; i < ts.length; i++) {
    if (pos(closes[i])) pts.push({ v: closes[i], d: new Date(ts[i] * 1000).toISOString().slice(0, 10) });
  }
  if (!pts.length) return {};
  const last = pts[pts.length - 1];
  const prev = pts[pts.length - 2];
  const ref = [...pts].reverse().find((p) => p.d <= shiftDay(last.d, -7));
  return { [code]: { v: last.v, c: pctChange(last.v, prev?.v), w: pctChange(last.v, ref?.v), d: last.d } };
}

/**
 * tgju summary-table-data/{symbol}?length=N -> [["yyyy-mm-dd", value], ...] ascending,
 * one point per date. Rows are newest first; the first row seen for a date wins.
 */
export function parseTgjuHistory(json, scale = 1) {
  const rows = Array.isArray(json?.data) ? json.data : [];
  const byDate = new Map();
  for (const r of rows) {
    const v = Number(String(r?.[0] ?? '').replace(/,/g, '')) * scale;
    const m = /^(\d{4})[/-](\d{2})[/-](\d{2})$/.exec(String(r?.[6] ?? '').trim());
    if (!pos(v) || !m) continue;
    const d = `${m[1]}-${m[2]}-${m[3]}`;
    if (!byDate.has(d)) byDate.set(d, v);
  }
  return [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** Yahoo chart -> [["yyyy-mm-dd", close], ...] ascending, null closes skipped. */
export function parseYahooSeries(json) {
  const r = json?.chart?.result?.[0];
  const ts = r?.timestamp ?? [];
  const closes = r?.indicators?.quote?.[0]?.close ?? [];
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    if (pos(closes[i])) out.push([new Date(ts[i] * 1000).toISOString().slice(0, 10), closes[i]]);
  }
  return out;
}

/**
 * Decode the body of a JavaScript single-quoted string literal (the part between
 * the quotes). Handles the escapes PHP/JS produce: \\ \' \" \/ \n \r \t \b \f \v \0
 * \xHH and \uHHHH. Returns null on a malformed escape.
 */
export function decodeJsString(body) {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') { out += ch; continue; }
    const n = body[++i];
    if (n === undefined) return null;
    if (n === 'u') {
      const hex = body.slice(i + 1, i + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
      out += String.fromCharCode(parseInt(hex, 16)); i += 4;
    } else if (n === 'x') {
      const hex = body.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
      out += String.fromCharCode(parseInt(hex, 16)); i += 2;
    } else {
      const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
      out += map[n] ?? n; // \\ \' \" \/ and any other escaped char stand for themselves
    }
  }
  return out;
}

/** Persian/Arabic-Indic digits -> ASCII, drop thousands separators. */
const toNumber = (v) => Number(String(v)
  .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
  .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
  .replace(/,/g, ''));

const NAVASAN_MAP = {
  usd: 'USDIRR', eur: 'EURIRR', gbp: 'GBPIRR',
  usd_xau: 'XAU', '18ayar': 'AU18', sekkeh: 'COIN', nim: 'COINH', rob: 'COINQ',
};

/** The HTML table (inside the JSONP payload) -> { CODE: { v, c } } */
export function parseNavasanHtml(html) {
  const out = {};
  if (typeof html !== 'string') return out;
  for (const [, id, row] of html.matchAll(/<tr id="([^"]+)">([\s\S]*?)<\/tr>/g)) {
    const code = NAVASAN_MAP[id];
    if (!code) continue;
    const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((t) => t[1].replace(/<[^>]*>/g, '').trim());
    const v = toNumber(tds[1] ?? '');
    const chg = toNumber(tds[2] ?? '');
    if (!pos(v)) continue;
    // Navasan reports an absolute change; convert to percent for display.
    out[code] = { v, c: Number.isFinite(chg) ? (chg / v) * 100 : undefined };
  }
  return out;
}

/**
 * navasan.tech/wp-navasan.php?... -> `navasanret('<JS string of JSON of HTML>');`
 * Parsed as data (regex + decodeJsString), never executed.
 */
export function parseNavasanJsonp(text) {
  const m = /^\s*navasanret\(\s*'((?:\\[\s\S]|[^'\\])*)'\s*\)\s*;?\s*$/.exec(String(text));
  if (!m) return {};
  const payload = decodeJsString(m[1]);
  if (payload === null) return {};
  let html;
  try {
    html = JSON.parse(payload);
    if (typeof html === 'string' && html.startsWith('"')) html = JSON.parse(html);
  } catch {
    return {};
  }
  return parseNavasanHtml(html);
}

// TGJU live feed through the Cloudflare proxy (proxy/tgju-proxy.worker.js):
// { current: { SYMBOL: { p: "2,683,200,000", dp, dt, ts: "YYYY-MM-DD HH:MM:SS" } } }.
// Rial symbols become toman. Tehran has no DST, so the feed time is +03:30.
// dt 'low' means the price fell, 'high' that it rose.
const TGJU_LIVE = {
  sekee: ['COIN', 0.1], nim: ['COINH', 0.1], rob: ['COINQ', 0.1], geram18: ['AU18', 0.1],
  price_dollar_rl: ['USDIRR', 0.1], oil_brent: ['BRENT', 1], bourse: ['TEDPIX', 1],
};
export function parseTgjuLive(json) {
  const out = {};
  const cur = json?.current ?? {};
  for (const [sym, [code, scale]] of Object.entries(TGJU_LIVE)) {
    const r = cur[sym];
    const p = Number(String(r?.p ?? '').replace(/,/g, ''));
    if (!pos(p)) continue;
    const u = { v: Number((p * scale).toFixed(4)) };
    const t = Date.parse(`${String(r.ts ?? '').replace(' ', 'T')}+03:30`);
    if (Number.isFinite(t)) u.t = Math.floor(t / 1000);
    const dp = Number(r.dp);
    if (Number.isFinite(dp)) {
      const sign = r.dt === 'low' ? -1 : r.dt === 'high' ? 1 : 0;
      u.c = sign * Math.abs(dp);
    }
    out[code] = u;
  }
  return out;
}
