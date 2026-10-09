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
import { validateCurrent, validateHistory } from '../src/validate.js';
import { providerNavasan } from './fetch-data.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

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
  const data = JSON.parse(readFileSync(path.join(root, 'data/current.json'), 'utf8'));
  assert.ok(existsSync(path.join(PUB, 'js/refresh.js')), 'public/js/refresh.js is built');
  for (const page of listHtml(PUB)) {
    const rel = path.relative(PUB, page);
    if (rel === 'index.html' || rel === '404.html') continue; // bare redirect pages
    const html = readFileSync(page, 'utf8');
    assert.ok(html.includes('id="refresh-btn"'), `${rel}: refresh button`);
    assert.ok(html.includes(`data-t="${data.t}"`), `${rel}: data-t timestamp`);
    assert.ok(html.includes('js/refresh.js'), `${rel}: refresh.js script`);
    assert.ok(html.includes('id="i18n-refresh"'), `${rel}: refresh i18n`);
  }
});
