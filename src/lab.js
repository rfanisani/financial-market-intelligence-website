// Financial Intelligence Lab — browser module for /fa/lab/ and /en/lab/.
// All calculations come from lab-calc.js (shared with the Node test suite);
// this file only wires the form, renders localized results, and draws inline
// SVG charts. The data and strings are embedded in the page at build time, so
// the lab works on GitHub Pages with no extra requests and nothing is sent
// anywhere: every calculation happens locally in the browser.
import {
  simpleReturns, periodReturn, volatility, maxDrawdown,
  sma, trendSignal, compareAssets,
} from './lab-calc.js';

const $ = (id) => document.getElementById(id);
const lang = document.documentElement.lang === 'fa' ? 'fa' : 'en';
const L = JSON.parse($('i18n-lab').textContent);
const D = JSON.parse($('lab-data').textContent);
const LOCALE = lang === 'fa' ? 'fa-IR' : 'en-GB';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const fmtNum = (v, d) => new Intl.NumberFormat(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
const fmtPct = (v) => `${v > 0 ? '+' : ''}${new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v)}%`;
const fmtDate = (t) => new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeZone: 'Asia/Tehran' }).format(t * 1000);
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
const fill = (tpl, map) => Object.entries(map).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), tpl);

const byCode = Object.fromEntries(D.assets.map((a) => [a.code, a]));
const seriesFor = (code, w) => (byCode[code] ? (w === 30 ? byCode[code].s30 : byCode[code].s7) : null);
const metaFor = (w) => (w === 30 ? D.w30 : D.w7);
const unit = (a) => (a.unit ? ` <small class="u">${esc(a.unit)}</small>` : '');

// Source + time-window line shown under every result (transparency requirement).
function metaLine(assets, w, seriesLen) {
  const m = metaFor(w);
  const range = fill(L.windowRange, { start: fmtDate(m.t0), end: fmtDate(m.t0 + m.dt * (seriesLen - 1)) });
  const srcs = assets.map((a) => fill(L.source, { src: a.src })).join(' · ');
  return `<p class="muted">${esc(range)} · ${esc(srcs)}</p>`;
}

// Inline SVG line chart — same visual language as the build-time charts.
function lineChart(series, ariaLabel, decimals) {
  const n = Math.max(...series.map((s) => s.values.length));
  if (n < 2) return '';
  const w = 560, h = 170, pad = 12;
  const all = series.flatMap((s) => s.values.filter((v) => Number.isFinite(v)));
  const min = Math.min(...all), max = Math.max(...all), span = max - min || 1;
  const x = (i) => pad + (i / (n - 1)) * (w - 2 * pad);
  const y = (v) => h - pad - ((v - min) / span) * (h - 2 * pad);
  const lines = series.map((s) =>
    `<polyline fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" points="${
      s.values.map((v, i) => (Number.isFinite(v) ? `${x(i).toFixed(1)},${y(v).toFixed(1)}` : '')).filter(Boolean).join(' ')
    }"/>`
  ).join('');
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(ariaLabel)}">` +
    `<line x1="${pad}" y1="${y(max).toFixed(1)}" x2="${w - pad}" y2="${y(max).toFixed(1)}" stroke="currentColor" stroke-opacity=".12"/>` +
    `<line x1="${pad}" y1="${y(min).toFixed(1)}" x2="${w - pad}" y2="${y(min).toFixed(1)}" stroke="currentColor" stroke-opacity=".12"/>` +
    lines +
    `<text x="${pad}" y="${(y(max) - 4).toFixed(1)}" font-size="10" fill="currentColor" fill-opacity=".55">${fmtNum(max, max < 10 ? 2 : decimals)}</text>` +
    `<text x="${pad}" y="${(y(min) + 12).toFixed(1)}" font-size="10" fill="currentColor" fill-opacity=".55">${fmtNum(min, min < 10 ? 2 : decimals)}</text>` +
    `</svg>`;
}

const legend = (items) => `<div class="legend">${items.map(([c, l]) => `<span><i style="background:${c}"></i>${esc(l)}</span>`).join('')}</div>`;

function showError(msg) {
  $('lab-result').innerHTML = `<p class="error">${esc(msg)}</p>`;
}

function renderReturn(a, s, w) {
  const r = periodReturn(s);
  if (!r) return showError(L.insufficient);
  $('lab-result').innerHTML = `<div class="result">
    <p><b>${esc(a.name)}</b></p>
    <dl class="kv">
      <dt>${esc(L.periodReturn)}</dt><dd class="num ${cls(r.pct)}">${fmtPct(r.pct)}</dd>
      <dt>${esc(L.firstPrice)}</dt><dd class="num">${fmtNum(r.first, a.d)}${unit(a)}</dd>
      <dt>${esc(L.lastPrice)}</dt><dd class="num">${fmtNum(r.last, a.d)}${unit(a)}</dd>
      <dt>${esc(L.points)}</dt><dd class="num">${r.points}</dd>
    </dl>
    ${metaLine([a], w, s.length)}
  </div>`;
}

function renderRisk(a, s, w) {
  const vol = volatility(s), dd = maxDrawdown(s), r = simpleReturns(s);
  if (!vol || !dd || !r) return showError(L.insufficient);
  const best = Math.max(...r), worst = Math.min(...r);
  $('lab-result').innerHTML = `<div class="result">
    <p><b>${esc(a.name)}</b></p>
    <dl class="kv">
      <dt>${esc(L.volatility)}</dt><dd class="num">${fmtPct(vol.annualized * 100)}</dd>
      <dt>${esc(L.maxDrawdown)}</dt><dd class="num ${cls(dd.pct)}">${fmtPct(dd.pct)}</dd>
      <dt>${esc(L.bestDay)}</dt><dd class="num ${cls(best)}">${fmtPct(best * 100)}</dd>
      <dt>${esc(L.worstDay)}</dt><dd class="num ${cls(worst)}">${fmtPct(worst * 100)}</dd>
      <dt>${esc(L.points)}</dt><dd class="num">${dd.points}</dd>
    </dl>
    <p class="muted">${esc(fill(L.volNote, { n: vol.n }))}</p>
    ${metaLine([a], w, s.length)}
  </div>`;
}

function renderTrend(a, s, w) {
  if (s.length < 3) return showError(L.insufficient);
  const req = Number($('lab-ma').value);
  // Clamp the requested window to what the data supports and show the
  // effective window in the result so the calculation stays reproducible.
  const win = Math.max(2, Math.min(Number.isFinite(req) ? Math.floor(req) : 2, s.length - 1));
  const tr = trendSignal(s, win);
  const avg = sma(s, win);
  if (!tr || !avg) return showError(L.insufficient);
  const smaLabel = fill(L.sma, { w: fmtNum(win, 0) });
  const dirLabel = { up: L.trendUp, down: L.trendDown, flat: L.trendFlat }[tr.direction];
  const chart = lineChart(
    [{ values: s, color: '#3b82f6' }, { values: avg, color: '#d97706' }],
    `${a.name} — ${smaLabel}`,
    a.d
  );
  $('lab-result').innerHTML = `<div class="result">
    <p><b>${esc(a.name)}</b></p>
    ${chart}
    ${legend([['#3b82f6', a.name], ['#d97706', smaLabel]])}
    <dl class="kv">
      <dt>${esc(smaLabel)}</dt><dd class="num">${fmtNum(tr.sma, a.d)}${unit(a)}</dd>
      <dt>${esc(L.lastVsSma)}</dt><dd class="num ${cls(tr.vsSmaPct)}">${fmtPct(tr.vsSmaPct)}</dd>
      <dt>${esc(L.trendLabel)}</dt><dd class="${cls(tr.vsSmaPct)}">${esc(dirLabel)}</dd>
      <dt>${esc(L.points)}</dt><dd class="num">${s.length}</dd>
    </dl>
    ${metaLine([a], w, s.length)}
  </div>`;
}

function renderCompare(a, b, sa, sb, w) {
  const cmp = compareAssets(sa, sb);
  if (!cmp) return showError(L.insufficient);
  const chart = lineChart(
    [{ values: cmp.a, color: '#d97706' }, { values: cmp.b, color: '#3b82f6' }],
    `${a.name} / ${b.name} — ${L.normalized}`,
    0
  );
  const corr = Number.isFinite(cmp.correlation)
    ? `<dt>${esc(L.corr)}</dt><dd class="num">${new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cmp.correlation)}</dd>`
    : '';
  $('lab-result').innerHTML = `<div class="result">
    <p><b>${esc(a.name)}</b> / <b>${esc(b.name)}</b></p>
    ${chart}
    ${legend([['#d97706', a.name], ['#3b82f6', b.name]])}
    <dl class="kv">
      <dt>${esc(a.name)}</dt><dd class="num ${cls(cmp.aPct)}">${fmtPct(cmp.aPct)}</dd>
      <dt>${esc(b.name)}</dt><dd class="num ${cls(cmp.bPct)}">${fmtPct(cmp.bPct)}</dd>
      <dt>${esc(L.spread)}</dt><dd class="num ${cls(cmp.spreadPct)}">${fmtPct(cmp.spreadPct)}</dd>
      ${corr}
    </dl>
    <p class="muted">${esc(L.corrNote)}</p>
    ${metaLine([a, b], w, sa.length)}
  </div>`;
}

function runAnalysis() {
  const tool = $('lab-tool').value;
  const w = Number($('lab-window').value) === 30 ? 30 : 7;
  if (tool === 'compare') {
    const ca = $('lab-asset-a').value, cb = $('lab-asset-b').value;
    if (ca === cb) return showError(L.sameAsset);
    const a = byCode[ca], b = byCode[cb];
    const sa = seriesFor(ca, w), sb = seriesFor(cb, w);
    if (!a || !b || !sa || !sb) return showError(L.dataMissing);
    return renderCompare(a, b, sa, sb, w);
  }
  const code = $('lab-asset').value;
  const a = byCode[code];
  const s = seriesFor(code, w);
  if (!a || !s) return showError(L.dataMissing);
  if (tool === 'return') return renderReturn(a, s, w);
  if (tool === 'risk') return renderRisk(a, s, w);
  if (tool === 'trend') return renderTrend(a, s, w);
  showError(L.insufficient);
}

// Show only the fields the selected tool needs.
function syncToolFields() {
  const tool = $('lab-tool').value;
  $('lab-f-asset').hidden = tool === 'compare';
  $('lab-f-asset-a').hidden = tool !== 'compare';
  $('lab-f-asset-b').hidden = tool !== 'compare';
  $('lab-f-ma').hidden = tool !== 'trend';
}

let busy = false;
$('lab-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (busy) return;
  busy = true;
  const btn = $('lab-run');
  btn.disabled = true;
  try {
    // Calculations are synchronous and local, so this resolves instantly;
    // the guard simply prevents double submission.
    runAnalysis();
  } finally {
    btn.disabled = false;
    busy = false;
  }
});
$('lab-tool').addEventListener('change', syncToolFields);
syncToolFields();
