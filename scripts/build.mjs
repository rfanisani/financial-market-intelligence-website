// Static site generator. Zero dependencies.
// Reads data/*.json + src/{i18n.json,assets.json,style.css,calc.js,app.js}
// and writes the complete production site into public/.
//
// Run: node scripts/build.mjs        (SITE_URL env var sets the canonical domain)
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { impliedUsd, difference, OUNCE_GRAMS } from '../src/calc.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(root, 'public');
const SITE_URL = (process.env.SITE_URL || '').replace(/\/+$/, '');
if (!SITE_URL) console.warn('[build] SITE_URL not set - canonical/OG/sitemap will use root-relative URLs');

const data = JSON.parse(readFileSync(path.join(root, 'data/current.json'), 'utf8'));
const h7 = JSON.parse(readFileSync(path.join(root, 'data/history-7d.json'), 'utf8'));
const assets = JSON.parse(readFileSync(path.join(root, 'src/assets.json'), 'utf8'));
const i18n = JSON.parse(readFileSync(path.join(root, 'src/i18n.json'), 'utf8'));

const nowAgeH = (Date.now() / 1000 - data.t) / 3600;
const isFresh = nowAgeH < 12;

// --- formatting helpers -----------------------------------------------------
const LOCALE = { fa: 'fa-IR', en: 'en-GB' };
const nfFor = (lang, d) => new Intl.NumberFormat(LOCALE[lang], { minimumFractionDigits: d, maximumFractionDigits: d });
const fmt = (v, d, lang) => nfFor(lang, d).format(v);
const fmtPct = (c, lang) => `${c > 0 ? '+' : ''}${fmt(c, 2, lang)}%`;
const fmtTime = (t, lang) =>
  new Intl.DateTimeFormat(LOCALE[lang], { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Tehran' }).format(t * 1000);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const srcName = (code, lang) => i18n.srcNames[data.s[code]]?.[lang] ?? data.s[code];
const name = (code, lang) => assets[code][lang];
const unit = (code, lang) => assets[code]['u_' + lang];

// --- asset groups -----------------------------------------------------------
const G = {
  global: ['XAU', 'XAG', 'EURUSD', 'GBPUSD', 'USDJPY', 'BRENT', 'WTI'],
  iran: ['USDIRR', 'EURIRR', 'GBPIRR', 'AU18', 'AU24', 'COIN', 'COINH', 'COINQ'],
  gold: ['XAU', 'XAG', 'AU18', 'AU24', 'COIN', 'COINH', 'COINQ'],
  fxGlobal: ['EURUSD', 'GBPUSD', 'USDJPY'],
  fxIran: ['USDIRR', 'EURIRR', 'GBPIRR'],
  oil: ['BRENT', 'WTI'],
  iranGold: ['AU18', 'AU24', 'COIN', 'COINH', 'COINQ'],
};

// --- tables -----------------------------------------------------------------
function table(codes, lang) {
  const t = i18n[lang].th;
  const rows = codes.map((code) => {
    const a = assets[code], row = data.a[code];
    const cls = row.c > 0 ? 'up' : row.c < 0 ? 'down' : 'flat';
    const arrow = row.c > 0 ? '&#9650;' : row.c < 0 ? '&#9660;' : '';
    return `<tr><td>${name(code, lang)}</td><td class="p num">${fmt(row.v, a.d, lang)}${unit(code, lang) ? ` <small class="u">${unit(code, lang)}</small>` : ''}</td><td class="num ${cls}">${arrow} ${fmtPct(row.c, lang)}</td><td class="u">${esc(srcName(code, lang))}</td></tr>`;
  }).join('');
  return `<table><thead><tr><th scope="col">${t.asset}</th><th scope="col">${t.price}</th><th scope="col">${t.change}</th><th scope="col">${t.source}</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// --- charts (inline SVG, generated at build time) ---------------------------
function chartSvg(series, label, lang = 'en') {
  const w = 560, h = 170, pad = 12;
  const all = series.flatMap((s) => s.values);
  const min = Math.min(...all), max = Math.max(...all), span = max - min || 1;
  const n = Math.max(...series.map((s) => s.values.length));
  const x = (i) => pad + (i / (n - 1)) * (w - 2 * pad);
  const y = (v) => h - pad - ((v - min) / span) * (h - 2 * pad);
  const lines = series.map((s) =>
    `<polyline fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" points="${s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}"/>`
  ).join('');
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">` +
    `<line x1="${pad}" y1="${y(max).toFixed(1)}" x2="${w - pad}" y2="${y(max).toFixed(1)}" stroke="currentColor" stroke-opacity=".12"/>` +
    `<line x1="${pad}" y1="${y(min).toFixed(1)}" x2="${w - pad}" y2="${y(min).toFixed(1)}" stroke="currentColor" stroke-opacity=".12"/>` +
    lines +
    `<text x="${pad}" y="${y(max) - 4}" font-size="10" fill="currentColor" fill-opacity=".55">${fmt(max, max < 10 ? 2 : 0, lang)}</text>` +
    `<text x="${pad}" y="${y(min) + 12}" font-size="10" fill="currentColor" fill-opacity=".55">${fmt(min, min < 10 ? 2 : 0, lang)}</text>` +
    `</svg>`;
}

const impliedSeries = () => {
  const au = h7.a.AU18, xau = h7.a.XAU;
  return au.map((v, i) => impliedUsd({ domesticPrice: v, globalOunceUsd: xau[i], purity: 0.75 }));
};

// --- implied USD section ----------------------------------------------------
function impliedSection(lang) {
  const t = i18n[lang];
  const usd = data.a.USDIRR.v;
  const i18v = impliedUsd({ domesticPrice: data.a.AU18.v, globalOunceUsd: data.a.XAU.v, purity: 0.75 });
  const iCoin = impliedUsd({ domesticPrice: data.a.COIN.v, globalOunceUsd: data.a.XAU.v, purity: 0.9, weightGrams: 8.133 });
  const row = (label, v, d) => {
    const cls = d && d.abs >= 0 ? 'up' : 'down';
    return `<tr><td>${label}</td><td class="p num">${fmt(v, 0, lang)}</td>` +
      (d ? `<td class="num ${cls}">${fmt(d.abs, 0, lang)}</td><td class="num ${cls}">${fmtPct(d.pct, lang)}</td>` : '<td>—</td><td>—</td>') + '</tr>';
  };
  return `<table><thead><tr><th scope="col">${t.th.asset}</th><th scope="col">${t.th.price}</th><th scope="col">${t.difference}</th><th scope="col">${t.diffPct}</th></tr></thead><tbody>` +
    row(t.actualUsd, usd, null) +
    row(t.impliedUsd, i18v, difference(usd, i18v)) +
    row(t.impliedCoin, iCoin, difference(usd, iCoin)) +
    `</tbody></table>
    <details><summary>${t.method}</summary><p>${t.methodNote}</p><p><code>${esc(t.methodFormula)}</code></p></details>`;
}

// --- page shell -------------------------------------------------------------
const NAV = [['', 'home'], ['gold/', 'gold'], ['currency/', 'currency'], ['oil/', 'oil'], ['iran-gold/', 'iranGold'], ['calculator/', 'calculator'], ['about/', 'about']];

function shell({ lang, slug, body, extraHead = '' }) {
  const t = i18n[lang];
  const meta = i18n.pages[slug || 'home'][lang];
  const prefix = slug ? '../../' : '../'; // root-level assets (css/js/favicon/data)
  // In-language links must stay inside /<lang>/ : from /fa/ the tabs are
  // "gold/", from /fa/gold/ they are "../gold/". Using the asset prefix here
  // broke navigation (links resolved to /gold/ -> 404 -> back to home).
  const navLink = (href) => (href === '' ? (slug ? '../' : './') : `${slug ? '../' : ''}${href}`);
  const url = `${SITE_URL}/${lang}/${slug ? slug + '/' : ''}`;
  const other = lang === 'fa' ? 'en' : 'fa';
  const switchHref = slug ? `../../${other}/${slug}/` : `../${other}/`;
  const nav = NAV.map(([href, key]) =>
    `<a href="${navLink(href)}"${key === (slug || 'home') ? ' aria-current="page"' : ''}>${t.nav[key]}</a>`).join('');
  const jsonLd = slug
    ? { '@context': 'https://schema.org', '@type': 'WebPage', name: meta.t, description: meta.d, url,
        isPartOf: { '@type': 'WebSite', name: t.siteName, url: `${SITE_URL}/` } }
    : { '@context': 'https://schema.org', '@type': 'WebSite', name: t.siteName, url, inLanguage: lang };
  return `<!doctype html><html lang="${lang}" dir="${lang === 'fa' ? 'rtl' : 'ltr'}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(meta.t)}</title><meta name="description" content="${esc(meta.d)}">
<link rel="canonical" href="${url}"><meta name="robots" content="index,follow">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(meta.t)}">
<meta property="og:description" content="${esc(meta.d)}"><meta property="og:url" content="${url}">
<meta property="og:locale" content="${lang === 'fa' ? 'fa_IR' : 'en_US'}"><meta property="og:site_name" content="${esc(t.siteName)}">
<link rel="icon" href="${prefix}favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${prefix}css/style.css">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>${extraHead}</head>
<body data-usd="${data.a.USDIRR.v}" data-t="${data.t}"><a class="skip" href="#main">${t.skip}</a>
<header><div class="wrap hbar"><a class="brand" href="${prefix}">${esc(t.siteName)}<b>.</b></a>
<nav class="main" aria-label="main">${nav}</nav><a class="lang" href="${switchHref}" hreflang="${other}" rel="alternate">${t.langOther}</a></div></header>
<main id="main" class="wrap">${body}</main>
<footer><div class="wrap">
<p>${t.lastUpdate}: <span class="num">${fmtTime(data.t, lang)}</span> · ${t.sourcesNote}</p>
<p>${esc(t.disclaimer)}</p>
<div class="refresh"><button type="button" class="btn" id="refresh-btn">${esc(t.refresh)}</button><span id="refresh-msg" role="status" aria-live="polite"></span></div>
<nav aria-label="footer"><a href="${navLink('about/')}">${t.nav.about}</a><a href="${navLink('calculator/')}">${t.nav.calculator}</a></nav>
<script type="application/json" id="i18n-refresh">${JSON.stringify({ refreshing: t.refreshing, upToDate: t.refreshUpToDate, failed: t.refreshFailed })}</script>
<script src="${prefix}js/refresh.js" defer></script>
</div></footer>
<div class="statusbar"><div class="wrap sb-in">
<span class="sb-views">${t.views}: <img class="hits" src="https://hits.sh/fanisani.ir.svg" alt="${t.viewsAlt}" height="16"></span>
<span class="sb-upd">${t.lastUpdate}: <span class="num">${fmtTime(data.t, lang)}</span></span>
</div></div></body></html>`;
}

const statusLine = (lang) => {
  const t = i18n[lang];
  return `<p class="status"><span class="dot ${isFresh ? 'ok' : 'warn'}"></span>${t.status}: ${isFresh ? t.fresh : t.stale} · ${t.lastUpdate}: <span class="num">${fmtTime(data.t, lang)}</span></p>`;
};

const card = (title, inner) => `<section class="card"><h2>${title}</h2>${inner}</section>`;
const legend = (lang, items) => `<div class="legend">${items.map(([c, k]) => `<span><i style="background:${c}"></i>${i18n[lang][k]}</span>`).join('')}</div>`;

// --- pages ------------------------------------------------------------------
function homeBody(lang) {
  const t = i18n[lang];
  const implied = impliedSeries();
  const chart = chartSvg(
    [{ values: implied, color: '#d97706' }, { values: h7.a.USDIRR, color: '#3b82f6' }],
    `${t.impliedDollar} / ${t.actualUsd}`,
    lang
  );
  const sources = [...new Set(Object.values(data.s))]
    .map((s) => i18n.srcNames[s]?.[lang] ?? s).join(' · ');
  return `<h1>${esc(t.siteName)}</h1><p class="muted">${t.homeIntro}</p>${statusLine(lang)}
  <div class="grid2">${card(t.globalMarkets, table(G.global, lang))}${card(t.iranMarkets, table(G.iran, lang))}</div>
  ${card(t.goldSection, table(G.gold, lang))}
  ${card(t.impliedDollar, impliedSection(lang))}
  ${card(t.chart7d, chart + legend(lang, [['#d97706', 'legendImplied'], ['#3b82f6', 'legendActual']]))}
  ${card(t.dataSources, `<p>${sources}</p><p class="muted">${t.secondarySource}</p><p class="muted">${t.lastUpdate}: <span class="num">${fmtTime(data.t, lang)}</span></p>`)}`;
}

function categoryBody(lang, slug, codes, chartAsset, chartColor) {
  const t = i18n[lang];
  const meta = i18n.pages[slug][lang];
  const chart = h7.a[chartAsset]
    ? card(t.chart7d, chartSvg([{ values: h7.a[chartAsset], color: chartColor }], name(chartAsset, lang), lang))
    : '';
  return `<h1>${esc(meta.t.split(' | ')[0].trim())}</h1><p class="muted">${meta.i}</p>${statusLine(lang)}
  ${card(t.th.price, table(codes, lang))}${chart}`;
}

function calculatorBody(lang) {
  const t = i18n[lang], c = t.calc;
  const inject = JSON.stringify({ ...c, toman: lang === 'fa' ? 'تومان' : 'toman', gram: lang === 'fa' ? 'گرم' : 'g' });
  const extraHead = `<script type="application/json" id="i18n-calc">${inject}</script><script type="module" src="../../js/app.js"></script>`;
  return { body: `<h1>${esc(c.title)}</h1><p class="muted">${c.intro}</p>
  <section class="card"><form id="f1">
    <div class="fgrid">
      <div><label for="domestic">${c.fDomestic}</label><input id="domestic" type="text" inputmode="decimal" value="${data.a.AU18.v}" required></div>
      <div><label for="global">${c.fGlobal}</label><input id="global" type="text" inputmode="decimal" value="${data.a.XAU.v}" required></div>
      <div><label for="purity">${c.fPurity}</label><select id="purity"><option value="k18">${c.p18}</option><option value="k24">${c.p24}</option><option value="coin">${c.pCoin}</option></select></div>
      <div><label for="weight">${c.fWeight}</label><input id="weight" type="text" inputmode="decimal" value="1"></div>
    </div>
    <button class="btn" type="submit">${c.btn}</button><div id="r1" aria-live="polite"></div>
  </form></section>
  <section class="card"><h2>${esc(c.dir2)}</h2><form id="f2">
    <div class="fgrid">
      <div><label for="rate">${c.fRate}</label><input id="rate" type="text" inputmode="decimal" value="${data.a.USDIRR.v}" required></div>
      <div><label for="global2">${c.fGlobal}</label><input id="global2" type="text" inputmode="decimal" value="${data.a.XAU.v}" required></div>
    </div>
    <button class="btn" type="submit">${c.btn}</button><div id="r2" aria-live="polite"></div>
  </form></section>`, extraHead };
}

function aboutBody(lang) {
  const a = i18n[lang].about;
  return `<h1>${esc(a.h)}</h1><section class="card"><p>${a.p1}</p><p>${a.p2}</p><p>${a.p3}</p><p><strong>${esc(i18n[lang].disclaimer)}</strong> ${a.p4.replace(/^[^:]*: /, '')}</p></section>`;
}

// --- write everything -------------------------------------------------------
mkdirSync(PUB, { recursive: true });
for (const lang of ['fa', 'en']) {
  for (const slug of ['', 'gold/', 'currency/', 'oil/', 'iran-gold/', 'calculator/', 'about/']) {
    const dir = path.join(PUB, lang, slug);
    mkdirSync(dir, { recursive: true });
    const calc = slug === 'calculator/' ? calculatorBody(lang) : null;
    const body = calc ? calc.body
      : slug === '' ? homeBody(lang)
      : slug === 'about/' ? aboutBody(lang)
      : categoryBody(lang, slug.slice(0, -1), { gold: G.gold, currency: [...G.fxGlobal, ...G.fxIran], oil: G.oil, 'iran-gold': G.iranGold }[slug.slice(0, -1)],
          { gold: 'XAU', currency: 'USDIRR', oil: 'BRENT', 'iran-gold': 'AU18' }[slug.slice(0, -1)],
          { gold: '#d97706', currency: '#16a34a', oil: '#3b82f6', 'iran-gold': '#d97706' }[slug.slice(0, -1)]);
    writeFileSync(path.join(dir, 'index.html'), shell({ lang, slug: slug.slice(0, -1), body, extraHead: calc?.extraHead }));
  }
}

// Root: language detection redirect
// Persian-first: the audience is Iranian (.ir domain), so the root always
// lands on /fa/ regardless of browser locale; English stays reachable via
// the header switcher and the noscript fallback links.
writeFileSync(path.join(PUB, 'index.html'), `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><title>رصد بازار | Market Radar</title><script>location.replace('fa/')</script><meta http-equiv="refresh" content="0;url=fa/"><link rel="canonical" href="${SITE_URL}/"></head><body><noscript><a href="fa/">فارسی</a> · <a href="en/">English</a></noscript></body></html>`);

// 404: redirect home
writeFileSync(path.join(PUB, '404.html'), `<!doctype html><html><head><meta charset="utf-8"><script>location.replace('./')</script><meta http-equiv="refresh" content="0;url=./"></head><body></body></html>`);

// Static assets
mkdirSync(path.join(PUB, 'css'), { recursive: true });
mkdirSync(path.join(PUB, 'js'), { recursive: true });
mkdirSync(path.join(PUB, 'data'), { recursive: true });
copyFileSync(path.join(root, 'src/style.css'), path.join(PUB, 'css/style.css'));
copyFileSync(path.join(root, 'src/calc.js'), path.join(PUB, 'js/calc.js'));
copyFileSync(path.join(root, 'src/app.js'), path.join(PUB, 'js/app.js'));
copyFileSync(path.join(root, 'src/refresh.js'), path.join(PUB, 'js/refresh.js'));
copyFileSync(path.join(root, 'src/favicon.svg'), path.join(PUB, 'favicon.svg'));
for (const f of ['current.json', 'history-7d.json', 'history-30d.json']) {
  copyFileSync(path.join(root, 'data', f), path.join(PUB, 'data', f));
}

writeFileSync(path.join(PUB, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE_URL || ''}/sitemap.xml\n`);
writeFileSync(path.join(PUB, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
  ['fa', 'en'].flatMap((lang) => ['', 'gold/', 'currency/', 'oil/', 'iran-gold/', 'calculator/', 'about/']
    .map((s) => `<url><loc>${SITE_URL}/${lang}/${s}</loc><lastmod>${new Date(data.t * 1000).toISOString()}</lastmod></url>`)).join('') +
  `</urlset>\n`);

// --- final size audit -------------------------------------------------------
function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const files = walk(PUB);
const byExt = {};
let total = 0;
for (const f of files) {
  const size = statSync(f).size;
  const ext = path.extname(f) || '(none)';
  byExt[ext] = (byExt[ext] || 0) + size;
  total += size;
}
console.log('\n=== Final Size Audit ===');
for (const [ext, size] of Object.entries(byExt).sort((a, b) => b[1] - a[1])) {
  console.log(`${ext.padEnd(8)} ${(size / 1024).toFixed(1)} KB`);
}
console.log(`${'TOTAL'.padEnd(8)} ${(total / 1024).toFixed(1)} KB  (${files.length} files)`);
const LIMIT = 1024 * 1024, WARN = 768 * 1024;
if (total > LIMIT) { console.log('RESULT: FAIL (> 1 MB)'); process.exit(1); }
console.log(`RESULT: PASS${total > WARN ? ' (warning: > 750 KB)' : ' (target < 700 KB)'}`);
