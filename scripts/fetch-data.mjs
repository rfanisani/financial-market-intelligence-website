// Data pipeline: Provider -> Normalizer -> Validator -> data/current.json
// Runs at build time (GitHub Actions), never in the browser.
// Zero dependencies. If a provider fails, the last known good value for that
// asset is preserved (never deleted).
//
// Run: node scripts/fetch-data.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import path from 'node:path';
import { validateCurrent, validateHistory } from '../src/validate.js';
import { parseTgjuSeries, parseTgjuHistory, parseYahooChart, parseYahooSeries } from '../src/live-parse.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CURRENT = path.join(root, 'data/current.json');
const TICKER = path.join(root, 'data/ticker.json');
const TIMEOUT = 15000;

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT), headers: { 'user-agent': 'market-site/1.0' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

// --- Providers: each returns { CODE: value } or throws ----------------------

async function providerGoldApi() {
  // Free, no key. Spot prices in USD.
  const out = {};
  for (const [code, sym] of [['XAU', 'XAU'], ['XAG', 'XAG']]) {
    const j = await getJson(`https://api.gold-api.com/price/${sym}`);
    const v = Number(j.price);
    if (Number.isFinite(v) && v > 0) out[code] = v;
  }
  return out;
}

async function providerFrankfurter() {
  // ECB reference rates, no key. Returns quote currencies per 1 USD.
  const j = await getJson('https://api.frankfurter.app/latest?from=USD&to=EUR,GBP,JPY');
  const out = {};
  if (Number.isFinite(j.rates?.EUR)) out.EURUSD = 1 / j.rates.EUR;
  if (Number.isFinite(j.rates?.GBP)) out.GBPUSD = 1 / j.rates.GBP;
  if (Number.isFinite(j.rates?.JPY)) out.USDJPY = j.rates.JPY;
  return out;
}

async function providerStooq() {
  // Free CSV quotes for commodity futures (continuous contracts).
  const res = await fetch('https://stooq.com/q/l/?s=cb.f+cl.f&f=sd2t2ohlcv&h&e=csv', { signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new Error(`stooq ${res.status}`);
  const csv = await res.text();
  const out = {};
  for (const line of csv.trim().split('\n').slice(1)) {
    const [sym, , , , , , close] = line.split(',');
    const v = Number(close);
    if (!Number.isFinite(v) || v <= 0) continue;
    if (sym === 'CB.F') out.BRENT = v;
    if (sym === 'CL.F') out.WTI = v;
  }
  return out;
}

async function providerYahoo() {
  // Stooq's CSV endpoint is gone; Yahoo Finance chart API covers Brent/WTI.
  const out = {};
  for (const [code, sym] of [['BRENT', 'BZ=F'], ['WTI', 'CL=F']]) {
    const j = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`);
    const m = j.chart?.result?.[0]?.meta;
    const v = m?.regularMarketPrice;
    if (Number.isFinite(v) && v > 0) {
      out[code] = { v, c: Number.isFinite(m.regularMarketChangePercent) ? m.regularMarketChangePercent : undefined };
    }
  }
  return out;
}

export async function providerNavasan() {
  // Secondary Iranian source (navasan.tech widget). The endpoint returns a
  // JSONP payload wrapping a doubly-escaped HTML table; evaluate it in a bare
  // vm sandbox so the JS string escapes are unwound exactly as a browser would.
  const url = 'https://www.navasan.tech/wp-navasan.php?usd&eur&gbp&usd_xau&18ayar&sekkeh&nim&rob';
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT), headers: { 'user-agent': 'market-site/1.0' } });
  if (!res.ok) throw new Error(`${res.status} navasan`);
  const jsonp = await res.text();
  let payload;
  vm.runInNewContext(jsonp, { navasanret: (x) => { payload = x; } }, { timeout: 1000 });
  let html = JSON.parse(payload);
  if (html.startsWith('"')) html = JSON.parse(html);
  // Persian/Arabic-Indic digits -> ASCII, strip separators.
  const num = (v) => Number(String(v)
    .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/,/g, ''));
  const map = {
    usd: 'USDIRR', eur: 'EURIRR', gbp: 'GBPIRR',
    usd_xau: 'XAU', '18ayar': 'AU18', sekkeh: 'COIN', nim: 'COINH', rob: 'COINQ',
  };
  const out = {};
  for (const [, id, row] of html.matchAll(/<tr id="([^"]+)">([\s\S]*?)<\/tr>/g)) {
    const code = map[id];
    if (!code) continue;
    const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((t) => t[1].replace(/<[^>]*>/g, '').trim());
    const v = num(tds[1] ?? '');
    const chg = num(tds[2] ?? '');
    if (!Number.isFinite(v) || v <= 0) continue;
    // Navasan reports an absolute change; convert to percent for storage.
    out[code] = { v, c: Number.isFinite(chg) && v > 0 ? (chg / v) * 100 : undefined };
  }
  return out;
}

async function providerTgju() {
  // Iranian free-market rates (tgju.org summary-table-data endpoint, rial values).
  // Row format: [close, open, high, low, changeHTML, percentHTML, date, jalaliDate]
  const symbols = {
    USDIRR: 'price_dollar_rl', EURIRR: 'price_eur', GBPIRR: 'price_gbp',
    AU18: 'geram18', AU24: 'geram24', COIN: 'sekee', COINH: 'nim', COINQ: 'rob',
  };
  const out = {};
  for (const [code, sym] of Object.entries(symbols)) {
    try {
      const j = await getJson(`https://api.tgju.org/v1/market/indicator/summary-table-data/${sym}?length=1`);
      const row = j.data?.[0];
      if (!Array.isArray(row)) continue;
      const rial = Number(String(row[0]).replace(/,/g, ''));
      const pct = Number(String(row[5] ?? '').replace(/<[^>]*>/g, '').replace('%', ''));
      if (Number.isFinite(rial) && rial > 0) {
        out[code] = { v: rial / 10, c: Number.isFinite(pct) ? pct : undefined }; // rial -> toman
      }
    } catch { /* single asset failure keeps last good value */ }
  }
  return out;
}

// --- Market strip and market pages -----------------------------------------
// One request per market feeds both: the latest quote with its 1-day and
// 1-week change (homepage strip) and about one year of daily history (market
// pages). Symbols live in src/markets.json, shared with the build and the browser.
// For XAU only the change % is taken from TGJU (pctOnly); the price stays on gold-api.
const MARKETS = JSON.parse(readFileSync(path.join(root, 'src/markets.json'), 'utf8'));
const MARKET_HISTORY = path.join(root, 'data/market-history.json');
const HISTORY_DAYS = 370;

const cutoffDate = (days) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

async function getYahoo(sym) {
  for (const host of ['query1', 'query2']) {
    try {
      return await getJson(`https://${host}.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1y`);
    } catch (err) {
      console.warn(`[fetch] Yahoo ${sym} (${host}) failed: ${err.message}`);
    }
  }
  throw new Error(`Yahoo ${sym} unavailable`);
}

async function fetchTicker(prev, prevHistory) {
  const items = {};
  const markets = { ...(prevHistory?.markets ?? {}) };
  const cutoff = cutoffDate(HISTORY_DAYS);
  await Promise.all(MARKETS.map(async (m) => {
    try {
      let quote, hist;
      if (m.tgju) {
        const j = await getJson(`https://api.tgju.org/v1/market/indicator/summary-table-data/${m.tgju}?length=400`);
        quote = parseTgjuSeries(j, m.code, m.scale)[m.code];
        hist = parseTgjuHistory(j, m.scale);
      } else {
        const j = await getYahoo(m.yahoo);
        quote = parseYahooChart(j, m.code)[m.code];
        hist = parseYahooSeries(j);
      }
      if (quote) {
        items[m.code] = { ...quote, ...(m.pctOnly ? { v: undefined } : {}), s: m.tgju ? 'tgju' : 'yahoo' };
      }
      const kept = hist.filter(([d]) => d >= cutoff);
      if (kept.length > 1) markets[m.slug] = kept;
    } catch (err) {
      console.warn(`[fetch] market ${m.slug} failed: ${err.message}`);
    }
  }));

  // Keep the last good value for anything that failed this time.
  for (const m of MARKETS) {
    items[m.code] = items[m.code] ?? prev?.items?.[m.code] ?? null;
  }
  const t = Math.floor(Date.now() / 1000);
  return { ticker: { t, items }, history: { t, markets } };
}

// --- Merge + validate -------------------------------------------------------

// The pipeline runs only when this file is executed directly
// (node scripts/fetch-data.mjs); the test suite imports the providers
// above without triggering any network or file writes.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const prev = JSON.parse(readFileSync(CURRENT, 'utf8'));
  // Later providers override earlier ones, so the dedicated sources win and
  // Navasan (secondary) only survives where no primary source covers a code.
  const providers = [
    ['navasan', providerNavasan],
    ['gold-api', providerGoldApi],
    ['frankfurter', providerFrankfurter],
    ['yahoo', providerYahoo],
    ['tgju', providerTgju],
  ];

  // Concurrent fetch for fast updates (Promise.allSettled), preserving
  // override priority by applying results in strict provider order.
  const results = await Promise.allSettled(
    providers.map(async ([name, fn]) => {
      const values = await fn();
      return { name, values };
    })
  );

  const updates = {}; // code -> {v, s, c?}
  const perProvider = {}; // name -> {code: v} for cross-checking
  let failures = 0;
  for (let i = 0; i < providers.length; i++) {
    const [name] = providers[i];
    const r = results[i];
    if (r.status === 'fulfilled') {
      const values = r.value.values;
      perProvider[name] = {};
      for (const [code, u0] of Object.entries(values)) {
        const u = typeof u0 === 'object' && u0 !== null ? u0 : { v: u0 };
        updates[code] = { v: u.v, s: name, c: u.c };
        perProvider[name][code] = u.v;
      }
      console.log(`[fetch] ${name}: ${Object.keys(values).length} assets`);
    } else {
      failures++;
      console.warn(`[fetch] ${name} failed: ${r.reason?.message || r.reason} (keeping last known good values)`);
    }
  }

  // Cross-check: warn when the primary (TGJU) and secondary (Navasan) disagree
  // widely on an Iranian asset — usually one of them is stale.
  for (const code of Object.keys(perProvider.tgju ?? {})) {
    const a = perProvider.tgju[code];
    const b = perProvider.navasan?.[code];
    if (Number.isFinite(a) && Number.isFinite(b) && b > 0) {
      const gap = Math.abs(a - b) / b * 100;
      if (gap > 5) console.warn(`[fetch] cross-check ${code}: tgju=${a} vs navasan=${b} (${gap.toFixed(1)}% apart)`);
    }
  }

  if (Object.keys(updates).length === 0) {
    console.warn('[fetch] all providers failed - keeping previous data untouched');
    process.exit(0);
  }

  const now = Math.floor(Date.now() / 1000);
  const next = { t: now, s: { ...prev.s }, a: {} };
  for (const code of Object.keys(prev.a)) {
    const u = updates[code];
    const old = prev.a[code];
    const v = u ? u.v : old.v;
    // Change % vs previous stored value when we have a fresh quote. If the
    // previous value was seed placeholder data, prefer the provider's own
    // daily change instead of a meaningless vs-seed delta.
    const seeded = prev.s[code] === 'seed';
    let c;
    if (u) {
      if (seeded && Number.isFinite(u.c)) c = u.c;
      else if (Number.isFinite(old.v) && old.v > 0) c = ((v - old.v) / old.v) * 100;
      else c = old.c;
    } else c = old.c;
    next.a[code] = { v: round(code, v), c: +c.toFixed(2) };
    next.s[code] = u ? u.s : prev.s[code];
  }

  const check = validateCurrent(next);
  if (!check.ok) {
    console.error('[fetch] validation failed, NOT writing:', check.errors.join('; '));
    process.exit(1);
  }

  writeFileSync(CURRENT, JSON.stringify(next));
  console.log(`[fetch] wrote ${Object.keys(updates).length} updated / ${Object.keys(next.a).length} total assets at ${now}`);
  if (failures > 0) console.warn(`[fetch] ${failures} provider(s) failed; mixed sources recorded per asset`);

  try {
    let prevTicker = null, prevHistory = null;
    try { prevTicker = JSON.parse(readFileSync(TICKER, 'utf8')); } catch {}
    try { prevHistory = JSON.parse(readFileSync(MARKET_HISTORY, 'utf8')); } catch {}
    const { ticker, history } = await fetchTicker(prevTicker, prevHistory);
    const got = Object.values(ticker.items).filter(Boolean).length;
    const nSeries = Object.keys(history.markets).length;
    writeFileSync(TICKER, JSON.stringify(ticker));
    writeFileSync(MARKET_HISTORY, JSON.stringify(history));
    console.log(`[fetch] wrote market strip: ${got}/${MARKETS.length} quotes, ${nSeries}/${MARKETS.length} histories`);
  } catch (e) {
    console.warn(`[fetch] market strip failed: ${e.message} (keeping last-known-good strip)`);
  }

  try {
    await fetchHistoricalData(now);
  } catch (e) {
    console.warn(`[fetch] historical data fetch failed: ${e.message} (keeping last-known-good history)`);
  }
}

function round(code, v) {
  const d = code === 'EURUSD' || code === 'GBPUSD' ? 4 : v >= 1000 ? 0 : 2;
  return +v.toFixed(d);
}

async function fetchHistoricalData(now) {
  const DT = 86400;
  const todayMidnight = Math.floor(now / DT) * DT;

  // Read existing history as fallback
  const H7_PATH = path.join(root, 'data/history-7d.json');
  const H30_PATH = path.join(root, 'data/history-30d.json');
  const H1Y_PATH = path.join(root, 'data/history-1y.json');

  let prevH1y = null;
  try {
    prevH1y = JSON.parse(readFileSync(H1Y_PATH, 'utf8'));
  } catch {}

  const dates1y = [];
  for (let i = 364; i >= 0; i--) {
    const ts = todayMidnight - i * DT;
    const dStr = new Date(ts * 1000).toISOString().split('T')[0];
    dates1y.push({ ts, dStr });
  }

  // Fetch TGJU daily history (summary table data: row=380 covers full year)
  let mapUsd = null;
  let mapAu18 = null;
  try {
    const [tgjuUsd, tgjuAu18] = await Promise.all([
      getJson('https://api.tgju.org/v1/market/indicator/summary-table-data/price_dollar_rl?row=380'),
      getJson('https://api.tgju.org/v1/market/indicator/summary-table-data/geram18?row=380'),
    ]);
    const parseTgju = (rows) => {
      const map = new Map();
      for (const r of rows || []) {
        if (!Array.isArray(r) || !r[0] || !r[6]) continue;
        const num = Number(String(r[0]).replace(/,/g, ''));
        if (Number.isFinite(num) && num > 0) {
          const dStr = r[6].replace(/\//g, '-');
          map.set(dStr, num / 10); // convert Rials to Tomans
        }
      }
      return map;
    };
    mapUsd = parseTgju(tgjuUsd.data);
    mapAu18 = parseTgju(tgjuAu18.data);
    console.log(`[fetch] TGJU history loaded: ${mapUsd.size} USD points, ${mapAu18.size} AU18 points`);
  } catch (err) {
    console.warn(`[fetch] TGJU history fetch failed: ${err.message}`);
  }

  // Fetch Yahoo daily history for commodities (1y range)
  const ySymbols = [
    ['XAU', 'GC=F'],
    ['XAG', 'SI=F'],
    ['BRENT', 'BZ=F'],
    ['WTI', 'CL=F'],
  ];
  const yMaps = {};
  await Promise.all(
    ySymbols.map(async ([code, sym]) => {
      try {
        const yJson = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1y`);
        const res = yJson.chart?.result?.[0];
        const ts = res?.timestamp || [];
        const closes = res?.indicators?.quote?.[0]?.close || [];
        const map = new Map();
        for (let i = 0; i < ts.length; i++) {
          const v = closes[i];
          if (Number.isFinite(v) && v > 0) {
            const d = new Date(ts[i] * 1000).toISOString().split('T')[0];
            map.set(d, +v.toFixed(2));
          }
        }
        yMaps[code] = map;
        console.log(`[fetch] Yahoo history loaded for ${code}: ${map.size} points`);
      } catch (err) {
        console.warn(`[fetch] Yahoo history fetch failed for ${code}: ${err.message}`);
      }
    })
  );

  function buildAligned(map, dates, roundFn, fallbackSeries) {
    if (!map || map.size === 0) {
      if (fallbackSeries && fallbackSeries.length === dates.length) return fallbackSeries;
      return null;
    }
    const series = [];
    let lastVal = null;
    for (const [d, v] of map.entries()) {
      if (d <= dates[0].dStr) {
        if (!lastVal || d > lastVal.d) lastVal = { d, v };
      }
    }
    for (const { dStr } of dates) {
      if (map.has(dStr)) {
        lastVal = { d: dStr, v: map.get(dStr) };
      }
      series.push(lastVal ? roundFn(lastVal.v) : null);
    }
    return series;
  }

  const sUsd = buildAligned(mapUsd, dates1y, (v) => Math.round(v), prevH1y?.a?.USDIRR);
  const sAu18 = buildAligned(mapAu18, dates1y, (v) => Math.round(v), prevH1y?.a?.AU18);
  const sXau = buildAligned(yMaps.XAU, dates1y, (v) => +v.toFixed(2), prevH1y?.a?.XAU);
  const sXag = buildAligned(yMaps.XAG, dates1y, (v) => +v.toFixed(2), prevH1y?.a?.XAG);
  const sBrent = buildAligned(yMaps.BRENT, dates1y, (v) => +v.toFixed(2), prevH1y?.a?.BRENT);
  const sWti = buildAligned(yMaps.WTI, dates1y, (v) => +v.toFixed(2), prevH1y?.a?.WTI);

  const seriesMap = { XAU: sXau, XAG: sXag, BRENT: sBrent, WTI: sWti, USDIRR: sUsd, AU18: sAu18 };
  // Only update assets that have valid series
  const activeAssets = {};
  for (const [k, s] of Object.entries(seriesMap)) {
    if (Array.isArray(s) && s.length === 365 && s.every(v => typeof v === 'number' && Number.isFinite(v) && v > 0)) {
      activeAssets[k] = s;
    } else if (prevH1y?.a?.[k]?.length === 365) {
      activeAssets[k] = prevH1y.a[k];
    }
  }

  if (Object.keys(activeAssets).length === 0) {
    console.warn('[fetch] no complete historical series available; keeping existing files untouched');
    return;
  }

  const h1y = {
    t0: dates1y[0].ts,
    dt: DT,
    a: activeAssets,
  };

  const h30Assets = {};
  const h7Assets = {};
  for (const [k, s] of Object.entries(activeAssets)) {
    h30Assets[k] = s.slice(-30);
    h7Assets[k] = s.slice(-7);
  }

  const h30 = {
    t0: dates1y.slice(-30)[0].ts,
    dt: DT,
    a: h30Assets,
  };

  const h7 = {
    t0: dates1y.slice(-7)[0].ts,
    dt: DT,
    a: h7Assets,
  };

  const v1y = validateHistory(h1y);
  const v30 = validateHistory(h30);
  const v7 = validateHistory(h7);

  if (!v7.ok || !v30.ok || !v1y.ok) {
    console.error('[fetch] history validation failed:', [...v7.errors, ...v30.errors, ...v1y.errors].join('; '));
    return;
  }

  writeFileSync(H1Y_PATH, JSON.stringify(h1y) + '\n');
  writeFileSync(H30_PATH, JSON.stringify(h30) + '\n');
  writeFileSync(H7_PATH, JSON.stringify(h7) + '\n');
  console.log(`[fetch] wrote real observed historical data for ${Object.keys(activeAssets).length} assets (7d, 30d, 1y)`);
}
