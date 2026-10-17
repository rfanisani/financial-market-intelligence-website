// Minimum test suite (node:test, zero dependencies).
// Run: node scripts/test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  OUNCE_GRAMS, usdPerGram, gold18UsdPerGram, gold24UsdPerGram,
  impliedUsd, difference, expectedDomesticPrice,
} from '../src/calc.js';
import {
  simpleReturns, periodReturn, volatility, maxDrawdown,
  sma, trendSignal, normalize, correlation, compareAssets, resolveWindow, LAB_WINDOWS, signalBacktest,
} from '../src/lab-calc.js';
import { validateCurrent, validateHistory } from '../src/validate.js';
import { providerNavasan } from './fetch-data.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

test('troy ounce conversion constant', () => {
  assert.equal(OUNCE_GRAMS, 31.1034768);
  assert.ok(Math.abs(usdPerGram(OUNCE_GRAMS) - 1) < 1e-12);
});

test('18K and 24K gram values from ounce price', () => {
  const oz = 2650;
  assert.ok(Math.abs(gold18UsdPerGram(oz) - (oz / OUNCE_GRAMS) * 0.75) < 1e-9);
  assert.ok(Math.abs(gold24UsdPerGram(oz) - (oz / OUNCE_GRAMS) * 0.999) < 1e-9);
  assert.ok(gold24UsdPerGram(oz) > gold18UsdPerGram(oz));
});

test('implied USD: 18K per-gram quote', () => {
  // If 18K gram costs exactly its USD value at rate 1, implied must be 1.
  const g18 = gold18UsdPerGram(2650);
  assert.ok(Math.abs(impliedUsd({ domesticPrice: g18, globalOunceUsd: 2650, purity: 0.75 }) - 1) < 1e-9);
});

test('implied USD: Emami coin (8.133 g, 0.900 fineness)', () => {
  const rate = 140000;
  const coin = rate * 8.133 * 0.9 * (2650 / OUNCE_GRAMS);
  assert.ok(Math.abs(impliedUsd({ domesticPrice: coin, globalOunceUsd: 2650, purity: 0.9, weightGrams: 8.133 }) - rate) < 1e-6);
});

test('implied USD returns null on invalid input', () => {
  assert.equal(impliedUsd({ domesticPrice: 0, globalOunceUsd: 2650 }), null);
  assert.equal(impliedUsd({ domesticPrice: -5, globalOunceUsd: 2650 }), null);
  assert.equal(impliedUsd({ domesticPrice: 100, globalOunceUsd: 0 }), null);
  assert.equal(impliedUsd({ domesticPrice: undefined, globalOunceUsd: 2650 }), null);
  assert.equal(impliedUsd({ domesticPrice: 100, globalOunceUsd: 2650, purity: 0 }), null);
});

test('difference and difference %', () => {
  const d = difference(100, 110);
  assert.equal(d.abs, 10);
  assert.ok(Math.abs(d.pct - 10) < 1e-9);
  assert.equal(difference(0, 110), null);
  assert.equal(difference(100, null), null);
});

test('reverse calculation: expected domestic price', () => {
  const p = expectedDomesticPrice({ usdRate: 140000, globalOunceUsd: 2650, purity: 0.75, weightGrams: 1 });
  const back = impliedUsd({ domesticPrice: p, globalOunceUsd: 2650, purity: 0.75 });
  assert.ok(Math.abs(back - 140000) < 1e-6);
  assert.equal(expectedDomesticPrice({ usdRate: 0, globalOunceUsd: 2650 }), null);
});

test('current.json seed data is valid', () => {
  const data = JSON.parse(readFileSync(path.join(root, 'data/current.json'), 'utf8'));
  const res = validateCurrent(data, { now: data.t + 60 });
  assert.deepEqual(res.errors, []);
  assert.ok(res.ok);
});

test('stale data is rejected', () => {
  const data = JSON.parse(readFileSync(path.join(root, 'data/current.json'), 'utf8'));
  const res = validateCurrent(data, { now: data.t + 4 * 86400 });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes('stale')));
});

test('missing/invalid fields are rejected', () => {
  assert.equal(validateCurrent(null).ok, false);
  assert.equal(validateCurrent({ t: 1 }).ok, false);
  assert.equal(validateCurrent({ t: Date.now() / 1000, a: { XAU: { v: -1, c: 0, s: 'seed' } } }).ok, false);
  assert.equal(validateCurrent({ t: Date.now() / 1000, a: { XAU: { v: 1, c: 0, s: 'unknown-src' } } }).ok, false);
});

test('history files are valid', () => {
  for (const f of ['history-7d.json', 'history-30d.json', 'history-1y.json']) {
    const h = JSON.parse(readFileSync(path.join(root, 'data', f), 'utf8'));
    const res = validateHistory(h);
    assert.deepEqual(res.errors, [], f);
  }
});

// --- Navasan secondary source -------------------------------------------------
// Fixture replicates the live https://www.navasan.tech/wp-navasan.php wire format:
// JSONP wrapping a doubly-escaped HTML table. The inner JSON uses PHP json_encode
// escapes (forward slashes -> \/, non-ASCII -> \uXXXX) and is embedded in a
// single-quoted JS string. Values use Persian digits with ASCII thousand commas.
function navasanWireFixture() {
  const rowHtml = [
    ['usd', 'دلار آمریکا', '۲۶۶,۷۹۰', '۰'],
    ['eur', 'یورو', '۲۹۸,۵۸۰', '۰'],
    ['gbp', 'پوند انگلیس', '۳۵۲,۳۸۰', '۰'],
    ['usd_xau', 'اونس طلا به دلار', '۴,۱۳۴', '-۲'],
    ['18ayar', 'یک گرم طلا ۱۸ عیار', '۲۶,۳۰۵,۴۶۰', '۰'],
    ['sekkeh', 'سکه طرح امامی', '۲۷۰,۰۰۰,۰۰۰', '۰'],
    ['nim', 'سکه نیم', '۱۴۳,۰۰۰,۰۰۰', '۰'],
    ['rob', 'سکه ربع', '۷۶,۵۰۰,۰۰۰', '۰'],
  ].map(([id, nam, val, chg]) =>
    `<tr id="${id}">\r\n<td class="nam">${nam}</td>\t\r\n<td class="val">${val}</td>\r\n<td class="chg zer">${chg}</td>\r\n<td class="dat">۲۰:۵۹</td>\r\n</tr>`
  ).join('\r\n');
  const html = `<table id="navasan_table" dir="rtl">\r\n<tbody>\r\n${rowHtml}\r\n` +
    `<tr style="background-color: transparent"><td colspan="4"><a href="https://www.navasan.net" target="_blank">نرخ ارز</a></td></tr>\r\n` +
    `<tr><td colspan="4"></td></tr>\r\n</tbody>\r\n</table>`;
  const jsonText = JSON.stringify(html)
    .replace(/\//g, '\\/')
    .replace(/[^\x00-\x7F]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
  return `navasanret('${jsonText.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}');`;
}

async function withMockFetch(response, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = typeof response === 'number'
    ? async () => ({ ok: false, status: response })
    : async () => ({ ok: true, text: async () => response });
  try { return await fn(); } finally { globalThis.fetch = orig; }
}

test('navasan provider parses the live JSONP/HTML wire format', async () => {
  const out = await withMockFetch(navasanWireFixture(), providerNavasan);
  assert.equal(out.USDIRR.v, 266790); // Persian digits + ASCII thousand separators
  assert.equal(out.EURIRR.v, 298580);
  assert.equal(out.GBPIRR.v, 352380);
  assert.equal(out.XAU.v, 4134);
  assert.ok(Math.abs(out.XAU.c - (-2 / 4134) * 100) < 1e-9); // absolute change -> percent
  assert.equal(out.AU18.v, 26305460);
  assert.equal(out.COIN.v, 270000000);
  assert.equal(out.COINH.v, 143000000);
  assert.equal(out.COINQ.v, 76500000);
  assert.equal(out.USDIRR.c, 0);
  assert.equal(out.AU24, undefined); // not offered by navasan
  assert.equal(Object.keys(out).length, 8); // attribution/empty rows are skipped
});

test('navasan provider throws on http error or malformed body', async () => {
  // The pipeline catches these and keeps the last known good values.
  await assert.rejects(withMockFetch(503, providerNavasan), /503/);
  await assert.rejects(withMockFetch('<html>error</html>', providerNavasan));
  await assert.rejects(withMockFetch('navasanret();', providerNavasan));
});

// --- Generated site: links & footer refresh button ----------------------------
const PUB = path.join(root, 'public');

function listHtml(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? listHtml(p) : (f.endsWith('.html') ? [p] : []);
  });
}

test('all internal links and scripts in generated pages resolve to real files', () => {
  const pages = listHtml(PUB);
  assert.ok(pages.length >= 14, `expected the built site, found ${pages.length} pages`);
  for (const page of pages) {
    const html = readFileSync(page, 'utf8');
    const dir = path.dirname(page);
    for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const ref0 = m[1];
      if (/^(https?:)?\/\//.test(ref0) || ref0.startsWith('#') || ref0.startsWith('mailto:')) continue;
      const ref = ref0.split('#')[0].split('?')[0];
      if (!ref) continue;
      const target = ref.startsWith('/') ? path.join(PUB, ref) : path.resolve(dir, ref);
      const file = statSync(target, { throwIfNoEntry: false })?.isDirectory()
        ? path.join(target, 'index.html')
        : target;
      assert.ok(existsSync(file), `${path.relative(PUB, page)} -> ${ref0} (resolved ${path.relative(PUB, file)})`);
    }
  }
});

test('navigation stays inside the language scope', () => {
  const faHome = readFileSync(path.join(PUB, 'fa/index.html'), 'utf8');
  assert.ok(faHome.includes('href="./"'), 'fa home: home tab');
  assert.ok(faHome.includes('href="gold/"'), 'fa home: gold tab');
  assert.ok(!faHome.includes('href="../gold/"'), 'fa home: no root-escaping tab links');
  assert.ok(faHome.includes('href="about/"'), 'fa home: footer about link');
  const faGold = readFileSync(path.join(PUB, 'fa/gold/index.html'), 'utf8');
  assert.ok(faGold.includes('href="../"'), 'fa gold: home tab');
  assert.ok(faGold.includes('href="../currency/"'), 'fa gold: currency tab');
  assert.ok(faGold.includes('href="../about/"'), 'fa gold: footer about link');
  assert.ok(!faGold.includes('href="../../gold/"'), 'fa gold: no root-escaping tab links');
  const enOil = readFileSync(path.join(PUB, 'en/oil/index.html'), 'utf8');
  assert.ok(enOil.includes('href="../iran-gold/"'), 'en oil: iran-gold tab');
  assert.ok(enOil.includes('href="../../fa/oil/"'), 'en oil: language switch');
});

test('every page has the footer refresh button wired to refresh.js', () => {
  assert.ok(existsSync(path.join(PUB, 'js/refresh.js')), 'public/js/refresh.js is built');
  // Compare against the published snapshot (public/data/current.json), NOT the
  // live data/current.json: in CI the pipeline runs fetch -> test -> build, so
  // the live file is already newer than the committed build at test time.
  const pubData = JSON.parse(readFileSync(path.join(PUB, 'data/current.json'), 'utf8'));
  for (const page of listHtml(PUB)) {
    const rel = path.relative(PUB, page);
    if (rel === 'index.html' || rel === '404.html') continue; // bare redirect pages
    const html = readFileSync(page, 'utf8');
    assert.ok(html.includes('id="refresh-btn"'), `${rel}: refresh button`);
    assert.ok(html.includes('js/refresh.js'), `${rel}: refresh.js script`);
    assert.ok(html.includes('id="i18n-refresh"'), `${rel}: refresh i18n`);
    const m = html.match(/<body[^>]* data-t="(\d+)"/);
    assert.ok(m, `${rel}: data-t timestamp on <body>`);
    assert.equal(m[1], String(pubData.t), `${rel}: data-t matches the published data snapshot`);
  }
});

// --- Financial Intelligence Lab: calculation correctness ----------------------
// Deterministic fixtures — no network, no randomness.

test('lab: simple returns from a deterministic series', () => {
  assert.deepEqual(simpleReturns([100, 110, 99]), [0.1, -0.1]);
  assert.equal(simpleReturns([100]), null);       // too few points
  assert.equal(simpleReturns([]), null);
  assert.equal(simpleReturns(null), null);
  assert.equal(simpleReturns('nope'), null);
  assert.equal(simpleReturns([100, -5]), null);   // non-positive price
  assert.equal(simpleReturns([100, 0]), null);
  assert.equal(simpleReturns([100, NaN]), null);  // non-finite
  assert.equal(simpleReturns([100, 'x']), null);  // non-numeric
});

test('lab: period return over the window', () => {
  const r = periodReturn([100, 110, 121]);
  assert.equal(r.first, 100);
  assert.equal(r.last, 121);
  assert.ok(Math.abs(r.pct - 21) < 1e-9);
  assert.equal(r.points, 3);
  assert.equal(periodReturn([5]), null);
  assert.equal(periodReturn([10, -1]), null);
});

test('lab: volatility is the annualised sample stddev of daily returns', () => {
  const flat = volatility([100, 100, 100]);
  assert.deepEqual(flat, { n: 2, dailyStd: 0, annualized: 0 });
  const v = volatility([100, 110, 99]); // returns [0.1, -0.1], mean 0
  assert.equal(v.n, 2);
  assert.ok(Math.abs(v.dailyStd - Math.sqrt(0.02)) < 1e-12);
  assert.ok(Math.abs(v.annualized - Math.sqrt(0.02) * Math.sqrt(252)) < 1e-12);
  assert.equal(volatility([100, 110]), null); // only 1 return
  assert.equal(volatility([100]), null);
});

test('lab: max drawdown finds the worst peak-to-trough decline', () => {
  const dd = maxDrawdown([100, 120, 60, 90, 130]);
  assert.ok(Math.abs(dd.pct + 50) < 1e-9); // 120 -> 60 is -50%
  assert.equal(dd.from, 1);
  assert.equal(dd.to, 2);
  assert.equal(dd.points, 5);
  assert.equal(maxDrawdown([100, 110, 120]).pct, 0); // monotonic rise: no drawdown
  assert.equal(maxDrawdown([100]), null);
  assert.equal(maxDrawdown([100, -1]), null);
});

test('lab: simple moving average pads the warm-up window with null', () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  assert.deepEqual(sma([2, 4], 2), [null, 3]);
  assert.equal(sma([1, 2], 0), null);    // window < 1
  assert.equal(sma([1, 2], 3), null);    // window > length
  assert.equal(sma([1, 2], 1.5), null);  // non-integer
  assert.equal(sma([1], 1), null);       // too few points
});

test('lab: trend signal classifies latest price vs its moving average', () => {
  const up = trendSignal([100, 101, 102, 103, 104, 105, 120], 3);
  assert.equal(up.direction, 'up');
  assert.ok(Math.abs(up.sma - (104 + 105 + 120) / 3) < 1e-9);
  assert.ok(up.vsSmaPct > 5);
  assert.equal(up.window, 3);
  const down = trendSignal([120, 105, 104, 103, 102, 101, 90], 3);
  assert.equal(down.direction, 'down');
  const flat = trendSignal([100, 100, 100, 100], 2);
  assert.equal(flat.direction, 'flat');
  assert.equal(trendSignal([100], 2), null);
  assert.equal(trendSignal([100, 120], 5), null); // window > length
});

test('lab: window selector maps 7/30/365 exactly (1 year must not fall back to 7 days)', () => {
  assert.deepEqual([...LAB_WINDOWS], [7, 30, 365]);
  assert.equal(resolveWindow('365'), 365);
  assert.equal(resolveWindow(365), 365);
  assert.equal(resolveWindow('30'), 30);
  assert.equal(resolveWindow('7'), 7);
  assert.equal(resolveWindow('14'), 7);   // unsupported -> default
  assert.equal(resolveWindow(''), 7);
  assert.equal(resolveWindow(undefined), 7);
});

test('lab signal: buy/sell signals, trades and returns match a hand-worked example', () => {
  // SMA3 on [10,11,12,11,9,8,9,12,13,12,10]: first valid day is index 2.
  const r = signalBacktest([10, 11, 12, 11, 9, 8, 9, 12, 13, 12, 10], 3);
  assert.deepEqual(r.signals, [
    { i: 2, type: 'buy' }, { i: 3, type: 'sell' }, { i: 6, type: 'buy' }, { i: 9, type: 'sell' },
  ]);
  assert.equal(r.closedCount, 2);
  assert.equal(r.wins, 1);
  assert.equal(r.winRate, 50);
  assert.ok(Math.abs(r.trades[0].retPct - (-8.3333)) < 1e-3);
  assert.ok(Math.abs(r.trades[1].retPct - 33.3333) < 1e-3);
  assert.ok(Math.abs(r.strategyPct - 22.2222) < 1e-3);   // only in the market: 2->3, 6->9
  assert.ok(Math.abs(r.buyHoldPct - (-16.6667)) < 1e-3);
  assert.equal(r.hitLong.n, 4);
  assert.equal(r.hitLong.hits, 2);
  assert.equal(r.current.inMarket, false);
  assert.equal(r.openPosition, false);
});

test('lab signal: open position at window end is reported but excluded from win rate', () => {
  const r = signalBacktest([10, 11, 12, 13, 14, 15, 16], 3);   // always above the average
  assert.equal(r.openPosition, true);
  assert.equal(r.closedCount, 0);
  assert.equal(r.winRate, null);
  assert.equal(r.current.inMarket, true);
  assert.equal(r.signals.length, 1);
});

test('lab signal: rejects windows that leave too little data', () => {
  assert.equal(signalBacktest([1, 2, 3], 3), null);
  assert.equal(signalBacktest([1, 2, 3, 4, 5], 0), null);
});

test('lab: normalize rebases a series to 100 at the first point', () => {
  assert.deepEqual(normalize([50, 100, 25]), [100, 200, 50]);
  assert.equal(normalize([1]), null);
  assert.equal(normalize([5, -5]), null);
});

test('lab: correlation of daily returns (Pearson)', () => {
  // Identical return series (exact multiples) correlate at +1...
  const plus = correlation([100, 110, 99, 121], [300, 330, 297, 363]);
  assert.ok(Math.abs(plus - 1) < 1e-12);
  // ...and exactly inverted returns at -1.
  const minus = correlation([100, 110, 99, 121], [100, 90, 99, 77]);
  assert.ok(Math.abs(minus + 1) < 1e-12);
  assert.equal(correlation([100, 100], [1, 2]), null);  // zero variance
  assert.equal(correlation([100, 110], [1, 2, 3]), null); // length mismatch
  assert.equal(correlation([100], [1]), null);            // too few points
});

test('lab: compare assets returns normalised performance, spread and correlation', () => {
  const c = compareAssets([100, 110, 99, 121], [300, 330, 297, 363]);
  assert.ok(Math.abs(c.aPct - 21) < 1e-9);
  assert.ok(Math.abs(c.bPct - 21) < 1e-9);
  assert.ok(Math.abs(c.spreadPct) < 1e-9);
  assert.ok(Math.abs(c.correlation - 1) < 1e-12);
  assert.equal(c.a.length, 4);
  assert.equal(c.b.length, 4);
  assert.equal(c.a[0], 100);
  assert.equal(compareAssets([100], [1, 2]), null);
  assert.equal(compareAssets([100, 110], [1, 2, 3]), null); // length mismatch
});

// --- Financial Intelligence Lab: generated pages ------------------------------

test('lab pages exist in both languages with correct direction and wiring', () => {
  assert.ok(existsSync(path.join(PUB, 'js/lab.js')), 'public/js/lab.js is built');
  assert.ok(existsSync(path.join(PUB, 'js/lab-calc.js')), 'public/js/lab-calc.js is built');
  for (const [lang, dir] of [['fa', 'rtl'], ['en', 'ltr']]) {
    const p = path.join(PUB, lang, 'lab/index.html');
    assert.ok(existsSync(p), `${lang} lab page exists`);
    const html = readFileSync(p, 'utf8');
    assert.ok(html.includes(`<html lang="${lang}" dir="${dir}">`), `${lang}: html lang/dir`);
    assert.ok(html.includes('src="../../js/lab.js"'), `${lang}: lab.js module script`);
    assert.ok(html.includes('id="lab-form"'), `${lang}: lab form`);
    assert.ok(html.includes('id="lab-result"'), `${lang}: result region`);
    assert.ok(html.includes('id="lab-data"'), `${lang}: embedded lab data`);
    assert.ok(html.includes('id="i18n-lab"'), `${lang}: embedded lab i18n`);
    assert.ok(html.includes('<noscript>'), `${lang}: noscript fallback`);
    const data = JSON.parse(html.match(/<script type="application\/json" id="lab-data">([\s\S]*?)<\/script>/)[1]);
    assert.ok(Array.isArray(data.assets) && data.assets.length >= 6, `${lang}: assets embedded`);
    for (const a of data.assets) {
      assert.ok(Array.isArray(a.s7) && a.s7.length >= 2, `${lang}/${a.code}: 7d series`);
      assert.ok(Array.isArray(a.s30) && a.s30.length >= 2, `${lang}/${a.code}: 30d series`);
      assert.ok(Array.isArray(a.s365) && a.s365.length >= 2, `${lang}/${a.code}: 1y series`);
      assert.ok(Number.isFinite(a.d) && a.name && a.src, `${lang}/${a.code}: metadata`);
    }
    assert.ok(Number.isFinite(data.w7.t0) && data.w7.dt > 0, `${lang}: 7d window timestamps`);
    assert.ok(Number.isFinite(data.w30.t0) && data.w30.dt > 0, `${lang}: 30d window timestamps`);
    assert.ok(Number.isFinite(data.w365.t0) && data.w365.dt > 0, `${lang}: 1y window timestamps`);
    const L = JSON.parse(html.match(/<script type="application\/json" id="i18n-lab">([\s\S]*?)<\/script>/)[1]);
    for (const k of ['title', 'tool', 'asset', 'assetA', 'assetB', 'window', 'run', 'empty', 'noJs',
      'sameAsset', 'dataMissing', 'insufficient', 'periodReturn', 'volatility', 'maxDrawdown',
      'sma', 'corr', 'spread', 'mReturn', 'mVol', 'mDd', 'mSma', 'mCorr', 'dataNote', 'windowRange',
      'source', 'shortWindow', 'notAdvice', 'tReturn', 'tRisk', 'tTrend', 'tCompare']) {
      assert.ok(typeof L[k] === 'string' && L[k].length > 0, `${lang}: i18n key "${k}"`);
    }
  }
});

test('lab is integrated into navigation and language switching preserves the destination', () => {
  const faHome = readFileSync(path.join(PUB, 'fa/index.html'), 'utf8');
  assert.ok(faHome.includes('href="lab/"'), 'fa home: lab tab');
  assert.ok(faHome.includes('href="calculator/"'), 'fa home: calculator tab still present');
  const faLab = readFileSync(path.join(PUB, 'fa/lab/index.html'), 'utf8');
  assert.ok(faLab.includes('href="../lab/" aria-current="page"'), 'fa lab: aria-current tab');
  assert.ok(faLab.includes('href="../../en/lab/"'), 'fa lab: language switch goes to /en/lab/');
  const enLab = readFileSync(path.join(PUB, 'en/lab/index.html'), 'utf8');
  assert.ok(enLab.includes('href="../lab/" aria-current="page"'), 'en lab: aria-current tab');
  assert.ok(enLab.includes('href="../../fa/lab/"'), 'en lab: language switch goes to /fa/lab/');
  const enGold = readFileSync(path.join(PUB, 'en/gold/index.html'), 'utf8');
  assert.ok(enGold.includes('href="../lab/"'), 'en gold: lab tab stays inside /en/');
  const faGold = readFileSync(path.join(PUB, 'fa/gold/index.html'), 'utf8');
  assert.ok(faGold.includes('href="../lab/"'), 'fa gold: lab tab stays inside /fa/');
  assert.ok(!faGold.includes('href="../../lab/"'), 'fa gold: no root-escaping lab link');
});

test('root redirects default to English (/en/) with Persian as fallback link', () => {
  const html = readFileSync(path.join(PUB, 'index.html'), 'utf8');
  assert.ok(html.includes("location.replace('en/')"), 'root JS redirect to en/');
  assert.ok(html.includes('content="0;url=en/"'), 'root meta refresh to en/');
  assert.ok(html.includes('lang="en"'), 'root html lang is en');
  assert.ok(html.includes('href="fa/"'), 'root keeps a Persian fallback link');
  const app = readFileSync(path.join(root, 'app/page.tsx'), 'utf8');
  assert.ok(app.includes("redirect('/en/index.html')"), 'next preview route redirects to /en/');
});

test('sitemap includes the lab routes and robots still allows them', () => {
  const sm = readFileSync(path.join(PUB, 'sitemap.xml'), 'utf8');
  assert.ok(sm.includes('/fa/lab/'), 'sitemap: /fa/lab/');
  assert.ok(sm.includes('/en/lab/'), 'sitemap: /en/lab/');
  const robots = readFileSync(path.join(PUB, 'robots.txt'), 'utf8');
  assert.ok(robots.includes('Allow: /'), 'robots: still allows all');
});

test('lab pages carry the data-status line, disclaimer and method notes', () => {
  for (const lang of ['fa', 'en']) {
    const html = readFileSync(path.join(PUB, lang, 'lab/index.html'), 'utf8');
    assert.ok(html.includes('class="status"'), `${lang}: data status line`);
    assert.ok(html.includes('data-t="'), `${lang}: data timestamp on body`);
    const L = JSON.parse(html.match(/<script type="application\/json" id="i18n-lab">([\s\S]*?)<\/script>/)[1]);
    assert.ok(html.includes(esc(L.dataNote)), `${lang}: data note rendered`);
    assert.ok(html.includes(esc(L.notAdvice)), `${lang}: not-advice note rendered`);
    assert.ok(html.includes(esc(L.mReturn)), `${lang}: return formula rendered`);
    assert.ok(html.includes(esc(L.mVol)), `${lang}: volatility formula rendered`);
    assert.ok(html.includes(esc(L.mDd)), `${lang}: drawdown formula rendered`);
    assert.ok(html.includes(esc(L.mCorr)), `${lang}: correlation formula rendered`);
  }
});

test('trend switcher tabs exist for week, month, and year on home and category pages', () => {
  assert.ok(existsSync(path.join(PUB, 'js/trend.js')), 'public/js/trend.js is built');
  assert.ok(existsSync(path.join(PUB, 'data/history-1y.json')), 'public/data/history-1y.json is built');
  for (const lang of ['fa', 'en']) {
    for (const slug of ['', 'gold/', 'currency/', 'oil/', 'iran-gold/']) {
      const p = path.join(PUB, lang, slug, 'index.html');
      const html = readFileSync(p, 'utf8');
      assert.ok(html.includes('class="card trend-card"'), `${lang}/${slug}: trend card`);
      assert.ok(html.includes('data-period="7d"'), `${lang}/${slug}: 7d tab`);
      assert.ok(html.includes('data-period="30d"'), `${lang}/${slug}: 30d tab`);
      assert.ok(html.includes('data-period="1y"'), `${lang}/${slug}: 1y tab`);
      assert.ok(html.includes('data-panel="7d"'), `${lang}/${slug}: 7d panel`);
      assert.ok(html.includes('data-panel="30d"'), `${lang}/${slug}: 30d panel`);
      assert.ok(html.includes('data-panel="1y"'), `${lang}/${slug}: 1y panel`);
      assert.ok(html.includes('js/trend.js'), `${lang}/${slug}: trend.js script wired`);
    }
  }
});

test('tables include data-code attributes and fast-update script is wired', () => {
  for (const lang of ['fa', 'en']) {
    const homeHtml = readFileSync(path.join(PUB, lang, 'index.html'), 'utf8');
    assert.ok(homeHtml.includes('data-code="XAU"'), `${lang}: data-code attribute on asset rows`);
    assert.ok(homeHtml.includes('data-code="USDIRR"'), `${lang}: data-code on USDIRR`);
    assert.ok(homeHtml.includes('fastUpdated'), `${lang}: fastUpdated string in refresh payload`);
  }
});

test('history: exact window boundaries (7d=7, 30d=30, 1y=365) and dt=86400', () => {
  const h7 = JSON.parse(readFileSync(path.join(root, 'data/history-7d.json'), 'utf8'));
  const h30 = JSON.parse(readFileSync(path.join(root, 'data/history-30d.json'), 'utf8'));
  const h1y = JSON.parse(readFileSync(path.join(root, 'data/history-1y.json'), 'utf8'));

  assert.equal(h7.dt, 86400, '7d dt must be 86400s (daily)');
  assert.equal(h30.dt, 86400, '30d dt must be 86400s (daily)');
  assert.equal(h1y.dt, 86400, '1y dt must be 86400s (daily)');

  assert.equal(h7.t0 % 86400, 0, '7d t0 must align with midnight UTC');
  assert.equal(h30.t0 % 86400, 0, '30d t0 must align with midnight UTC');
  assert.equal(h1y.t0 % 86400, 0, '1y t0 must align with midnight UTC');

  for (const code of ['XAU', 'XAG', 'BRENT', 'WTI', 'USDIRR', 'AU18']) {
    assert.equal(h7.a[code].length, 7, `${code}: 7d series must have exactly 7 points`);
    assert.equal(h30.a[code].length, 30, `${code}: 30d series must have exactly 30 points`);
    assert.equal(h1y.a[code].length, 365, `${code}: 1y series must have exactly 365 points`);

    // Verify terminal points align across windows
    assert.equal(h7.a[code][h7.a[code].length - 1], h30.a[code][h30.a[code].length - 1], `${code}: latest point matches between 7d and 30d`);
    assert.equal(h30.a[code][h30.a[code].length - 1], h1y.a[code][h1y.a[code].length - 1], `${code}: latest point matches between 30d and 1y`);
  }
});

test('history: validation rejects malformed structures, negative prices and excessive points', () => {
  assert.equal(validateHistory(null).ok, false);
  assert.equal(validateHistory({}).ok, false);
  assert.equal(validateHistory({ t0: 100, dt: 0, a: { XAU: [1, 2] } }).ok, false);
  assert.equal(validateHistory({ t0: 100, dt: 86400, a: { XAU: [] } }).ok, false);
  assert.equal(validateHistory({ t0: 100, dt: 86400, a: { XAU: [100, -5] } }).ok, false);
  assert.equal(validateHistory({ t0: 100, dt: 86400, a: { XAU: [100, NaN] } }).ok, false);
  assert.equal(validateHistory({ t0: 100, dt: 86400, a: { XAU: new Array(401).fill(10) } }, { maxPoints: 400 }).ok, false);
});

// --- Live (per-visit) browser providers ------------------------------------------
import {
  parseGoldApiPrice, parseFrankfurter, parseTgjuRow, parseNavasanJsonp, decodeJsString,
  parseTgjuSeries, parseYahooChart,
} from '../src/live-parse.js';

test('live: navasan JSONP parsed in the browser matches the Node pipeline exactly', async () => {
  const fixture = navasanWireFixture();
  const browser = parseNavasanJsonp(fixture);
  const node = await withMockFetch(fixture, providerNavasan);
  assert.deepEqual(browser, node);
  assert.equal(browser.USDIRR.v, 266790);
  assert.equal(browser.AU24, undefined);
});

test('live: JS string decoder handles the escapes PHP/JS produce', () => {
  assert.equal(decodeJsString(String.raw`a\\b`), 'a\\b');   // \\ -> \
  assert.equal(decodeJsString(String.raw`it\'s`), "it's");       // \' -> '
  assert.equal(decodeJsString(String.raw`a\/b`), 'a/b');
  assert.equal(decodeJsString(String.raw`\u06cc`), 'ی');
  assert.equal(decodeJsString(String.raw`\x41`), 'A');
  assert.equal(decodeJsString('bad\\'), null);                  // dangling escape
  assert.equal(decodeJsString(String.raw`\uZZZZ`), null);       // malformed unicode escape
});

test('live: navasan parser refuses anything that is not the expected wrapper', () => {
  assert.deepEqual(parseNavasanJsonp('alert(1)'), {});
  assert.deepEqual(parseNavasanJsonp('navasanret(42);'), {});
  assert.deepEqual(parseNavasanJsonp("navasanret('not json');"), {});
});

test('live: gold-api, frankfurter and tgju parsers (values, rejects bad input)', () => {
  assert.deepEqual(parseGoldApiPrice({ price: 4164.4 }, 'XAU'), { XAU: { v: 4164.4 } });
  assert.deepEqual(parseGoldApiPrice({ price: -1 }, 'XAU'), {});
  assert.deepEqual(parseGoldApiPrice({ error: 'Symbol not found' }, 'BRENT'), {});

  const fx = parseFrankfurter({ rates: { EUR: 0.5, GBP: 0.25, JPY: 158 } });
  assert.equal(fx.EURUSD.v, 2);
  assert.equal(fx.GBPUSD.v, 4);
  assert.equal(fx.USDJPY.v, 158);
  assert.deepEqual(parseFrankfurter({ rates: { EUR: 0 } }), {});

  const row = ['2,641,050', '2,616,000', '2,651,000', '2,626,000', '', '<span class="up">1.29%</span>', '', ''];
  assert.deepEqual(parseTgjuRow({ data: [row] }, 'USDIRR'), { USDIRR: { v: 264105, c: 1.29 } });
  assert.deepEqual(parseTgjuRow({ data: [] }, 'USDIRR'), {});
});

test('live: browser module is data-only (no eval, no dynamic code) and runs on every page load', () => {
  const live = readFileSync(path.join(root, 'src/live.js'), 'utf8');
  const parse = readFileSync(path.join(root, 'src/live-parse.js'), 'utf8');
  for (const src of [live, parse]) {
    assert.ok(!/\beval\s*\(|new Function\s*\(|vm\./.test(src), 'no code execution of remote payloads');
  }
  assert.ok(live.includes('requestIdleCallback') && live.includes('setTimeout'), 'starts after paint');
  assert.ok(live.includes("cache: 'no-store'"), 'bypasses caches on every visit');
  assert.ok(live.includes('AbortSignal.timeout'), 'bounded wait per provider');
  const refresh = readFileSync(path.join(root, 'src/refresh.js'), 'utf8');
  assert.ok(refresh.includes("'market:live'") && refresh.includes("from './calc.js'"), 'refresh applies live values with shared formulas');
});

test('live: TGJU is requested with length=8 (row=1 is ignored upstream and returns the full history)', () => {
  const live = readFileSync(path.join(root, 'src/live.js'), 'utf8');
  const fetchData = readFileSync(path.join(root, 'scripts/fetch-data.mjs'), 'utf8');
  assert.ok(live.includes('?length=8'), 'live: length=8');
  assert.ok(!/summary-table-data\/[^`'"]*\?row=1/.test(live), 'live: no row=1');
  assert.ok(!/summary-table-data\/\$\{sym\}\?row=1/.test(fetchData), 'fetch-data: no row=1');
  assert.ok(fetchData.includes('?length=1'), 'fetch-data: length=1');
});

test('ticker: TGJU series gives latest quote, 1-day and 1-week change (newest row first)', () => {
  const row = (v, pct, d) => [v, '', '', '', '', pct, d, ''];
  const j = { data: [
    row('4,169.51', '0.08%', '2026/10/16'),
    row('4,099.45', '1.72%', '2026/10/15'),
    row('4,158.02', '<span class="high">1.42%</span>', '2026/10/14'),
    row('4,000', '0', '2026/10/09'),          // exactly 7 days before 16 Oct
    row('3,990', '0', '2026/10/08'),
  ] };
  const r = parseTgjuSeries(j, 'XAU', 1).XAU;
  assert.equal(r.v, 4169.51);
  assert.equal(r.c, 0.08);
  assert.ok(Math.abs(r.w - ((4169.51 / 4000 - 1) * 100)) < 1e-9);
  assert.equal(r.d, '2026-10-16');
  // Rial to toman, and a quote with a tag-wrapped percent and no usable week reference.
  const c = parseTgjuSeries({ data: [['2,699,200,000', '', '', '', '', '1.06%', '2026/10/15', '']] }, 'COIN', 0.1).COIN;
  assert.equal(c.v, 269920000);
  assert.equal(c.c, 1.06);
  assert.equal(c.w, undefined);
  // Rejects unusable input without throwing.
  assert.deepEqual(parseTgjuSeries({ data: [] }, 'X'), {});
  assert.deepEqual(parseTgjuSeries(null, 'X'), {});
  assert.deepEqual(parseTgjuSeries({ data: [['abc', '', '', '', '', '1%', '2026/10/15', '']] }, 'X'), {});
});

test('ticker: Yahoo chart gives last close, 1-day and 1-week change, skipping null closes', () => {
  // Five trading days ending 16 Oct 2026 (UTC midnights), one null close.
  const day = (iso) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 1000);
  const j = { chart: { result: [{
    timestamp: [day('2026-10-09'), day('2026-10-12'), day('2026-10-13'), day('2026-10-14'), day('2026-10-15'), day('2026-10-16')],
    indicators: { quote: [{ close: [100, 102, null, 104, 105, 110] }] },
  }] } };
  const r = parseYahooChart(j, 'NASDAQ').NASDAQ;
  assert.equal(r.v, 110);
  assert.ok(Math.abs(r.c - ((110 / 105 - 1) * 100)) < 1e-9);
  assert.ok(Math.abs(r.w - 10) < 1e-9);   // vs 100 on 9 Oct, exactly 7 days back
  assert.deepEqual(parseYahooChart({}, 'NASDAQ'), {});
});

test('ticker: homepage strip renders all six items with change cells the live update can reach', () => {
  const html = readFileSync(path.join(root, 'public/en/index.html'), 'utf8');
  for (const code of ['XAU', 'BRENT', 'USDIRR', 'COIN', 'TEDPIX', 'NASDAQ']) {
    assert.ok(html.includes(`data-tick="${code}"`), `strip: ${code}`);
  }
  assert.equal((html.match(/data-tick="/g) || []).length, 6);
  assert.equal((html.match(/data-c>/g) || []).length, 6, '1-day cells');
  assert.equal((html.match(/data-w>/g) || []).length, 6, '1-week cells');
  const refresh = readFileSync(path.join(root, 'src/refresh.js'), 'utf8');
  assert.ok(refresh.includes('updateTicker(view'), 'refresh applies the strip on every live round');
});

test('live: progressive rounds, one at a time, bounded per source, with a manual cooldown', () => {
  const live = readFileSync(path.join(root, 'src/live.js'), 'utf8');
  assert.ok(live.includes('if (inFlight) return inFlight'), 'one round at a time');
  assert.ok(live.includes('COOLDOWN_MS = 3000'), 'manual cooldown');
  assert.ok(live.includes("final: false") && live.includes("final: true"), 'partial and final events');
  assert.ok(live.includes("'gold-api': 10000"), 'gold-api timeout is 10 s');
  assert.ok(live.includes('const ATTEMPTS = 3') && live.includes('retryUntil(ATTEMPTS'), 'every source is retried up to 3 times');
});

test('live: every page loads live.js as a module and implied-USD rows are addressable', () => {
  for (const f of listHtml(PUB)) {
    const rel = path.relative(PUB, f);
    if (rel === 'index.html' || rel === '404.html') continue;
    const html = readFileSync(f, 'utf8');
    assert.ok(html.includes('<script type="module" src="') && html.includes('js/live.js"'), `${rel}: live.js`);
    assert.ok(html.includes('id="i18n-refresh"') && html.includes('"srcNames"'), `${rel}: refresh i18n carries source names`);
    if (html.includes('class="status"')) assert.ok(html.includes('class="st-label"'), `${rel}: status label is updatable`);
  }
  const home = readFileSync(path.join(PUB, 'en/index.html'), 'utf8');
  for (const k of ['actual', 'ai18', 'icoin']) assert.ok(home.includes(`data-implied="${k}"`), `implied row ${k}`);
  assert.ok(home.includes('data-v="') && home.includes('data-d="'), 'asset rows carry raw value and decimals');
});

test('no secrets or development artifacts leak into the production output', () => {
  const chunks = listHtml(PUB).map((p) => readFileSync(p, 'utf8'));
  for (const f of ['js/lab.js', 'js/lab-calc.js', 'js/app.js', 'js/calc.js', 'js/trend.js', 'js/refresh.js', 'css/style.css']) {
    chunks.push(readFileSync(path.join(PUB, f), 'utf8'));
  }
  const all = chunks.join('\n');
  for (const pat of [/api[_-]?key/i, /\bsecret\b/i, /\bpassword\b/i, /bearer\s+[a-z0-9._-]+/i, /\btoken\s*[:=]/i, /process\.env/i, /localhost/i, /127\.0\.0\.1/]) {
    assert.ok(!pat.test(all), `production output must not match ${pat}`);
  }
});

// ---- market detail pages (Follow-up 7) ------------------------------------
const MARKET_SLUGS = ['gold-oz', 'brent', 'usd', 'coin', 'tedpix', 'nasdaq'];
const hrefs = (html) => [...html.matchAll(/(?:href|src)="([^"]*)"/g)].map((m) => m[1]);
// Resolve a relative href/src against the page's own directory (root-relative and absolute URLs are skipped).
const resolveLocal = (pageRel, ref) => {
  if (!ref || /^(https?:|mailto:|#|data:|\/\/)/.test(ref)) return null;
  const base = path.posix.dirname(pageRel);
  const abs = ref.startsWith('/') ? ref.slice(1) : path.posix.normalize(path.posix.join(base, ref));
  return abs.replace(/\/$/, '') || '.';
};

test('markets: six detail pages per language exist and carry the chart, ranges and data payload', () => {
  for (const lang of ['en', 'fa']) {
    for (const slug of MARKET_SLUGS) {
      const rel = `${lang}/markets/${slug}/index.html`;
      const f = path.join(PUB, rel);
      assert.ok(existsSync(f), `${rel} exists`);
      const html = readFileSync(f, 'utf8');
      assert.ok(html.includes('id="mk-chart"') && html.includes('id="mk-stats"') && html.includes('id="mk-status"'), `${rel}: chart, stats and status regions`);
      for (const days of ['7', '30', '90', '365']) assert.ok(html.includes(`data-range="${days}"`), `${rel}: range ${days}`);
      assert.ok(html.includes('aria-pressed="true"') && html.includes('class="mk-btn"'), `${rel}: range buttons carry aria-pressed`);
      const m = /<script type="application\/json" id="mk-data">([\s\S]*?)<\/script>/.exec(html);
      assert.ok(m, `${rel}: embedded data payload`);
      const data = JSON.parse(m[1]);
      assert.equal(data.slug, slug, `${rel}: payload slug`);
      assert.ok(Array.isArray(data.series) && data.series.length > 0, `${rel}: payload has history`);
      assert.ok(data.series.every(([d, v]) => /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(v)), `${rel}: series rows are [date, value]`);
      assert.ok(html.includes('<svg') && html.includes('<polyline'), `${rel}: static SVG chart present without JS`);
    }
  }
});

test('markets: a market page is not a 404-prone shell: its own nav, language switch and assets resolve from nested depth', () => {
  for (const lang of ['en', 'fa']) {
    for (const slug of MARKET_SLUGS) {
      const rel = `${lang}/markets/${slug}/index.html`;
      const html = readFileSync(path.join(PUB, rel), 'utf8');
      const refs = hrefs(html).map((r) => resolveLocal(rel, r)).filter(Boolean);
      assert.ok(refs.length > 0, `${rel}: has local links`);
      for (const target of refs) {
        const ok = existsSync(path.join(PUB, target)) || existsSync(path.join(PUB, target, 'index.html'));
        assert.ok(ok, `${rel}: local ref resolves to an existing file: ${target}`);
      }
      assert.ok(html.includes('../../about/') || html.includes('../../../en/about/'), `${rel}: nav reaches about from depth 3`);
      assert.ok(html.includes(`../../../${lang === 'en' ? 'fa' : 'en'}/markets/${slug}/`), `${rel}: language switch keeps the same market`);
      assert.ok(html.includes('../../../js/market.js'), `${rel}: loads js/market.js from the root`);
      assert.ok(html.includes('../../../css/style.css'), `${rel}: stylesheet from the root`);
      assert.ok(html.includes('../../../js/live.js'), `${rel}: live.js from the root`);
    }
  }
  assert.ok(existsSync(path.join(PUB, 'js/market.js')), 'js/market.js is copied to public');
});

test('markets: homepage tiles link to their own detail page in each language', () => {
  for (const lang of ['en', 'fa']) {
    const html = readFileSync(path.join(PUB, `${lang}/index.html`), 'utf8');
    const tiles = [...html.matchAll(/<a class="tick" href="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(tiles, MARKET_SLUGS.map((s) => `markets/${s}/`), `${lang}: six tiles, each linking to its page`);
    for (const h of tiles) assert.ok(existsSync(path.join(PUB, lang, h, 'index.html')), `${lang}: ${h} exists`);
  }
});

test('markets: sitemap lists every market page in both languages', () => {
  const sm = readFileSync(path.join(PUB, 'sitemap.xml'), 'utf8');
  for (const lang of ['en', 'fa']) for (const slug of MARKET_SLUGS) {
    assert.ok(sm.includes(`/${lang}/markets/${slug}/`), `sitemap has ${lang}/markets/${slug}/`);
  }
});

test('markets: live refresh asks TGJU for the latest row only, never a year of history', () => {
  const src = readFileSync(path.join(root, 'src/market.js'), 'utf8');
  assert.ok(src.includes('?length=8'), 'latest-row request');
  assert.ok(!/length=(2\d\d|3\d\d|4\d\d)/.test(src), 'no long-history request in the browser');
  const markets = JSON.parse(readFileSync(path.join(root, 'src/markets.json'), 'utf8'));
  const nasdaq = markets.find((m) => m.slug === 'nasdaq');
  assert.ok(nasdaq && !nasdaq.tgju, 'NASDAQ has no browser TGJU symbol (build-only)');
});

test('markets: market.js falls back to build data and keeps a valid default range', () => {
  const src = readFileSync(path.join(root, 'src/market.js'), 'utf8');
  assert.ok(src.includes('L.liveFail'), 'failure message shown');
  assert.ok(src.includes("data-range") || src.includes('dataset.range'), 'range buttons wired');
  assert.ok(src.includes('series = [...series, latest]'), 'newer point appended');
});

// ---- full section content on market pages and Lab regimes ------------------
import { smaRegimes } from '../src/lab-calc.js';

test('lab: moving-average regimes match a hand-checked series', () => {
  // SMA3 of [10,11,12,11,10,9,10,11,12,13]: above, below, below, below, above, above, above, above
  const r = smaRegimes([10, 11, 12, 11, 10, 9, 10, 11, 12, 13], 3);
  assert.equal(r.n, 8);
  assert.equal(r.aboveDays, 5);
  assert.equal(r.belowDays, 3);
  assert.ok(Math.abs(r.abovePct - 62.5) < 1e-9);
  assert.deepEqual(r.above, { runs: 1, avg: 1, max: 1 });   // one finished 1-point stretch above
  assert.deepEqual(r.below, { runs: 1, avg: 3, max: 3 });   // one finished 3-point stretch below
  assert.deepEqual(r.current, { side: 'above', len: 4 });   // open stretch at the end is not counted as finished
});

test('lab: regimes handle a series that never crosses its average and bad input', () => {
  const rising = smaRegimes([1, 2, 3, 4, 5, 6, 7, 8], 2);
  assert.equal(rising.below.runs, 0);
  assert.equal(rising.below.avg, null);
  assert.equal(rising.above.runs, 0);
  assert.deepEqual(rising.current, { side: 'above', len: 7 });
  assert.equal(smaRegimes([1, 2], 5), null);
  assert.equal(smaRegimes(null, 3), null);
});

test('lab: regime card and labels are present in the lab page (fa and en)', () => {
  for (const lang of ['en', 'fa']) {
    const html = readFileSync(path.join(PUB, `${lang}/lab/index.html`), 'utf8');
    for (const k of ['regimeTitle', 'regimeAbove', 'regimeBelow', 'regimeRunAbove', 'regimeRunBelow', 'regimeStretch', 'regimeNote']) {
      assert.ok(html.includes(`"${k}"`), `${lang} lab: label ${k}`);
    }
  }
  const js = readFileSync(path.join(root, 'src/lab.js'), 'utf8');
  assert.ok(js.includes('regimeCard(a, req)') && js.includes('a.s365'), 'regime card uses the 1-year series');
});

test('markets: each market page has one H1, unique element ids and the full section', () => {
  const expect = { 'gold-oz': 'gold', brent: 'oil', usd: 'currency', coin: 'iran-gold' };
  for (const lang of ['en', 'fa']) {
    for (const slug of MARKET_SLUGS) {
      const rel = `${lang}/markets/${slug}/index.html`;
      const html = readFileSync(path.join(PUB, rel), 'utf8');
      assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, `${rel}: exactly one H1`);
      const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
      const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
      assert.deepEqual([...new Set(dup)], [], `${rel}: duplicate ids`);
      assert.ok(html.includes('class="mk-section"'), `${rel}: full-section block`);
      if (expect[slug]) {
        // The section body is the same markup as the section page (minus its H1).
        const sec = readFileSync(path.join(PUB, `${lang}/${expect[slug]}/index.html`), 'utf8');
        const trendMarker = sec.includes('class="trend') ? 'class="trend' : null;
        if (trendMarker) assert.ok(html.includes(trendMarker), `${rel}: section trend card is embedded`);
        const priceCardTitle = (sec.match(/<section class="card"><h2>([^<]+)<\/h2>/) || [])[1];
        assert.ok(priceCardTitle && html.includes(priceCardTitle), `${rel}: section card "${priceCardTitle}" embedded`);
      } else {
        assert.ok(html.includes('class="tw"') && html.includes('<table'), `${rel}: monthly table`);
        assert.ok(html.includes('class="kv"'), `${rel}: key-value stats`);
      }
    }
  }
});

test('markets: TEDPIX and Nasdaq info block is computed from the stored history, not fetched', () => {
  for (const lang of ['en', 'fa']) {
    for (const slug of ['tedpix', 'nasdaq']) {
      const html = readFileSync(path.join(PUB, `${lang}/markets/${slug}/index.html`), 'utf8');
      assert.ok(html.includes('Market detail (1 year)') || html.includes('جزئیات بازار (یک سال)'), `${lang}/${slug}: info title`);
      assert.ok(html.includes('<table'), `${lang}/${slug}: month table`);
    }
  }
  const js = readFileSync(path.join(root, 'src/market.js'), 'utf8');
  assert.ok(!/fetch\([^)]*(volatility|history|length=(2|3|4))/.test(js), 'market.js fetches no history');
});

// ---- tile freshness: purple unless the source sent an update within a minute ----
import { freshness, FRESH_WITHIN_MS } from '../src/stale.js';
import { parseGoldApiPrice as parseGoldApi } from '../src/live-parse.js';
import { parseTgjuLive } from '../src/live-parse.js';

test('freshness: fresh only with a valid source time less than a minute old', () => {
  const now = 1_000_000_000;
  assert.deepEqual(freshness(now / 1000 - 10, now), { fresh: true, reason: 'ok' });
  assert.equal(freshness(now / 1000 - 59, now).fresh, true);
  assert.equal(freshness(now / 1000 - 61, now).fresh, false);            // older than a minute
  assert.equal(freshness(now / 1000 - 60, now).fresh, true);             // boundary: exactly one minute
  assert.equal(freshness(now / 1000 + 120, now).reason, 'future');       // timestamp in the future
  assert.equal(freshness(null, now).reason, 'no-time');                  // daily rows, navasan: no time
  assert.equal(freshness(undefined, now).fresh, false);                  // source missing
  assert.equal(FRESH_WITHIN_MS, 60_000);
});

test('gold-api parser keeps the source update time in seconds', () => {
  const r = parseGoldApi({ price: 4166.1, updatedAt: '2026-10-17T07:42:40Z' }, 'XAU');
  assert.equal(r.XAU.v, 4166.1);
  assert.equal(r.XAU.t, Date.parse('2026-10-17T07:42:40Z') / 1000);
  assert.deepEqual(parseGoldApi({ price: 4166.1 }, 'XAU'), { XAU: { v: 4166.1 } });
  assert.deepEqual(parseGoldApi({ price: 0, updatedAt: '2026-10-17T07:42:40Z' }, 'XAU'), {});
});

test('tiles: freshness is wired into the refresh on the final event; purple style and strings exist', () => {
  const home = readFileSync(path.join(PUB, 'en/index.html'), 'utf8');
  assert.ok(/data-tick="[A-Z]+"[^>]*data-v="[^"]+" data-bt="\d+"/.test(home), 'home tiles carry value and build time');
  assert.ok(existsSync(path.join(PUB, 'js/stale.js')), 'stale.js copied to public');
  const refresh = readFileSync(path.join(root, 'src/refresh.js'), 'utf8');
  assert.ok(refresh.includes("from './stale.js'") && refresh.includes('paintTile(el, row)') && refresh.includes('updateTicker(view);'), 'refresh applies the rule on every round');
  assert.ok(refresh.includes('freshness(row?.t, Date.now())'), 'freshness uses the source timestamp');
  assert.ok(refresh.includes("'mr-last-live-v1'") && refresh.includes('saveLast(view)') && refresh.includes('const view = viewOf(r.a)'), 'last live quote is kept and restored');
  assert.ok(refresh.includes('lastAt') && home.includes('"lastAt"'), 'last-live label string');
  assert.ok(home.includes('"noTime"'), 'no-time label string');
  const liveSrc = readFileSync(path.join(root, 'src/live.js'), 'utf8');
  assert.ok(liveSrc.includes("NAVASAN_OVER_DAILY = new Set(['COIN', 'COINH', 'COINQ'])"), 'coins keep the current navasan price over the daily TGJU row');
  const css = readFileSync(path.join(root, 'src/style.css'), 'utf8');
  assert.ok(css.includes('.tick.is-stale') && css.includes('#f3e8ff'), 'light purple style');
  assert.ok(home.includes('"staleTile"') && home.includes('"liveAt"') && home.includes('A tile turns light purple'), 'refresh strings and note');
});

test('live: TGJU live feed (via proxy) parses to toman with source time and signed change', () => {
  const j = { current: {
    sekee: { p: '2,674,950,000', dp: 0.9, dt: 'low', ts: '2026-10-17 13:16:24' },
    bourse: { p: '8,265,162.8', dp: 1.94, dt: 'low', ts: '2026-10-17 13:15:06' },
    price_dollar_rl: { p: '2,648,000', dp: 1.22, dt: 'high', ts: '2026-10-17 13:16:14' },
    oil_brent: { p: '109.86', dp: 0, dt: 'eq', ts: '2026-10-17 04:51:30' },
  } };
  const r = parseTgjuLive(j);
  assert.equal(r.COIN.v, 267495000, 'rial -> toman');
  assert.equal(r.COIN.c, -0.9, 'low means down');
  assert.equal(r.COIN.t, Date.parse('2026-10-17T13:16:24+03:30') / 1000, 'Tehran time');
  assert.equal(r.TEDPIX.v, 8265162.8, 'index not scaled');
  assert.equal(r.USDIRR.c, 1.22, 'high means up');
  assert.equal(r.BRENT.v, 109.86);
  assert.deepEqual(parseTgjuLive({}), {}, 'empty payload gives nothing');
  assert.deepEqual(parseTgjuLive({ current: { sekee: { p: 'n/a' } } }), {}, 'bad price is skipped');
});

test('live: proxy URL and the TGJU live source are wired into the round', () => {
  const live = readFileSync(path.join(root, 'src/live.js'), 'utf8');
  assert.ok(live.includes("TGJU_LIVE_URL = 'https://tgju-proxy.rfanisani.workers.dev/'"), 'proxy URL');
  assert.ok(live.includes("'tgju-live': (ms) => getJson(TGJU_LIVE_URL"), 'source registered');
  assert.ok(live.includes("const PRIORITY = ['navasan', 'frankfurter', 'gold-api', 'tgju', 'tgju-live']"), 'last in priority');
  assert.ok(existsSync(path.join(root, 'proxy/tgju-proxy.worker.js')), 'proxy source is kept in the repo');
});
