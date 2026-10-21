// Static site generator. Zero dependencies.
// Reads data/*.json + src/{i18n.json,assets.json,style.css,calc.js,app.js}
// and writes the complete production site into public/.
//
// Run: node scripts/build.mjs        (SITE_URL env var sets the canonical domain)
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { impliedUsd, difference, OUNCE_GRAMS, usdRelationFit, relationSignal, relationBacktest } from '../src/calc.js';
import { volatility, maxDrawdown, trendSignal } from '../src/lab-calc.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(root, 'public');
const SITE_URL = (() => {
  // Absolute URLs are required for canonical/hreflang/sitemap. Fall back to the custom domain in CNAME.
  let base = process.env.SITE_URL || '';
  if (!base && existsSync(path.join(root, 'CNAME'))) base = `https://${readFileSync(path.join(root, 'CNAME'), 'utf8').trim()}`;
  return base.replace(/\/+$/, '');
})();
if (!SITE_URL) console.warn('[build] SITE_URL not set and no CNAME - canonical/OG/sitemap will use root-relative URLs');

const data = JSON.parse(readFileSync(path.join(root, 'data/current.json'), 'utf8'));
const h7 = JSON.parse(readFileSync(path.join(root, 'data/history-7d.json'), 'utf8'));
const h30 = JSON.parse(readFileSync(path.join(root, 'data/history-30d.json'), 'utf8'));
const h1y = JSON.parse(readFileSync(path.join(root, 'data/history-1y.json'), 'utf8'));
const assets = JSON.parse(readFileSync(path.join(root, 'src/assets.json'), 'utf8'));
// Homepage strip (1-day / 1-week change). Written by scripts/fetch-data.mjs.
const ticker = (() => { try { return JSON.parse(readFileSync(path.join(root, 'data/ticker.json'), 'utf8')); } catch { return { items: {} }; } })();
// Market pages: one-year daily history per market (data/market-history.json, written by fetch-data).
const MARKETS = JSON.parse(readFileSync(path.join(root, 'src/markets.json'), 'utf8'));
const mhist = (() => { try { return JSON.parse(readFileSync(path.join(root, 'data/market-history.json'), 'utf8')); } catch { return { markets: {} }; } })();
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
    return `<tr data-code="${code}" data-v="${row.v}" data-d="${a.d}"><td>${name(code, lang)}</td><td class="p num">${fmt(row.v, a.d, lang)}${unit(code, lang) ? ` <small class="u">${unit(code, lang)}</small>` : ''}</td><td class="num ${cls}">${arrow} ${fmtPct(row.c, lang)}</td><td class="u">${esc(srcName(code, lang))}</td></tr>`;
  }).join('');
  return `<div class="tw"><table><thead><tr><th scope="col">${t.asset}</th><th scope="col">${t.price}</th><th scope="col">${t.change}</th><th scope="col">${t.source}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// --- charts (inline SVG, generated at build time) ---------------------------
function chartSvg(series, label, lang = 'en') {
  const w = 560, h = 170, pad = 12;
  const all = series.flatMap((s) => s.values).filter(Number.isFinite);
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

function trendCard({ title, periods, lang, legendHtml = '' }) {
  const tabs = periods.map((p, i) =>
    `<button type="button" class="trend-tab${i === 0 ? ' active' : ''}" role="tab" aria-selected="${i === 0 ? 'true' : 'false'}" data-period="${p.id}">${esc(p.label)}</button>`
  ).join('');
  const panels = periods.map((p, i) =>
    `<div class="trend-panel" data-panel="${p.id}" role="tabpanel"${i === 0 ? '' : ' hidden'}>${p.svg}</div>`
  ).join('');
  return `<section class="card trend-card">
    <div class="trend-header">
      <h2>${esc(title)}</h2>
      <div class="trend-tabs" role="tablist">${tabs}</div>
    </div>
    ${panels}
    ${legendHtml}
  </section>`;
}

const impliedSeries = (h = h7) => {
  const au = h.a.AU18, xau = h.a.XAU;
  return au.map((v, i) => impliedUsd({ domesticPrice: v, globalOunceUsd: xau[i], purity: 0.75 }));
};

// --- USD relation & signal ---------------------------------------------------
// Daily coin quotes from market history, carried forward over days without one.
const coinByDate = new Map(mhist.markets?.coin ?? []);
const dateAt = (h, i) => new Date((h.t0 + i * h.dt) * 1000).toISOString().slice(0, 10);
function coinSeries(h) {
  let last = null;
  return h.a.XAU.map((_, i) => {
    const c = coinByDate.get(dateAt(h, i));
    if (Number.isFinite(c)) last = c;
    return last;
  });
}
const impliedCoinSeries = (h = h7) => {
  const coin = coinSeries(h);
  return h.a.XAU.map((xau, i) => impliedUsd({ domesticPrice: coin[i], globalOunceUsd: xau, purity: 0.9, weightGrams: 8.133 }));
};
// Fit on one year of days that have a real coin quote (no carried-forward days).
function relationSamples() {
  const coin = coinSeries(h1y);
  const rows = [];
  h1y.a.XAU.forEach((xau, i) => {
    const d = dateAt(h1y, i);
    if (!coinByDate.has(d)) return;
    rows.push({
      d,
      usd: h1y.a.USDIRR[i],
      i18: impliedUsd({ domesticPrice: h1y.a.AU18[i], globalOunceUsd: xau, purity: 0.75 }),
      icoin: impliedUsd({ domesticPrice: coin[i], globalOunceUsd: xau, purity: 0.9, weightGrams: 8.133 }),
    });
  });
  return rows;
}
const REL_SAMPLES = relationSamples();
const REL = usdRelationFit(REL_SAMPLES);
const REL_BT = relationBacktest(REL_SAMPLES, 5, 120);

function relationBlock(lang, usd, i18v, iCoin) {
  const t = i18n[lang];
  const cur = REL ? relationSignal(REL, { usd, i18: i18v, icoin: iCoin }) : null;
  if (!REL || !cur) return `<div class="rel"><p class="muted">${esc(t.relUnavailable)}</p></div>`;
  const [a, c, k] = REL.coef;
  const formula = t.relFormula
    .replace('{a}', fmt(a, 4, lang))
    .replace('{b}', fmt(c, 4, lang))
    .replace('{k}', `${k < 0 ? '−' : '+'} ${fmt(Math.abs(k), 0, lang)}`);
  const bt = REL_BT.rate == null ? '' :
    `<p class="muted">${esc(t.relBacktest.replace('{rate}', fmt(REL_BT.rate, 0, lang)).replace('{hits}', fmt(REL_BT.hits, 0, lang)).replace('{total}', fmt(REL_BT.total, 0, lang)))} ${esc(t.relBacktestNote)}</p>`;
  const sigText = { sell: t.relSell, buy: t.relBuy, none: t.relNone }[cur.signal];
  return `<div class="rel" data-rel-a="${a.toPrecision(12)}" data-rel-c="${c.toPrecision(12)}" data-rel-k="${k.toPrecision(12)}" data-rel-sd="${REL.sd.toPrecision(12)}" data-lbl-sell="${esc(t.relSell)}" data-lbl-buy="${esc(t.relBuy)}" data-lbl-none="${esc(t.relNone)}" data-lbl-strong="${esc(t.relStrong)}" data-lbl-weak="${esc(t.relWeak)}">
      <h3>${esc(t.relTitle)}</h3>
      <dl class="kv">
        <dt>${esc(t.relFair)}</dt><dd class="num"><span data-rel="fair">${fmt(cur.fair, 0, lang)}</span></dd>
        <dt>${esc(t.relDev)}</dt><dd class="num"><span data-rel="dev">${fmtPct(cur.devPct, lang)}</span> <small>(z <span data-rel="z">${fmt(cur.z, 2, lang)}</span>)</small></dd>
        <dt>${esc(t.relSignal)}</dt><dd><strong data-rel="sig" data-sig="${cur.signal}">${esc(sigText)}</strong> <small data-rel="strength">${esc(cur.strong ? t.relStrong : t.relWeak)}</small></dd>
      </dl>
      <p class="muted">${esc(formula)}</p>
      <p class="muted">${esc(t.relNote)}</p>
      ${bt}
    </div>`;
}

// --- implied USD section ----------------------------------------------------
function impliedSection(lang) {
  const t = i18n[lang];
  const usd = data.a.USDIRR.v;
  const i18v = impliedUsd({ domesticPrice: data.a.AU18.v, globalOunceUsd: data.a.XAU.v, purity: 0.75 });
  const iCoin = impliedUsd({ domesticPrice: data.a.COIN.v, globalOunceUsd: data.a.XAU.v, purity: 0.9, weightGrams: 8.133 });
  const row = (key, label, v, d) => {
    const cls = d && d.abs >= 0 ? 'up' : 'down';
    return `<tr data-implied="${key}"><td>${label}</td><td class="p num" data-col="v">${fmt(v, 0, lang)}</td>` +
      (d ? `<td class="num ${cls}" data-col="abs">${fmt(d.abs, 0, lang)}</td><td class="num ${cls}" data-col="pct">${fmtPct(d.pct, lang)}</td>` : '<td data-col="abs">—</td><td data-col="pct">—</td>') + '</tr>';
  };
  return `<div class="tw"><table><thead><tr><th scope="col">${t.th.asset}</th><th scope="col">${t.th.price}</th><th scope="col">${t.difference}</th><th scope="col">${t.diffPct}</th></tr></thead><tbody>` +
    row('actual', t.actualUsd, usd, null) +
    row('ai18', t.impliedUsd, i18v, difference(usd, i18v)) +
    row('icoin', t.impliedCoin, iCoin, difference(usd, iCoin)) +
    `</tbody></table></div>${relationBlock(lang, usd, i18v, iCoin)}
    <details><summary>${t.method}</summary><p>${t.methodNote}</p><p><code>${esc(t.methodFormula)}</code></p></details>`;
}

// --- page shell -------------------------------------------------------------
const NAV = [['', 'home'], ['trade/', 'trade'], ['gold/', 'gold'], ['currency/', 'currency'], ['oil/', 'oil'], ['iran-gold/', 'iranGold'], ['lab/', 'lab'], ['calculator/', 'calculator'], ['about/', 'about']];

function shell({ lang, slug, body, extraHead = '' }) {
  const t = i18n[lang];
  const meta = i18n.pages[slug || 'home'][lang];
  const depth = slug ? slug.split('/').length : 0; // directory levels below /<lang>/
  const prefix = '../'.repeat(depth + 1); // root-level assets (css/js/favicon/data)
  // In-language links must stay inside /<lang>/ : from /fa/ the tabs are
  // "gold/", from /fa/gold/ they are "../gold/". Using the asset prefix here
  // broke navigation (links resolved to /gold/ -> 404 -> back to home).
  const up = '../'.repeat(depth);
  const navLink = (href) => (href === '' ? (depth ? up : './') : `${up}${href}`);
  const url = `${SITE_URL}/${lang}/${slug ? slug + '/' : ''}`;
  const other = lang === 'fa' ? 'en' : 'fa';
  const switchHref = `${'../'.repeat(depth + 1)}${other}/${slug ? slug + '/' : ''}`;
  const nav = NAV.map(([href, key]) =>
    `<a href="${navLink(href)}"${key === (slug || 'home') ? ' aria-current="page"' : ''}>${t.nav[key]}</a>`).join('');
  const altUrl = (l) => `${SITE_URL}/${l}/${slug ? slug + '/' : ''}`;
  const hreflang = `<link rel="alternate" hreflang="en" href="${altUrl('en')}"><link rel="alternate" hreflang="fa" href="${altUrl('fa')}"><link rel="alternate" hreflang="x-default" href="${altUrl('en')}">`;
  const crumbs = slug
    ? [{ name: t.siteName, url: `${SITE_URL}/${lang}/` }, { name: meta.t.split(' | ')[0].trim(), url }]
    : null;
  const jsonLd = slug
    ? [{ '@context': 'https://schema.org', '@type': 'WebPage', name: meta.t, description: meta.d, url,
          inLanguage: lang, isPartOf: { '@type': 'WebSite', name: t.siteName, url: `${SITE_URL}/` } },
       { '@context': 'https://schema.org', '@type': 'BreadcrumbList',
          itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: c.url })) }]
    : { '@context': 'https://schema.org', '@type': 'WebSite', name: t.siteName, url, inLanguage: lang };
  return `<!doctype html><html lang="${lang}" dir="${lang === 'fa' ? 'rtl' : 'ltr'}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(meta.t)}</title><meta name="description" content="${esc(meta.d)}">
<link rel="canonical" href="${url}">${hreflang}<meta name="robots" content="index,follow">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(meta.t)}">
<meta property="og:description" content="${esc(meta.d)}"><meta property="og:url" content="${url}">
<meta property="og:locale" content="${lang === 'fa' ? 'fa_IR' : 'en_US'}"><meta property="og:site_name" content="${esc(t.siteName)}">
<link rel="preconnect" href="https://api.tgju.org" crossorigin><link rel="preconnect" href="https://www.navasan.tech" crossorigin><link rel="preconnect" href="https://api.gold-api.com" crossorigin><link rel="preconnect" href="https://api.frankfurter.dev" crossorigin>
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
<script type="application/json" id="i18n-refresh">${JSON.stringify({ refreshing: t.refreshing, upToDate: t.refreshUpToDate, failed: t.refreshFailed, fastUpdated: t.refreshFastUpdated, partial: t.refreshPartial, fresh: t.fresh, stale: t.stale, staleTile: t.tkStaleTitle, liveAt: t.tkLiveAt, lastAt: t.tkLastAt, noTime: t.tkNoTime, srcNames: i18n.srcNames })}</script>
<script src="${prefix}js/trend.js" defer></script>
<script type="module" src="${prefix}js/refresh.js"></script>
<script type="module" src="${prefix}js/live.js"></script>
</div></footer>
<div class="statusbar"><div class="wrap sb-in">
<span class="sb-views">${t.views}: <img class="hits" src="https://hits.sh/fanisani.ir.svg" alt="${t.viewsAlt}" height="16"></span>
<span class="sb-upd">${t.lastUpdate}: <span class="num">${fmtTime(data.t, lang)}</span></span>
</div></div></body></html>`;
}

const statusLine = (lang) => {
  const t = i18n[lang];
  return `<p class="status"><span class="dot ${isFresh ? 'ok' : 'warn'}"></span>${t.status}: <span class="st-label">${isFresh ? t.fresh : t.stale}</span> · ${t.lastUpdate}: <span class="num">${fmtTime(data.t, lang)}</span></p>`;
};

const card = (title, inner) => `<section class="card"><h2>${title}</h2>${inner}</section>`;
const legend = (lang, items) => `<div class="legend">${items.map(([c, k]) => `<span><i style="background:${c}"></i>${i18n[lang][k]}</span>`).join('')}</div>`;

// --- pages ------------------------------------------------------------------
// Homepage strip: [code, label key or asset name, unit, decimals]. The value is the
// same one the table shows (data.a), so first paint matches the live update.
const TICK = [
  ['XAU', null], ['BRENT', null], ['USDIRR', null], ['COIN', null],
  ['TEDPIX', 'tkTedpix', '', 0], ['NASDAQ', 'tkNasdaq', '', 2],
];

function tickerCard(lang) {
  const t = i18n[lang];
  const cls = (x) => (x > 0 ? 'up' : x < 0 ? 'down' : 'flat');
  const arrow = (x) => (x > 0 ? '&#9650;' : x < 0 ? '&#9660;' : '');
  const day = (d) => new Intl.DateTimeFormat(LOCALE[lang], { day: 'numeric', month: 'short' }).format(new Date(`${d}T12:00:00Z`));
  const chg = (x, key) => (Number.isFinite(x)
    ? `<span class="num ${cls(x)}" data-${key}>${arrow(x)} ${fmtPct(x, lang)}</span>`
    : `<span class="num" data-${key}>—</span>`);
  const cards = TICK.map(([code, labelKey, u, dec]) => {
    const it = ticker.items?.[code] ?? {};
    const isAsset = Boolean(assets[code]);
    const label = isAsset ? assets[code][lang] : t[labelKey];
    const unitTxt = isAsset ? (assets[code]['u_' + lang] ?? '') : u;
    const d = isAsset ? assets[code].d : dec;
    const v = Number.isFinite(data.a[code]?.v) ? data.a[code].v : it.v;
    const asOf = it.d ? `<span data-asof data-label="${esc(t.tkAsOf)}">${esc(t.tkAsOf)} ${esc(day(it.d))}</span>` : '<span data-asof data-label=""></span>';
    const slugOf = MARKETS.find((m) => m.code === code)?.slug;
    return `<a class="tick" href="markets/${slugOf}/" data-tick="${code}" data-d="${d}" data-v="${Number.isFinite(v) ? v : ''}" data-bt="${data.t * 1000}">` +
      `<div class="tk-name">${esc(label)}</div>` +
      `<div class="tk-v num"><span data-tv>${Number.isFinite(v) ? fmt(v, d, lang) : '—'}</span>${unitTxt ? ` <small class="u">${esc(unitTxt)}</small>` : ''}</div>` +
      `<div class="tk-ch"><span class="tk-l">${t.tick1d}</span>${chg(it.c, 'c')}</div>` +
      `<div class="tk-ch"><span class="tk-l">${t.tick1w}</span>${chg(it.w, 'w')}</div>` +
      `<div class="tk-src">${asOf}</div>` +
      `</a>`;
  }).join('');
  return card(t.tickerTitle, `<div class="tick-grid">${cards}</div><p class="ticker-note">${esc(t.tickNote)}</p><p class="ticker-note">${esc(t.tkStaleNote)}</p>`);
}

function homeBody(lang) {
  const t = i18n[lang];
  const trend = trendCard({
    title: t.trendCharts,
    lang,
    periods: [
      {
        id: '7d',
        label: t.pWeek,
        svg: chartSvg(
          [{ values: impliedSeries(h7), color: '#d97706' }, { values: h7.a.USDIRR, color: '#3b82f6' }, { values: impliedCoinSeries(h7), color: '#16a34a' }],
          `${t.impliedDollar} / ${t.actualUsd} (${t.pWeek})`,
          lang
        ),
      },
      {
        id: '30d',
        label: t.pMonth,
        svg: chartSvg(
          [{ values: impliedSeries(h30), color: '#d97706' }, { values: h30.a.USDIRR, color: '#3b82f6' }, { values: impliedCoinSeries(h30), color: '#16a34a' }],
          `${t.impliedDollar} / ${t.actualUsd} (${t.pMonth})`,
          lang
        ),
      },
      {
        id: '1y',
        label: t.pYear,
        svg: chartSvg(
          [{ values: impliedSeries(h1y), color: '#d97706' }, { values: h1y.a.USDIRR, color: '#3b82f6' }, { values: impliedCoinSeries(h1y), color: '#16a34a' }],
          `${t.impliedDollar} / ${t.actualUsd} (${t.pYear})`,
          lang
        ),
      },
    ],
    legendHtml: legend(lang, [['#d97706', 'legendImplied'], ['#3b82f6', 'legendActual'], ['#16a34a', 'legendImpliedCoin']]),
  });
  const sources = [...new Set(Object.values(data.s))]
    .map((s) => i18n.srcNames[s]?.[lang] ?? s).join(' · ');
  return `<h1>${esc(t.siteName)}</h1><p class="muted">${t.homeIntro}</p>${statusLine(lang)}
  ${tickerCard(lang)}
  <div class="grid2">${card(t.globalMarkets, table(G.global, lang))}${card(t.iranMarkets, table(G.iran, lang))}</div>
  ${card(t.goldSection, table(G.gold, lang))}
  ${card(t.impliedDollar, impliedSection(lang))}
  ${trend}
  ${card(t.dataSources, `<p>${sources}</p><p class="muted">${t.secondarySource}</p><p class="muted">${t.lastUpdate}: <span class="num">${fmtTime(data.t, lang)}</span></p>`)}`;
}

function categoryBody(lang, slug, codes, chartAsset, chartColor) {
  const t = i18n[lang];
  const meta = i18n.pages[slug][lang];
  const hasHistory = h7.a[chartAsset] && h30.a[chartAsset] && h1y.a[chartAsset];
  const trend = hasHistory
    ? trendCard({
        title: `${name(chartAsset, lang)} — ${t.trendTitle}`,
        lang,
        periods: [
          {
            id: '7d',
            label: t.pWeek,
            svg: chartSvg([{ values: h7.a[chartAsset], color: chartColor }], `${name(chartAsset, lang)} (${t.pWeek})`, lang),
          },
          {
            id: '30d',
            label: t.pMonth,
            svg: chartSvg([{ values: h30.a[chartAsset], color: chartColor }], `${name(chartAsset, lang)} (${t.pMonth})`, lang),
          },
          {
            id: '1y',
            label: t.pYear,
            svg: chartSvg([{ values: h1y.a[chartAsset], color: chartColor }], `${name(chartAsset, lang)} (${t.pYear})`, lang),
          },
        ],
      })
    : '';
  return `<h1>${esc(meta.t.split(' | ')[0].trim())}</h1><p class="muted">${meta.i}</p>${statusLine(lang)}
  ${card(t.th.price, table(codes, lang))}${trend}`;
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

// --- Gold buy / sell --------------------------------------------------------
// Price per gram in toman for purities 500..1000 (1000 = 24K, 750 = 18K), from the
// ounce price and the USD rate (both editable; live values fill them in the browser).
// Buy: value + seller wage. Sell: value minus the shop deduction (0-10 %).
function tradeBody(lang) {
  const t = i18n[lang], c = t.trade;
  const xau = data.a.XAU.v, usd = data.a.USDIRR.v;
  const inject = JSON.stringify({ ...c, karat: c.karat, toman: c.toman, gram: c.gram });
  const extraHead = `<script type="application/json" id="i18n-trade">${inject}</script><script type="module" src="../../js/trade.js"></script>`;
  const presets = [1000, 990, 916, 900, 875, 750, 700, 585, 500].map((p) => `<option value="${p}">`).join('');
  return { extraHead, body: `<div class="trade-page"><h1>${esc(c.title)}</h1><p class="muted">${c.intro}</p>
  <section class="card" id="trade-params" data-xau="${xau}" data-usd="${usd}">
    <div class="fgrid">
      <div><label for="purity">${c.fPurity}</label><input id="purity" type="text" inputmode="numeric" value="750" list="purity-list" autocomplete="off"><datalist id="purity-list">${presets}</datalist><small class="muted" id="karat"></small></div>
      <div><label for="ounce">${c.fOunce}</label><input id="ounce" type="text" inputmode="decimal" value="${xau}"></div>
      <div><label for="usd">${c.fUsd}</label><input id="usd" type="text" inputmode="decimal" value="${usd}"></div>
    </div>
    <button class="btn" type="button" id="useLive">${c.useLive}</button>
    <div class="result"><div>${esc(c.perGram)}: <b class="num" id="pg">—</b> ${esc(c.toman)}</div><div class="sub" id="srcLine"></div></div>
    <p class="muted">${esc(c.formula)}</p>
    <div class="error" id="perr" role="alert"></div>
  </section>
  <div class="trade-grid">
    <section class="card"><h2>${esc(c.buyTitle)}</h2>
      <div class="fgrid">
        <div><label for="bGrams">${c.fGrams}</label><input id="bGrams" type="text" inputmode="decimal" value="1"></div>
        <div><label for="wage">${c.fWage}</label><input id="wage" type="text" inputmode="decimal" value="0"></div>
      </div>
      <dl class="kv" id="buyOut" aria-live="polite"></dl><div class="error" id="buyErr" role="alert"></div>
    </section>
    <section class="card"><h2>${esc(c.sellTitle)}</h2>
      <div class="fgrid">
        <div><label for="sGrams">${c.fGramsSell}</label><input id="sGrams" type="text" inputmode="decimal" value="1"></div>
        <div><label for="fee">${c.fFee}</label><input id="fee" type="text" inputmode="decimal" value="0"></div>
      </div>
      <dl class="kv" id="sellOut" aria-live="polite"></dl><div class="error" id="sellErr" role="alert"></div>
    </section>
  </div></div>` };
}

// --- Financial Intelligence Lab ----------------------------------------------
// Interactive analysis over the published daily history snapshots. The heavy
// lifting happens in the browser (public/js/lab.js + lab-calc.js); the build
// only renders the controls and embeds the data + localized strings as JSON.
const LAB_ASSETS = ['XAU', 'XAG', 'BRENT', 'WTI', 'USDIRR', 'AU18'];

function labBody(lang) {
  const L = i18n[lang].lab;
  const labAssets = LAB_ASSETS
    .filter((code) => Array.isArray(h7.a[code]) && Array.isArray(h30.a[code]) && Array.isArray(h1y.a[code]) && assets[code])
    .map((code) => ({
      code,
      name: name(code, lang),
      unit: unit(code, lang),
      d: assets[code].d,
      src: srcName(code, lang),
      s7: h7.a[code],
      s30: h30.a[code],
      s365: h1y.a[code],
    }));
  const labData = JSON.stringify({
    lang,
    assets: labAssets,
    w7: { t0: h7.t0, dt: h7.dt },
    w30: { t0: h30.t0, dt: h30.dt },
    w365: { t0: h1y.t0, dt: h1y.dt },
  });
  const opts = labAssets.map((a) => `<option value="${a.code}">${esc(a.name)}</option>`).join('');
  const tools = [['return', L.tReturn], ['risk', L.tRisk], ['trend', L.tTrend], ['signal', L.tSignal], ['compare', L.tCompare]]
    .map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
  const extraHead =
    `<script type="application/json" id="i18n-lab">${JSON.stringify(L)}</script>` +
    `<script type="application/json" id="lab-data">${labData}</script>` +
    `<script type="module" src="../../js/lab.js"></script>`;
  const body = `<h1>${esc(L.title)}</h1><p class="muted">${esc(L.intro)}</p>${statusLine(lang)}
  <section class="card"><form id="lab-form">
    <div class="fgrid">
      <div><label for="lab-tool">${esc(L.tool)}</label><select id="lab-tool">${tools}</select></div>
      <div><label for="lab-window">${esc(L.window)}</label><select id="lab-window"><option value="7">${esc(L.window7)}</option><option value="30">${esc(L.window30)}</option><option value="365">${esc(L.window365)}</option></select></div>
      <div id="lab-f-asset"><label for="lab-asset">${esc(L.asset)}</label><select id="lab-asset">${opts}</select></div>
      <div id="lab-f-asset-a" hidden><label for="lab-asset-a">${esc(L.assetA)}</label><select id="lab-asset-a">${opts}</select></div>
      <div id="lab-f-asset-b" hidden><label for="lab-asset-b">${esc(L.assetB)}</label><select id="lab-asset-b">${opts}</select></div>
      <div id="lab-f-ma" hidden><label for="lab-ma">${esc(L.maWindow)}</label><input id="lab-ma" type="number" min="2" max="200" step="1" value="7"></div>
    </div>
    <button class="btn" type="submit" id="lab-run">${esc(L.run)}</button>
    <div id="lab-result" aria-live="polite"><p class="muted">${esc(L.empty)}</p></div>
    <noscript><p class="error">${esc(L.noJs)}</p></noscript>
  </form></section>
  ${card(L.method, `<p><code>${esc(L.mReturn)}</code></p><p><code>${esc(L.mVol)}</code></p><p><code>${esc(L.mDd)}</code></p><p><code>${esc(L.mSma)}</code></p><p><code>${esc(L.mCorr)}</code></p>`)}
  ${card(L.dataCard, `<p>${esc(L.dataNote)}</p><p class="muted">${esc(L.shortWindow)}</p><p class="muted"><strong>${esc(i18n[lang].disclaimer)}</strong> ${esc(L.notAdvice)}</p>`)}`;
  return { body, extraHead };
}

// --- market pages (one per homepage card) -----------------------------------
const MK_RANGES = [['7', 'mkR7'], ['30', 'mkR30'], ['90', 'mkR90'], ['365', 'mkR365']];
const MK_DEFAULT = '30';
const shiftDay = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const sliceRange = (series, days) => (series?.length ? series.filter(([d]) => d >= shiftDay(series.at(-1)[0], -days)) : []);
const pctOf = (now, before) => ((now - before) / before) * 100;
const dayLabel = (ymd, lang) => new Intl.DateTimeFormat(LOCALE[lang], { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${ymd}T12:00:00Z`));

function marketStats(pts) {
  if (pts.length < 2) return null;
  const vals = pts.map((p) => p[1]);
  return { last: vals.at(-1), change: pctOf(vals.at(-1), vals[0]), high: Math.max(...vals), low: Math.min(...vals), n: vals.length };
}

// Static chart for the default range (the browser redraws it for other ranges).
// Only the line lives in the SVG (scaled to any width); axis labels are HTML so
// they keep a readable font size on phones. The block is LTR so the date order
// matches the line in both languages.
function marketChart(pts, d, lang, label) {
  if (pts.length < 2) return `<p class="muted">${esc(i18n[lang].mkNoData)}</p>`;
  const W = 640, H = 240, PT = 12, PB = 12;
  const vals = pts.map((p) => p[1]);
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const x = (i) => (i / (pts.length - 1)) * W;
  const y = (v) => PT + (1 - (v - min) / span) * (H - PT - PB);
  const line = pts.map(([, v], i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return `<div class="mk-chart-wrap" dir="ltr">` +
    `<div class="mk-yl"><span>${fmt(max, d, lang)}</span><span>${fmt(min, d, lang)}</span></div>` +
    `<svg class="mk-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">` +
    `<polyline fill="none" stroke="#d97706" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke" points="${line}"/></svg>` +
    `</div>` +
    `<div class="mk-xl" dir="ltr"><span>${esc(dayLabel(pts[0][0], lang))}</span><span>${esc(dayLabel(pts.at(-1)[0], lang))}</span></div>`;
}

function marketStatsHtml(st, d, unitTxt, lang) {
  const t = i18n[lang];
  if (!st) return '';
  const chg = `<span class="num ${st.change > 0 ? 'up' : st.change < 0 ? 'down' : 'flat'}">${fmtPct(st.change, lang)}</span>`;
  return `<dt>${esc(t.mkStatLast)}</dt><dd class="num">${fmt(st.last, d, lang)}${unitTxt ? ` <small class="u">${esc(unitTxt)}</small>` : ''}</dd>` +
    `<dt>${esc(t.mkStatChange)}</dt><dd>${chg}</dd>` +
    `<dt>${esc(t.mkStatHigh)}</dt><dd class="num">${fmt(st.high, d, lang)}</dd>` +
    `<dt>${esc(t.mkStatLow)}</dt><dd class="num">${fmt(st.low, d, lang)}</dd>` +
    `<dt>${esc(t.mkStatPoints)}</dt><dd class="num">${st.n}</dd>`;
}

function marketBody(lang, m) {
  const t = i18n[lang];
  const isAsset = Boolean(assets[m.code]);
  const name = isAsset ? assets[m.code][lang] : t[m.name];
  const unitTxt = isAsset ? (assets[m.code]['u_' + lang] ?? '') : '';
  const d = m.d;
  const series = mhist.markets?.[m.slug] ?? [];
  const pts = sliceRange(series, Number(MK_DEFAULT));
  const st = marketStats(pts);
  const it = ticker.items?.[m.code] ?? {};
  const tableV = data.a[m.code]?.v;
  const v = Number.isFinite(tableV) ? tableV : (Number.isFinite(it.v) ? it.v : st?.last);
  const cls = (x) => (x > 0 ? 'up' : x < 0 ? 'down' : 'flat');
  const arrow = (x) => (x > 0 ? '&#9650;' : x < 0 ? '&#9660;' : '');
  const chg = (x, key) => (Number.isFinite(x)
    ? `<span class="num ${cls(x)}" data-${key}>${arrow(x)} ${fmtPct(x, lang)}</span>`
    : `<span class="num" data-${key}>—</span>`);
  const asOf = it.d ? `<span data-asof data-label="${esc(t.tkAsOf)}">${esc(t.tkAsOf)} ${esc(dayLabel(it.d, lang))}</span>` : '<span data-asof data-label=""></span>';
  const head = `<div class="tick mk-head" data-tick="${m.code}" data-d="${d}" data-v="${Number.isFinite(v) ? v : ''}" data-bt="${data.t * 1000}">` +
    `<div class="tk-name">${esc(name)}</div>` +
    `<div class="tk-v num"><span data-tv>${Number.isFinite(v) ? fmt(v, d, lang) : '—'}</span>${unitTxt ? ` <small class="u">${esc(unitTxt)}</small>` : ''}</div>` +
    `<div class="tk-ch"><span class="tk-l">${t.tick1d}</span>${chg(it.c, 'c')}</div>` +
    `<div class="tk-ch"><span class="tk-l">${t.tick1w}</span>${chg(it.w, 'w')}</div>` +
    `<div class="tk-src">${asOf}</div></div>`;

  const labels = {
    ranges: Object.fromEntries(MK_RANGES.map(([days, key]) => [days, t[key]])),
    statLast: t.mkStatLast, statChange: t.mkStatChange, statHigh: t.mkStatHigh, statLow: t.mkStatLow, statPoints: t.mkStatPoints,
    live: t.mkLive, build: t.mkBuild, liveFail: t.mkLiveFail, nasdaq: t.mkNasdaqNote, noData: t.mkNoData,
    up: 'up', down: 'down',
  };
  const payload = {
    slug: m.slug, code: m.code, tgju: m.tgju, scale: m.scale, d, unit: unitTxt,
    locale: LOCALE[lang], defaultRange: Number(MK_DEFAULT), series, labels,
  };
  const statusText = m.tgju ? t.mkBuild : t.mkNasdaqNote;
  const body = `<p class="mk-back"><a href="../../">← ${esc(t.mkBack)}</a></p>` +
    `<h1>${esc(name)}</h1>${head}` +
    `<section class="card mk" aria-labelledby="mk-h"><h2 id="mk-h">${esc(t.mkChart)}</h2>` +
    `<div class="mk-range" role="group" aria-label="${esc(t.mkRange)}">` +
    MK_RANGES.map(([days, key]) => `<button type="button" class="mk-btn" data-range="${days}" aria-pressed="${days === MK_DEFAULT}">${esc(t[key])}</button>`).join('') +
    `</div>` +
    `<div id="mk-chart">${marketChart(pts, d, lang, `${name} — ${t.mkChart}`)}</div>` +
    `<p class="mk-status muted" id="mk-status" role="status">${esc(statusText)}</p>` +
    `<dl class="kv" id="mk-stats">${marketStatsHtml(st, d, unitTxt, lang)}</dl>` +
    `<noscript><p class="muted">${esc(t.mkNoJs)}</p></noscript>` +
    `</section>` +
    `<script type="application/json" id="mk-data">${JSON.stringify(payload).replace(/</g, '\\u003c')}</script>` +
    marketSectionHtml(lang, m) +
    card(t.mkAbout, `<p>${esc(t.mkNote)}</p><p class="muted"><strong>${esc(t.disclaimer)}</strong></p>`);
  return { body, extraHead: `<script type="module" src="${'../'.repeat(3)}js/market.js"></script>` };
}

// --- market page: full section content ------------------------------------
// Gold, oil, currency and coin tiles embed the same body as their section page
// (its H1 is lowered to H3 so the page keeps a single H1). Tedpix and Nasdaq have
// no section page, so they get an information block computed from the stored history.
const SECTION_FOR = {
  'gold-oz': ['gold', () => G.gold, 'XAU', '#d97706'],
  brent: ['oil', () => G.oil, 'BRENT', '#3b82f6'],
  usd: ['currency', () => [...G.fxGlobal, ...G.fxIran], 'USDIRR', '#16a34a'],
  coin: ['iran-gold', () => G.iranGold, 'AU18', '#d97706'],
};

function indexInfoBody(lang, m) {
  const t = i18n[lang];
  const series = mhist.markets?.[m.slug] ?? [];
  if (series.length < 3) return card(t.idxTitle, `<p class="muted">${esc(t.mkNoData)}</p>`);
  const vals = series.map((p) => p[1]);
  const lastD = series.at(-1)[0];
  const last = vals.at(-1);
  // Last stored point on or before a date (series is ascending).
  const valueOn = (ymd) => { let v = null; for (const [d, x] of series) { if (d <= ymd) v = x; else break; } return v; };
  const chg = (days) => { const b = valueOn(shiftDay(lastD, -days)); return b ? pctOf(last, b) : null; };
  let hi = series[0], lo = series[0];
  for (const p of series) { if (p[1] > hi[1]) hi = p; if (p[1] < lo[1]) lo = p; }
  const spanDays = (Date.parse(`${lastD}T00:00:00Z`) - Date.parse(`${series[0][0]}T00:00:00Z`)) / 864e5;
  const perYear = (series.length - 1) / (spanDays / 365);
  const vol = volatility(vals, perYear);
  const dd = maxDrawdown(vals);
  const tr = trendSignal(vals, 30);
  const cls = (x) => (x > 0 ? 'up' : x < 0 ? 'down' : 'flat');
  const pv = (x) => (Number.isFinite(x) ? `<span class="num ${cls(x)}">${fmtPct(x, lang)}</span>` : '—');

  // Month-end values for the last 12 months, with the change from the previous month end.
  const [Y, M0] = lastD.split('-').map(Number);
  // A month only gets a value when the stored series has a point inside it. Months with
  // no points (e.g. a source gap) show a dash instead of carrying an old value forward.
  const lastIn = (from, to) => { let v = null; for (const [d, x] of series) { if (d > from && d <= to) v = x; } return v; };
  const months = [];
  for (let k = 12; k >= 0; k--) {
    const monthEnd = new Date(Date.UTC(Y, M0 - k, 0)).toISOString().slice(0, 10);
    const prevEnd = new Date(Date.UTC(Y, M0 - k - 1, 0)).toISOString().slice(0, 10);
    const end = monthEnd > lastD ? lastD : monthEnd;
    months.push({
      label: new Intl.DateTimeFormat(`${LOCALE[lang]}-u-ca-gregory`, { month: 'long', year: 'numeric' }).format(new Date(`${end}T12:00:00Z`)),
      v: lastIn(prevEnd, end),
    });
  }
  const monthRows = months.slice(1).map((r, i) => ({ ...r, ch: r.v && months[i].v ? pctOf(r.v, months[i].v) : null }));

  const isTedpix = m.slug === 'tedpix';
  const kv = `<dl class="kv">` +
    `<dt>${esc(t.idxLast)}</dt><dd class="num">${fmt(last, m.d, lang)}</dd>` +
    `<dt>${esc(t.idxChg1m)}</dt><dd>${pv(chg(30))}</dd>` +
    `<dt>${esc(t.idxChg3m)}</dt><dd>${pv(chg(90))}</dd>` +
    `<dt>${esc(t.idxChg1y)}</dt><dd>${pv(chg(365))}</dd>` +
    `<dt>${esc(t.idxHigh)}</dt><dd class="num">${fmt(hi[1], m.d, lang)} <small class="muted">${esc(dayLabel(hi[0], lang))}</small></dd>` +
    `<dt>${esc(t.idxLow)}</dt><dd class="num">${fmt(lo[1], m.d, lang)} <small class="muted">${esc(dayLabel(lo[0], lang))}</small></dd>` +
    `<dt>${esc(t.idxFromHigh)}</dt><dd>${pv(pctOf(last, hi[1]))}</dd>` +
    `<dt>${esc(t.idxMaxDD)}</dt><dd>${dd ? pv(dd.pct) : '—'}</dd>` +
    `<dt>${esc(t.idxVol)}</dt><dd class="num">${vol ? `${fmt(vol.annualized * 100, 1, lang)}%` : '—'}</dd>` +
    `<dt>${esc(t.idxSma)}</dt><dd>${tr ? `${pv(tr.vsSmaPct)} · ${esc(tr.direction === 'up' ? t.idxUp : tr.direction === 'down' ? t.idxDown : t.idxFlat)}` : '—'}</dd>` +
    `<dt>${esc(t.idxSpan)}</dt><dd class="num">${esc(dayLabel(series[0][0], lang))} – ${esc(dayLabel(lastD, lang))}</dd>` +
    `<dt>${esc(t.idxPoints)}</dt><dd class="num">${series.length}</dd>` +
    `</dl>`;
  const tbl = `<div class="tw"><table><thead><tr><th>${esc(t.idxMonth)}</th><th>${esc(t.idxValue)}</th><th>${esc(t.idxMonthChg)}</th></tr></thead><tbody>` +
    monthRows.map((r) => `<tr><td>${esc(r.label)}</td><td class="num">${r.v === null ? '—' : fmt(r.v, m.d, lang)}</td><td>${pv(r.ch)}</td></tr>`).join('') +
    `</tbody></table></div>`;
  return `<section class="mk-section"><h2 class="mk-sec-title">${esc(t.mkFullSection)}</h2>` +
    card(t.idxTitle, `<p>${esc(isTedpix ? t.idxAboutTedpix : t.idxAboutNasdaq)}</p><p class="muted">${esc(t.idxIntro)}</p>${kv}` +
      `<h3 class="mk-sub">${esc(t.idxMonthly)}</h3>${tbl}<p class="muted">${esc(isTedpix ? t.idxNoteTedpix : t.idxNoteNasdaq)}</p>`) +
    `</section>`;
}

function marketSectionHtml(lang, m) {
  const t = i18n[lang];
  const entry = SECTION_FOR[m.slug];
  if (!entry) return indexInfoBody(lang, m);
  const [slug, codes, asset, color] = entry;
  const inner = categoryBody(lang, slug, codes(), asset, color).replace(/<h1>([\s\S]*?)<\/h1>/, '<h3 class="mk-sub">$1</h3>');
  return `<section class="mk-section"><h2 class="mk-sec-title">${esc(t.mkFullSection)}</h2>${inner}</section>`;
}

function aboutBody(lang) {
  const a = i18n[lang].about;
  return `<h1>${esc(a.h)}</h1><section class="card"><p>${a.p1}</p><p>${a.p2}</p><p>${a.p3}</p><p><strong>${esc(i18n[lang].disclaimer)}</strong> ${a.p4.replace(/^[^:]*: /, '')}</p></section>`;
}

// --- write everything -------------------------------------------------------
mkdirSync(PUB, { recursive: true });
for (const lang of ['fa', 'en']) {
  for (const slug of ['', 'trade/', 'gold/', 'currency/', 'oil/', 'iran-gold/', 'lab/', 'calculator/', 'about/']) {
    const dir = path.join(PUB, lang, slug);
    mkdirSync(dir, { recursive: true });
    const page = slug === 'calculator/' ? calculatorBody(lang)
      : slug === 'lab/' ? labBody(lang)
      : slug === 'trade/' ? tradeBody(lang)
      : null;
    const body = page ? page.body
      : slug === '' ? homeBody(lang)
      : slug === 'about/' ? aboutBody(lang)
      : categoryBody(lang, slug.slice(0, -1), { gold: G.gold, currency: [...G.fxGlobal, ...G.fxIran], oil: G.oil, 'iran-gold': G.iranGold }[slug.slice(0, -1)],
          { gold: 'XAU', currency: 'USDIRR', oil: 'BRENT', 'iran-gold': 'AU18' }[slug.slice(0, -1)],
          { gold: '#d97706', currency: '#16a34a', oil: '#3b82f6', 'iran-gold': '#d97706' }[slug.slice(0, -1)]);
    writeFileSync(path.join(dir, 'index.html'), shell({ lang, slug: slug.slice(0, -1), body, extraHead: page?.extraHead }));
  }
}

for (const lang of ['fa', 'en']) {
  for (const m of MARKETS) {
    const dir = path.join(PUB, lang, 'markets', m.slug);
    mkdirSync(dir, { recursive: true });
    const { body, extraHead } = marketBody(lang, m);
    writeFileSync(path.join(dir, 'index.html'), shell({ lang, slug: `markets/${m.slug}`, body, extraHead }));
  }
}

// Root: default-language redirect.
// English is the default: the root always lands on /en/ regardless of browser
// locale; Persian stays reachable via the header switcher and the noscript
// fallback links.
writeFileSync(path.join(PUB, 'index.html'), `<!doctype html><html lang="en" dir="ltr"><head><meta charset="utf-8"><title>Market Radar | رصد بازار</title><script>location.replace('en/')</script><meta http-equiv="refresh" content="0;url=en/"><link rel="canonical" href="${SITE_URL}/en/"></head><body><noscript><a href="en/">English</a> · <a href="fa/">فارسی</a></noscript></body></html>`);

// 404: redirect home
writeFileSync(path.join(PUB, '404.html'), `<!doctype html><html><head><meta charset="utf-8"><script>location.replace('./')</script><meta name=\"robots\" content=\"noindex\"><meta http-equiv="refresh" content="0;url=./"></head><body></body></html>`);

// Static assets
mkdirSync(path.join(PUB, 'css'), { recursive: true });
mkdirSync(path.join(PUB, 'js'), { recursive: true });
mkdirSync(path.join(PUB, 'data'), { recursive: true });
copyFileSync(path.join(root, 'src/style.css'), path.join(PUB, 'css/style.css'));
copyFileSync(path.join(root, 'src/calc.js'), path.join(PUB, 'js/calc.js'));
copyFileSync(path.join(root, 'src/app.js'), path.join(PUB, 'js/app.js'));
copyFileSync(path.join(root, 'src/trend.js'), path.join(PUB, 'js/trend.js'));
copyFileSync(path.join(root, 'src/refresh.js'), path.join(PUB, 'js/refresh.js'));
copyFileSync(path.join(root, 'src/live.js'), path.join(PUB, 'js/live.js'));
copyFileSync(path.join(root, 'src/live-parse.js'), path.join(PUB, 'js/live-parse.js'));
copyFileSync(path.join(root, 'src/market.js'), path.join(PUB, 'js/market.js'));
copyFileSync(path.join(root, 'src/stale.js'), path.join(PUB, 'js/stale.js'));
copyFileSync(path.join(root, 'src/lab.js'), path.join(PUB, 'js/lab.js'));
copyFileSync(path.join(root, 'src/lab-calc.js'), path.join(PUB, 'js/lab-calc.js'));
copyFileSync(path.join(root, 'src/trade.js'), path.join(PUB, 'js/trade.js'));
copyFileSync(path.join(root, 'src/favicon.svg'), path.join(PUB, 'favicon.svg'));
for (const f of ['current.json', 'history-7d.json', 'history-30d.json', 'history-1y.json']) {
  copyFileSync(path.join(root, 'data', f), path.join(PUB, 'data', f));
}

writeFileSync(path.join(PUB, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE_URL || ''}/sitemap.xml\n`);
{
  const pages = ['', 'trade/', 'gold/', 'currency/', 'oil/', 'iran-gold/', 'lab/', 'calculator/', 'about/', ...MARKETS.map((m) => `markets/${m.slug}/`)];
  const lastmod = new Date(data.t * 1000).toISOString();
  const alts = (s) => ['en', 'fa'].map((l) => `<xhtml:link rel="alternate" hreflang="${l}" href="${SITE_URL}/${l}/${s}"/>`).join('') +
    `<xhtml:link rel="alternate" hreflang="x-default" href="${SITE_URL}/en/${s}"/>`;
  const urls = ['en', 'fa'].flatMap((lang) => pages.map((s) =>
    `<url><loc>${SITE_URL}/${lang}/${s}</loc><lastmod>${lastmod}</lastmod>${alts(s)}</url>`));
  writeFileSync(path.join(PUB, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">` +
    urls.join('') + `</urlset>\n`);
}

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
