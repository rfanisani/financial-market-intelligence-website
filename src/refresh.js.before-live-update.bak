// Auto-Update & Fast-Update engine + Footer "refresh" button.
// Executes automatically upon page entry (DOMContentLoaded) to check and
// fetch the latest live prices from reference sources and data/current.json,
// then repeats periodically in the background (every 60s) or on manual button click.
(() => {
  const btn = document.getElementById('refresh-btn');
  const msg = document.getElementById('refresh-msg');
  const i18nEl = document.getElementById('i18n-refresh');
  const L = i18nEl ? JSON.parse(i18nEl.textContent) : {};
  let pageT = Number(document.body.dataset.t) || 0;
  const lang = document.documentElement.lang === 'fa' ? 'fa' : 'en';
  const LOCALE = lang === 'fa' ? 'fa-IR' : 'en-GB';
  const depth = location.pathname.replace(/\/index\.html$/, '/').split('/').filter(Boolean).length;
  const prefix = '../'.repeat(depth);
  let busy = false;

  const fmt = (v, d) => new Intl.NumberFormat(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
  const fmtPct = (c) => `${c > 0 ? '+' : ''}${fmt(c, 2)}%`;
  const fmtTime = (t) =>
    new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Tehran' }).format(t * 1000);

  // Update a single asset row in the DOM
  function updateDomRow(code, v, c) {
    const tr = document.querySelector(`tr[data-code="${code}"]`);
    if (!tr) return;
    const priceCell = tr.querySelector('.p.num');
    const chgCell = tr.querySelector('.num:not(.p)');
    if (priceCell && Number.isFinite(v) && v > 0) {
      const decimals = code === 'EURUSD' || code === 'GBPUSD' ? 4 : v >= 1000 ? 0 : 2;
      priceCell.textContent = fmt(v, decimals);
      priceCell.classList.add('flash-update');
    }
    if (chgCell && Number.isFinite(c)) {
      chgCell.className = `num ${c > 0 ? 'up' : c < 0 ? 'down' : 'flat'}`;
      const arrow = c > 0 ? '▲' : c < 0 ? '▼' : '';
      chgCell.textContent = `${arrow} ${fmtPct(c)}`.trim();
      chgCell.classList.add('flash-update');
    }
  }

  // Update timestamp, status indicator and body dataset
  function updateTimestamps(t) {
    if (!Number.isFinite(t) || t <= pageT) return;
    pageT = t;
    document.body.dataset.t = String(t);
    const timeStr = fmtTime(t);
    for (const el of document.querySelectorAll('.sb-upd .num, .status .num, footer .num')) {
      el.textContent = timeStr;
    }
    const dot = document.querySelector('.status .dot');
    if (dot) dot.className = 'dot ok';
  }

  // Fetch live quotes directly from open reference APIs in the browser
  async function fetchLiveReferenceQuotes() {
    const liveUpdates = {};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);

    await Promise.allSettled([
      // ECB reference rates via Frankfurter
      (async () => {
        try {
          const res = await fetch('https://api.frankfurter.dev/v1/latest?from=USD&to=EUR,GBP,JPY', {
            signal: controller.signal,
            cache: 'no-store',
          });
          if (res.ok) {
            const j = await res.json();
            if (Number.isFinite(j.rates?.EUR) && j.rates.EUR > 0) liveUpdates.EURUSD = +(1 / j.rates.EUR).toFixed(4);
            if (Number.isFinite(j.rates?.GBP) && j.rates.GBP > 0) liveUpdates.GBPUSD = +(1 / j.rates.GBP).toFixed(4);
            if (Number.isFinite(j.rates?.JPY) && j.rates.JPY > 0) liveUpdates.USDJPY = +j.rates.JPY.toFixed(2);
          }
        } catch {}
      })(),

      // Gold & Silver spot quotes
      (async () => {
        try {
          const [rxau, rxag] = await Promise.all([
            fetch('https://api.gold-api.com/price/XAU', { signal: controller.signal, cache: 'no-store' }),
            fetch('https://api.gold-api.com/price/XAG', { signal: controller.signal, cache: 'no-store' }),
          ]);
          if (rxau.ok) {
            const j = await rxau.json();
            const v = Number(j.price);
            if (Number.isFinite(v) && v > 0) liveUpdates.XAU = +v.toFixed(2);
          }
          if (rxag.ok) {
            const j = await rxag.json();
            const v = Number(j.price);
            if (Number.isFinite(v) && v > 0) liveUpdates.XAG = +v.toFixed(2);
          }
        } catch {}
      })(),

      // Tehran free market dollar quote via TGJU summary indicator
      (async () => {
        try {
          const res = await fetch('https://api.tgju.org/v1/market/indicator/summary-table-data/price_dollar_rl?row=1', {
            signal: controller.signal,
            cache: 'no-store',
          });
          if (res.ok) {
            const j = await res.json();
            const row = j.data?.[0];
            if (Array.isArray(row)) {
              const rial = Number(String(row[0]).replace(/,/g, ''));
              if (Number.isFinite(rial) && rial > 0) liveUpdates.USDIRR = Math.round(rial / 10);
            }
          }
        } catch {}
      })(),
    ]);

    clearTimeout(timer);
    return liveUpdates;
  }

  // Core update routine
  async function performUpdate(isManual = false) {
    if (busy) return;
    busy = true;
    if (isManual && btn) {
      btn.disabled = true;
      if (msg) msg.textContent = L.refreshing || 'Checking…';
    }

    let updatedSomething = false;

    try {
      // 1. Fetch site's current published JSON
      const res = await fetch(`${prefix}data/current.json?_=${Date.now()}`, { cache: 'no-store' });
      if (res.ok) {
        const j = await res.json();
        const isNewer = Number.isFinite(j.t) && Number.isFinite(pageT) && j.t > pageT;
        if (isNewer && j.a) {
          for (const [code, row] of Object.entries(j.a)) {
            updateDomRow(code, row.v, row.c);
          }
          updateTimestamps(j.t);
          if (j.a.USDIRR?.v) document.body.dataset.usd = String(j.a.USDIRR.v);
          updatedSomething = true;
        }
      }

      // 2. Fetch live reference quotes in parallel
      const live = await fetchLiveReferenceQuotes();
      const liveKeys = Object.keys(live);
      if (liveKeys.length > 0) {
        for (const [code, val] of Object.entries(live)) {
          updateDomRow(code, val);
        }
        if (live.USDIRR) document.body.dataset.usd = String(live.USDIRR);
        updateTimestamps(Math.floor(Date.now() / 1000));
        updatedSomething = true;
      }

      if (updatedSomething) {
        setTimeout(() => {
          document.querySelectorAll('.flash-update').forEach((el) => el.classList.remove('flash-update'));
        }, 1500);
        // Background cache revalidation
        fetch(location.href, { cache: 'reload' }).catch(() => {});
      }

      if (isManual && msg) {
        msg.textContent = updatedSomething ? (L.fastUpdated || 'Prices updated live.') : (L.upToDate || 'Content is up to date.');
      }
    } catch {
      if (isManual && msg) {
        msg.textContent = L.failed || 'Update failed — please try again.';
      }
    } finally {
      if (isManual) {
        setTimeout(() => {
          if (msg) msg.textContent = '';
          if (btn) btn.disabled = false;
          busy = false;
        }, 2500);
      } else {
        busy = false;
      }
    }
  }

  // Manual button click
  if (btn) {
    btn.addEventListener('click', () => performUpdate(true));
  }

  // Auto-update immediately upon entering the page (DOMContentLoaded or immediately if ready)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      performUpdate(false);
    });
  } else {
    performUpdate(false);
  }

  // Periodic background check every 60 seconds while the page remains open
  setInterval(() => {
    performUpdate(false);
  }, 60000);
})();
