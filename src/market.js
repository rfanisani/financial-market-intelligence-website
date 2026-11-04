// Market detail page: time-range buttons and the latest live point.
//
// The page is pre-rendered by the build (static chart and stats for the default
// range, with a year of daily history embedded), so it reads correctly without
// JavaScript. When it runs:
//   - it asks TGJU (CORS enabled) for the latest row only (length=8) and merges
//     that point into the embedded series; history is NOT fetched per visit
//   - the range buttons redraw from the current series, without a reload
// If the live request fails, the build data stays. Nasdaq has no browser-accessible
// live source, so it keeps the build data.
import { parseTgjuHistory } from './live-parse.js';

const TGJU = 'https://api.tgju.org/v1/market/indicator/summary-table-data/';


const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

const el = document.getElementById('mk-data');
if (el) boot(JSON.parse(el.textContent));

function boot(M) {
  const L = M.labels;
  const LOCALE = M.locale;
  let series = M.series;
  let days = M.defaultRange;
  const chartAria = document.querySelector('#mk-chart svg')?.getAttribute('aria-label') || '';

  const fmt = (v) => new Intl.NumberFormat(LOCALE, { minimumFractionDigits: M.d, maximumFractionDigits: M.d }).format(v);
  const pct = (x) => `${x > 0 ? '+' : ''}${new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(x)}%`;
  const shift = (ymd, n) => {
    const dt = new Date(`${ymd}T00:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() + n);
    return dt.toISOString().slice(0, 10);
  };
  const dayLabel = (ymd) => new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${ymd}T12:00:00Z`));
  const slice = () => (series.length ? series.filter(([d]) => d >= shift(series.at(-1)[0], -days)) : []);

  // Same structure as the build's static chart (scripts/build.mjs, marketChart).
  function chart(pts) {
    if (pts.length < 2) return `<p class="muted">${esc(L.noData)}</p>`;
    const W = 640, H = 240, PT = 12, PB = 12;
    const vals = pts.map((p) => p[1]);
    const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
    const x = (i) => (i / (pts.length - 1)) * W;
    const y = (v) => PT + (1 - (v - min) / span) * (H - PT - PB);
    const line = pts.map(([, v], i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    return `<div class="mk-chart-wrap" dir="ltr">` +
      `<div class="mk-yl"><span>${fmt(max)}</span><span>${fmt(min)}</span></div>` +
      `<svg class="mk-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(chartAria)}">` +
      `<polyline fill="none" stroke="#d97706" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke" points="${line}"/></svg>` +
      `</div>` +
      `<div class="mk-xl" dir="ltr"><span>${esc(dayLabel(pts[0][0]))}</span><span>${esc(dayLabel(pts.at(-1)[0]))}</span></div>`;
  }

  function statsHtml(pts) {
    if (pts.length < 2) return '';
    const vals = pts.map((p) => p[1]);
    const last = vals.at(-1);
    const change = (last / vals[0] - 1) * 100;
    const unit = M.unit ? ` <small class="u">${esc(M.unit)}</small>` : '';
    const c = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
    return `<dt>${esc(L.statLast)}</dt><dd class="num">${fmt(last)}${unit}</dd>` +
      `<dt>${esc(L.statChange)}</dt><dd><span class="num ${c}">${pct(change)}</span></dd>` +
      `<dt>${esc(L.statHigh)}</dt><dd class="num">${fmt(Math.max(...vals))}</dd>` +
      `<dt>${esc(L.statLow)}</dt><dd class="num">${fmt(Math.min(...vals))}</dd>` +
      `<dt>${esc(L.statPoints)}</dt><dd class="num">${vals.length}</dd>`;
  }

  function render() {
    const pts = slice();
    const chartEl = document.getElementById('mk-chart');
    const statsEl = document.getElementById('mk-stats');
    if (chartEl) chartEl.innerHTML = chart(pts);
    if (statsEl) statsEl.innerHTML = statsHtml(pts);
    for (const b of document.querySelectorAll('.mk-btn')) {
      b.setAttribute('aria-pressed', String(Number(b.dataset.range) === days));
    }
  }

  document.querySelector('.mk-range')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-range]');
    if (!b) return;
    days = Number(b.dataset.range);
    render();
  });

  // Latest point only: merge it into the embedded series (same date = replace, newer = append).
  if (M.tgju) {
    const status = document.getElementById('mk-status');
    fetch(`${TGJU}${M.tgju}?length=8`, { cache: 'no-store', signal: AbortSignal.timeout(8000) })
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((j) => {
        const latest = parseTgjuHistory(j, M.scale).at(-1);
        if (!latest) throw new Error('no latest row');
        const last = series.at(-1);
        if (!last || latest[0] > last[0]) series = [...series, latest];
        else if (latest[0] === last[0]) series = [...series.slice(0, -1), latest];
        if (status) status.textContent = `${L.live} · ${dayLabel(latest[0])}`;
        render();
      })
      .catch(() => {
        if (status) status.textContent = L.liveFail;
      });
  }
}
