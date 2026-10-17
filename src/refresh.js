// In-place page updater for live prices + footer "refresh" button.
//
// live.js (every page load) and the button both fetch live values and dispatch
// "market:live". This module applies them to the rendered page WITHOUT a reload:
//   - asset rows (price, change %, source name)  — tr[data-code]
//   - implied-USD section                       — tr[data-implied]
//   - status label, dot, and timestamps
// Build-time values are kept in data-v / data-d so the implied-USD maths can
// be recomputed from whichever value is current.
import { impliedUsd, difference } from './calc.js';
import { freshness } from './stale.js';

const $ = (id) => document.getElementById(id);
const btn = $('refresh-btn');
const msg = $('refresh-msg');
const L = JSON.parse($('i18n-refresh')?.textContent || '{}');
const lang = document.documentElement.lang === 'fa' ? 'fa' : 'en';
const LOCALE = lang === 'fa' ? 'fa-IR' : 'en-GB';

const fmt = (v, d) => new Intl.NumberFormat(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
const fmtPct = (c) => `${c > 0 ? '+' : ''}${fmt(c, 2)}%`;
const fmtTime = (t) =>
  new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Tehran' }).format(t * 1000);
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');

const val = (code) => Number(document.querySelector(`tr[data-code="${code}"]`)?.dataset.v);

function setMsg(text) { if (msg) msg.textContent = text || ''; }

// Message clears after 2.5 s; the button re-arms after the 3 s cooldown.
function finish(text) {
  setMsg(text);
  setTimeout(() => setMsg(''), 2500);
  setTimeout(() => { if (btn) btn.disabled = false; }, 3000);
}

function updateRows(a) {
  for (const [code, row] of Object.entries(a)) {
    const tr = document.querySelector(`tr[data-code="${code}"]`);
    if (!tr) continue;
    if (Number.isFinite(row.v)) tr.dataset.v = String(row.v);

    // Price: only the number text node is replaced, so the unit <small> survives.
    const priceCell = tr.querySelector('.p.num');
    const d = Number(tr.dataset.d ?? 2);
    if (priceCell && Number.isFinite(row.v)) {
      const node = priceCell.firstChild;
      // Keep the separator space that sits before the unit <small>.
      const sep = priceCell.querySelector('small') ? ' ' : '';
      if (node && node.nodeType === Node.TEXT_NODE) node.textContent = fmt(row.v, d) + sep;
      priceCell.classList.add('flash-update');
    }

    // Change %: left untouched when the provider does not report one.
    const chgCell = tr.querySelector('.num:not(.p)');
    if (chgCell && Number.isFinite(row.c)) {
      chgCell.className = `num ${cls(row.c)}`;
      chgCell.textContent = `${row.c > 0 ? '▲' : row.c < 0 ? '▼' : ''} ${fmtPct(row.c)}`.trim();
      chgCell.classList.add('flash-update');
    }

    // Source name (provider that supplied this value).
    const srcCell = tr.querySelector('td.u:last-child');
    if (srcCell && row.s && L.srcNames?.[row.s]) srcCell.textContent = L.srcNames[row.s][lang];
  }
}

// ---- Tile state ------------------------------------------------------------
// Every asset keeps its last live quote in localStorage. A page load shows that quote
// (with its own time) before the first round, and a failed round keeps it, so a
// tile never falls back to the build snapshot once it has had a live price.
// Purple: a tile is light purple unless its source sent a timestamped update within
// the last minute (freshness rule in stale.js).
const STORE_KEY = 'mr-last-live-v1';
const TIME_FMT = new Intl.DateTimeFormat(LOCALE, { timeStyle: 'medium', timeZone: 'Asia/Tehran' });
const DAY_FMT = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short' });

function loadLast() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch { return {}; }
}
function saveLast(view) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(view)); } catch { /* storage off or full */ }
}

let last = loadLast();

// The state of every asset: this round's rows applied over the stored ones. A price
// keeps its own source time (t); a row without a price never removes the stored price.
function viewOf(a) {
  const out = { ...last };
  for (const [code, row] of Object.entries(a)) {
    const prev = out[code] || {};
    // A price with no source time (e.g. navasan's rounded gold) must not replace a stored
    // price that has one: the timestamped quote stays, and its purple state follows its time.
    if (Number.isFinite(row.v) && !Number.isFinite(row.t) && Number.isFinite(prev.t)) continue;
    const m = { ...prev, ...row };
    if (Number.isFinite(row.v)) {
      m.v = row.v;
      m.s = row.s;
      if (Number.isFinite(row.t)) m.t = row.t; else delete m.t;
    }
    out[code] = m;
  }
  return out;
}

// Purple state and the time label of one tile.
function paintTile(el, row) {
  const { fresh } = freshness(row?.t, Date.now());
  el.classList.toggle('is-stale', !fresh);
  if (fresh) el.removeAttribute('title'); else el.title = L.staleTile || '';
  const asOf = el.querySelector('[data-asof]');
  if (!asOf) return;
  if (row?.t) {
    asOf.textContent = fresh
      ? `${L.liveAt || ''} ${TIME_FMT.format(new Date(row.t * 1000))}`.trim()
      : `${L.lastAt || ''} ${fmtTime(row.t)}`.trim();
  } else if (row?.d) {
    asOf.textContent = `${asOf.dataset.label || ''} ${DAY_FMT.format(new Date(`${row.d}T12:00:00Z`))}`.trim();
  } else if (Number.isFinite(row?.v)) {
    asOf.textContent = L.noTime || '';
  }
}

// Homepage strip and market pages: value, 1-day and 1-week change, time label, purple.
// `only` limits the update to some assets; `flash` highlights the changed changes.
function updateTicker(view, only = null, flash = false) {
  for (const el of document.querySelectorAll('[data-tick]')) {
    const code = el.dataset.tick;
    if (only && !only.has(code)) continue;
    const row = view[code];
    const d = Number(el.dataset.d ?? 2);
    const tv = el.querySelector('[data-tv]');
    if (tv && Number.isFinite(row?.v)) tv.textContent = fmt(row.v, d);
    for (const key of ['c', 'w']) {
      const node = el.querySelector(`[data-${key}]`);
      if (!node || !Number.isFinite(row?.[key])) continue;
      node.className = `num ${cls(row[key])}`;
      node.textContent = `${row[key] > 0 ? '▲' : row[key] < 0 ? '▼' : ''} ${fmtPct(row[key])}`.trim();
      if (flash) node.classList.add('flash-update');
    }
    paintTile(el, row);
  }
}

// Show the stored state straight away (before the first round). Tiles without any
// live quote are painted purple here too, not only when the first round ends.
updateTicker(last);

function updateImplied() {
  const usd = val('USDIRR'), xau = val('XAU');
  const rows = document.querySelectorAll('tr[data-implied]');
  if (!rows.length || !(usd > 0)) return;

  const set = (key, v, diff) => {
    const tr = document.querySelector(`tr[data-implied="${key}"]`);
    if (!tr) return;
    tr.querySelector('[data-col="v"]').textContent = Number.isFinite(v) ? fmt(v, 0) : '—';
    const abs = tr.querySelector('[data-col="abs"]');
    const pct = tr.querySelector('[data-col="pct"]');
    if (!abs || !pct) return;
    if (diff) {
      const c = diff.abs >= 0 ? 'up' : 'down';
      abs.className = `num ${c}`; pct.className = `num ${c}`;
      abs.textContent = fmt(diff.abs, 0);
      pct.textContent = fmtPct(diff.pct);
    } else {
      abs.className = ''; pct.className = '';
      abs.textContent = '—'; pct.textContent = '—';
    }
  };

  const i18 = impliedUsd({ domesticPrice: val('AU18'), globalOunceUsd: xau, purity: 0.75 });
  const iCoin = impliedUsd({ domesticPrice: val('COIN'), globalOunceUsd: xau, purity: 0.9, weightGrams: 8.133 });
  set('actual', usd, null);
  set('ai18', i18, difference(usd, i18));
  set('icoin', iCoin, difference(usd, iCoin));
}

function setStatusFresh(t) {
  const dot = document.querySelector('.status .dot');
  if (dot) dot.className = 'dot ok';
  const label = document.querySelector('.status .st-label');
  if (label && L.fresh) label.textContent = L.fresh;
  const time = fmtTime(t);
  for (const el of document.querySelectorAll('.sb-upd .num, .status .num, footer .num')) el.textContent = time;
  document.body.dataset.t = String(t);
}

document.addEventListener('market:start', () => {
  if (btn) btn.disabled = true;
  setMsg(L.refreshing);
});

// Progressive: every arriving source is applied immediately (gold usually first).
document.addEventListener('market:live', (e) => {
  const r = e.detail;
  if (!r || r.ok === 0) return;
  const view = viewOf(r.a);
  updateRows(r.a);
  updateTicker(view, new Set(Object.keys(r.a)), true);
  if (r.a.USDIRR?.v) document.body.dataset.usd = String(r.a.USDIRR.v);
  updateImplied();
  setStatusFresh(r.t);
  if (r.final) {
    setTimeout(() => document.querySelectorAll('.flash-update').forEach((el) => el.classList.remove('flash-update')), 1500);
    updateTicker(view);            // every tile: purple state and time label
    last = view;
    saveLast(view);
    finish(r.ok < r.total ? (L.partial || L.fastUpdated) : (L.fastUpdated || L.upToDate));
  }
});

document.addEventListener('market:error', () => finish(L.failed));

if (btn) {
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    document.dispatchEvent(new CustomEvent('market:refresh'));
  });
}
