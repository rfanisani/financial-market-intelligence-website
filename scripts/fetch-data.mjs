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
import { validateCurrent } from '../src/validate.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CURRENT = path.join(root, 'data/current.json');
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
      const j = await getJson(`https://api.tgju.org/v1/market/indicator/summary-table-data/${sym}?row=1`);
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

  const updates = {}; // code -> {v, s, c?}
  const perProvider = {}; // name -> {code: v} for cross-checking
  let failures = 0;
  for (const [name, fn] of providers) {
    try {
      const values = await fn();
      perProvider[name] = {};
      for (const [code, u0] of Object.entries(values)) {
        const u = typeof u0 === 'object' && u0 !== null ? u0 : { v: u0 };
        updates[code] = { v: u.v, s: name, c: u.c };
        perProvider[name][code] = u.v;
      }
      console.log(`[fetch] ${name}: ${Object.keys(values).length} assets`);
    } catch (e) {
      failures++;
      console.warn(`[fetch] ${name} failed: ${e.message} (keeping last known good values)`);
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
}

function round(code, v) {
  const d = code === 'EURUSD' || code === 'GBPUSD' ? 4 : v >= 1000 ? 0 : 2;
  return +v.toFixed(d);
}
