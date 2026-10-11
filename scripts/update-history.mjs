// Dedicated historical observation maintainer. Zero runtime dependencies.
// Fetches genuine historical daily closing quotes from official sources
// (TGJU summary table for Iranian assets, Yahoo Finance chart for global commodities),
// and aligns them to continuous daily calendars (7d, 30d, 1y).
// Idempotent: multiple runs on the same calendar day update today's observation
// without appending duplicate dates.
//
// Run: node scripts/update-history.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { validateHistory } from '../src/validate.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT = 15000;

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT), headers: { 'user-agent': 'market-site/1.0' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

export async function updateHistory(now = Math.floor(Date.now() / 1000)) {
  const DT = 86400;
  const todayMidnight = Math.floor(now / DT) * DT;

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
    console.log(`[history] TGJU history loaded: ${mapUsd.size} USD points, ${mapAu18.size} AU18 points`);
  } catch (err) {
    console.warn(`[history] TGJU history fetch failed: ${err.message}`);
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
        console.log(`[history] Yahoo history loaded for ${code}: ${map.size} points`);
      } catch (err) {
        console.warn(`[history] Yahoo history fetch failed for ${code}: ${err.message}`);
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
  const activeAssets = {};
  for (const [k, s] of Object.entries(seriesMap)) {
    if (Array.isArray(s) && s.length === 365 && s.every(v => typeof v === 'number' && Number.isFinite(v) && v > 0)) {
      activeAssets[k] = s;
    } else if (prevH1y?.a?.[k]?.length === 365) {
      activeAssets[k] = prevH1y.a[k];
    }
  }

  if (Object.keys(activeAssets).length === 0) {
    console.warn('[history] no complete historical series available; keeping existing files untouched');
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
    console.error('[history] validation failed:', [...v7.errors, ...v30.errors, ...v1y.errors].join('; '));
    return;
  }

  writeFileSync(H1Y_PATH, JSON.stringify(h1y) + '\n');
  writeFileSync(H30_PATH, JSON.stringify(h30) + '\n');
  writeFileSync(H7_PATH, JSON.stringify(h7) + '\n');
  console.log(`[history] wrote real observed historical data for ${Object.keys(activeAssets).length} assets (7d, 30d, 1y)`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  updateHistory().catch((err) => {
    console.error('[history] failed:', err);
    process.exit(1);
  });
}
