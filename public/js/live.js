// Live prices, fetched in the visitor's browser.
//
// When it runs
//   - on every page load (after first paint, never blocks rendering)
//   - when the visitor presses the footer "refresh" button (with a short cooldown)
//
// How it stays fast
//   - Progressive: each source is applied as soon as it arrives. Gold (gold-api,
//     one tiny request) usually shows in well under a second, before the slower
//     sources finish.
//   - Light payloads: TGJU is requested with ?length=1 (one row, ~250 bytes). The
//     old ?row=1 parameter is ignored by the API and returned the full history.
//   - Bounded: every source has its own timeout. A slow or blocked source never
//     delays the others.
//   - One round at a time: while a round is running, further triggers are ignored.
//   - Cooldown: after a manual refresh, the button is ignored for COOLDOWN_MS.
//
// Events (document-level, consumed by refresh.js)
//   market:start  - a round began
//   market:live   - detail {t, a, ok, total, final}; a is the merged value set so far
//   market:error  - no source returned usable data
//
// WTI and Nasdaq have no CORS-enabled source; the scheduled build refreshes them.
// Brent, TEDPIX and the gold ounce change % come from TGJU (CORS enabled).
import { parseGoldApiPrice, parseFrankfurter, parseTgjuSeries, parseNavasanJsonp, parseTgjuLive } from './live-parse.js';

const COOLDOWN_MS = 3000;
// Later entries override earlier ones for the same code (same order as the scheduled pipeline).
// Later sources win for the same field. tgju-live (intraday, with time) is last.
const PRIORITY = ['navasan', 'frankfurter', 'gold-api', 'tgju', 'tgju-live'];
const TIMEOUT_MS = { 'gold-api': 10000, frankfurter: 5000, tgju: 6000, navasan: 6000, 'tgju-live': 6000 };
// Every source gets up to ATTEMPTS tries (each with its own TIMEOUT_MS). A try that
// returns nothing, or throws, counts as a failure.
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 700;
// TGJU symbol per code: [symbol, scale (rial -> toman = 0.1), pctOnly].
// pctOnly: only the change % is taken (gold price comes from gold-api).
const TGJU_SERIES = {
  USDIRR: ['price_dollar_rl', 0.1], EURIRR: ['price_eur', 0.1], GBPIRR: ['price_gbp', 0.1],
  AU18: ['geram18', 0.1], AU24: ['geram24', 0.1], COIN: ['sekee', 0.1], COINH: ['nim', 0.1], COINQ: ['rob', 0.1],
  BRENT: ['oil_brent', 1], TEDPIX: ['bourse', 1], XAU: ['ons', 1, true],
};
const GOLD = 'https://api.gold-api.com/price/';
const NAVASAN = 'https://www.navasan.tech/wp-navasan.php?usd&eur&gbp&usd_xau&18ayar&sekkeh&nim&rob';
const TGJU = 'https://api.tgju.org/v1/market/indicator/summary-table-data/';
// Cloudflare Worker proxy for TGJU's live feed (see proxy/tgju-proxy.worker.js).
const TGJU_LIVE_URL = 'https://tgju-proxy.rfanisani.workers.dev/';
const FRANKFURTER = 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR,GBP,JPY';

const signalFor = (ms) => AbortSignal.timeout(ms);

async function getText(url, signal) {
  const res = await fetch(url, { cache: 'no-store', signal });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}
const getJson = async (url, signal) => JSON.parse(await getText(url, signal));

// Run sub-requests in parallel; keep whatever succeeded.
async function settledMerge(tasks) {
  const out = {};
  for (const r of await Promise.allSettled(tasks)) {
    if (r.status === 'fulfilled') Object.assign(out, r.value);
  }
  return out;
}

// Runs fn until it returns at least one value, up to `attempts` tries. If the last try
// throws, that error is rethrown; an empty result is returned as {}.
async function retryUntil(attempts, delayMs, fn) {
  let lastErr = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      const out = await fn();
      if (Object.keys(out).length > 0) return out;
      lastErr = null;
    } catch (err) {
      lastErr = err;
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, delayMs));
  }
  if (lastErr) throw lastErr;
  return {};
}

const SOURCES = {
  'tgju-live': (ms) => getJson(TGJU_LIVE_URL, signalFor(ms)).then(parseTgjuLive),
  navasan: (ms) => getText(NAVASAN, signalFor(ms)).then(parseNavasanJsonp),
  frankfurter: (ms) => getJson(FRANKFURTER, signalFor(ms)).then(parseFrankfurter),
  'gold-api': (ms) => settledMerge(['XAU', 'XAG'].map((sym) =>
    getJson(`${GOLD}${sym}`, signalFor(ms)).then((j) => parseGoldApiPrice(j, sym)))),
  // length=8: the latest quote plus enough rows for the 1-week change (~2 KB each).
  tgju: (ms) => settledMerge(Object.entries(TGJU_SERIES).map(([code, [sym, scale, pctOnly]]) =>
    getJson(`${TGJU}${sym}?length=8`, signalFor(ms)).then((j) => {
      const r = parseTgjuSeries(j, code, scale);
      if (pctOnly && r[code]) delete r[code].v;
      return r;
    }))),
};

// Tag each value with its provider so the page shows the right source name.
const tag = (src, values) => Object.fromEntries(Object.entries(values).map(([k, u]) => [k, { ...u, s: src }]));

// Merge what has arrived so far. Each field comes from the highest-priority source
// that supplied it, so a source that only has a change % does not hide the price.
// TGJU's summary table gives only daily rows for these coins. When navasan has a current
// price for one of them, that price is kept and the daily TGJU row is skipped.
const NAVASAN_OVER_DAILY = new Set(['COIN', 'COINH', 'COINQ']);

function merged(bySource) {
  const acc = {};
  for (const name of PRIORITY) {
    const vals = bySource[name];
    if (!vals) continue;
    for (const [code, u] of Object.entries(vals)) {
      const a = (acc[code] ??= {});
      if (name === 'tgju' && NAVASAN_OVER_DAILY.has(code) && a.s === 'navasan') continue;
      // The source's own update time travels with the price it belongs to.
      if (Number.isFinite(u.v)) { a.v = u.v; a.s = name; if (Number.isFinite(u.t)) a.t = u.t; else delete a.t; }
      if (Number.isFinite(u.c)) a.c = u.c;
      if (Number.isFinite(u.w)) a.w = u.w;
      if (u.d) a.d = u.d;
    }
  }
  return acc;
}

let inFlight = null;     // promise of the running round
let lastManualEnd = 0;   // for the button cooldown

function emit(detail) {
  document.dispatchEvent(new CustomEvent('market:live', { detail }));
}

function runRound() {
  if (inFlight) return inFlight;
  document.dispatchEvent(new CustomEvent('market:start'));
  const bySource = {};
  inFlight = (async () => {
    const jobs = Object.entries(SOURCES).map(([name, fetchSource]) =>
      retryUntil(ATTEMPTS, RETRY_DELAY_MS, () => fetchSource(TIMEOUT_MS[name])).then(
        (vals) => {
          const tagged = tag(name, vals);
          if (Object.keys(tagged).length === 0) return;
          bySource[name] = tagged;
          emit({ t: Math.floor(Date.now() / 1000), a: merged(bySource),
            ok: Object.keys(bySource).length, total: PRIORITY.length, final: false });
        },
        (err) => console.info(`[live] ${name} unavailable: ${err?.message || err}`),
      ));
    await Promise.all(jobs);
    if (Object.keys(bySource).length === 0) {
      document.dispatchEvent(new CustomEvent('market:error'));
    } else {
      emit({ t: Math.floor(Date.now() / 1000), a: merged(bySource),
        ok: Object.keys(bySource).length, total: PRIORITY.length, final: true });
    }
  })().finally(() => { inFlight = null; });
  return inFlight;
}

// First round: after paint, without blocking anything.
const start = () => (window.requestIdleCallback ? requestIdleCallback(runRound, { timeout: 1000 }) : setTimeout(runRound, 0));
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();

// Footer button: a new round, unless one is running or we are in the cooldown.
document.addEventListener('market:refresh', () => {
  if (inFlight || Date.now() - lastManualEnd < COOLDOWN_MS) return;
  runRound().finally(() => { lastManualEnd = Date.now(); });
});
