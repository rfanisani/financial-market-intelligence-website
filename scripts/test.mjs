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
  sma, trendSignal, normalize, correlation, compareAssets,
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
  for (const f of ['history-7d.json', 'history-30d.json']) {
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
      assert.ok(Number.isFinite(a.d) && a.name && a.src, `${lang}/${a.code}: metadata`);
    }
    assert.ok(Number.isFinite(data.w7.t0) && data.w7.dt > 0, `${lang}: 7d window timestamps`);
    assert.ok(Number.isFinite(data.w30.t0) && data.w30.dt > 0, `${lang}: 30d window timestamps`);
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

test('no secrets or development artifacts leak into the production output', () => {
  const chunks = listHtml(PUB).map((p) => readFileSync(p, 'utf8'));
  for (const f of ['js/lab.js', 'js/lab-calc.js', 'js/app.js', 'js/calc.js', 'js/refresh.js', 'css/style.css']) {
    chunks.push(readFileSync(path.join(PUB, f), 'utf8'));
  }
  const all = chunks.join('\n');
  for (const pat of [/api[_-]?key/i, /\bsecret\b/i, /\bpassword\b/i, /bearer\s+[a-z0-9._-]+/i, /\btoken\s*[:=]/i, /process\.env/i, /localhost/i, /127\.0\.0\.1/]) {
    assert.ok(!pat.test(all), `production output must not match ${pat}`);
  }
});
