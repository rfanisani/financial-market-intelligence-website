(() => {
  const btn = document.getElementById('refresh-btn');
  const msg = document.getElementById('refresh-msg');
  const i18nEl = document.getElementById('i18n-refresh');
  const L = i18nEl ? JSON.parse(i18nEl.textContent) : {};
  let pageT = Number(document.body.dataset.t) || 0;
  const lang = document.documentElement.lang === 'fa' ? 'fa' : 'en';
  const LOCALE = lang === 'fa' ? 'fa-IR' : 'en-GB';
  const depth = location.pathname.replace(/\/index\.html$/, '/').split('/').filter(Boolean).length;
  const prefix = '../'.repeat(Math.max(0, depth));
  let busy = false;
  let lastLiveCheck = 0;

  const fmt = (v, d = 2) => new Intl.NumberFormat(LOCALE, {
    maximumFractionDigits: d,
    minimumFractionDigits: d,
  }).format(v);

  const fmtPct = (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;

  const fmtTime = (t) =>
    new Intl.DateTimeFormat(LOCALE, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Tehran',
    }).format(t * 1000);

  function updateDomRow(code, v, c) {
    const tr = document.querySelector(`tr[data-code="${code}"]`);
    if (!tr) return;

    const priceCell = tr.querySelector('.p.num');
    const chgCell = tr.querySelector('.num:not(.p)');

    if (Number.isFinite(v) && v > 0 && priceCell) {
      const decimals = code === 'EURUSD' || code === 'GBPUSD' ? 4 : v >= 1000 ? 0 : 2;
      priceCell.textContent = fmt(v, decimals);
      priceCell.classList.add('flash-update');
    }

    if (Number.isFinite(c) && chgCell) {
      chgCell.className = `num ${c > 0 ? 'up' : c < 0 ? 'down' : 'flat'}`;
      const arrow = c > 0 ? '▲' : c < 0 ? '▼' : '';
      chgCell.textContent = `${arrow} ${fmtPct(c)}`.trim();
      chgCell.classList.add('flash-update');
    }
  }

  function updatePublishedTimestamp(t) {
    if (!Number.isFinite(t) || t <= pageT) return;

    pageT = t;
    document.body.dataset.t = String(t);

    const timeStr = fmtTime(t);
    document.querySelectorAll('.sb-upd .num, .status .num, footer .num')
      .forEach((el) => {
        el.textContent = timeStr;
      });

    const dot = document.querySelector('.status .dot');
    if (dot) dot.className = 'dot ok';
  }

  function showLiveCheckTime(t) {
    lastLiveCheck = t;

    let el = document.getElementById('live-check-time');
    if (!el && msg) {
      el = document.createElement('span');
      el.id = 'live-check-time';
      el.className = 'muted';
      el.setAttribute('aria-live', 'polite');
      msg.insertAdjacentElement('afterend', el);
    }

    if (el) {
      const label = lang === 'fa' ? 'بررسی زنده' : 'Live check';
      el.textContent = `${label}: ${fmtTime(t)}`;
    }
  }

  async function fetchLiveReferenceQuotes() {
    const liveUpdates = {};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);

    try {
      await Promise.allSettled([
        (async () => {
          try {
            const res = await fetch(
              'https://api.frankfurter.dev/v1/latest?from=USD&to=EUR,GBP,JPY',
              { signal: controller.signal, cache: 'no-store' },
            );

            if (!res.ok) return;

            const j = await res.json();

            if (Number.isFinite(j.rates?.EUR) && j.rates.EUR > 0) {
              liveUpdates.EURUSD = +(1 / j.rates.EUR).toFixed(4);
            }
            if (Number.isFinite(j.rates?.GBP) && j.rates.GBP > 0) {
              liveUpdates.GBPUSD = +(1 / j.rates.GBP).toFixed(4);
            }
            if (Number.isFinite(j.rates?.JPY) && j.rates.JPY > 0) {
              liveUpdates.USDJPY = +j.rates.JPY.toFixed(2);
            }
          } catch {}
        })(),

        (async () => {
          try {
            const results = await Promise.all([
              fetch('https://api.gold-api.com/price/XAU', {
                signal: controller.signal,
                cache: 'no-store',
              }),
              fetch('https://api.gold-api.com/price/XAG', {
                signal: controller.signal,
                cache: 'no-store',
              }),
            ]);

            for (let i = 0; i < results.length; i++) {
              const res = results[i];
              if (!res.ok) continue;

              const j = await res.json();
              const v = Number(j.price);
              if (!Number.isFinite(v) || v <= 0) continue;

              liveUpdates[i === 0 ? 'XAU' : 'XAG'] = +v.toFixed(2);
            }
          } catch {}
        })(),

        (async () => {
          try {
            const res = await fetch(
              'https://api.tgju.org/v1/market/indicator/summary-table-data/price_dollar_rl?row=1',
              { signal: controller.signal, cache: 'no-store' },
            );

            if (!res.ok) return;

            const j = await res.json();
            const row = j.data?.[0];

            if (Array.isArray(row)) {
              const rial = Number(String(row[0]).replace(/,/g, ''));
              if (Number.isFinite(rial) && rial > 0) {
                liveUpdates.USDIRR = Math.round(rial / 10);
              }
            }
          } catch {}
        })(),
      ]);
    } finally {
      clearTimeout(timer);
    }

    return liveUpdates;
  }

  async function performUpdate(isManual = false) {
    if (busy) return;
    busy = true;

    if (isManual && btn) btn.disabled = true;
    if (isManual && msg) msg.textContent = L.refreshing || (lang === 'fa' ? 'در حال بررسی…' : 'Checking…');

    let updatedSomething = false;
    let liveCheckSucceeded = false;

    try {
      const res = await fetch(`${prefix}data/current.json?_=${Date.now()}`, {
        cache: 'no-store',
      });

      if (res.ok) {
        const j = await res.json();

        if (Number.isFinite(j.t) && j.t > pageT && j.a) {
          for (const [code, row] of Object.entries(j.a)) {
            if (row && typeof row === 'object') {
              updateDomRow(code, row.v, row.c);
            }
          }

          updatePublishedTimestamp(j.t);
          if (j.a.USDIRR?.v > 0) {
            document.body.dataset.usd = String(j.a.USDIRR.v);
          }
          updatedSomething = true;
        }
      }

      const live = await fetchLiveReferenceQuotes();
      const liveKeys = Object.keys(live);

      if (liveKeys.length > 0) {
        for (const [code, val] of Object.entries(live)) {
          updateDomRow(code, val);
        }

        if (live.USDIRR > 0) {
          document.body.dataset.usd = String(live.USDIRR);
        }

        updatedSomething = true;
        liveCheckSucceeded = true;
      }

      showLiveCheckTime(Math.floor(Date.now() / 1000));

      if (updatedSomething) {
        setTimeout(() => {
          document.querySelectorAll('.flash-update')
            .forEach((el) => el.classList.remove('flash-update'));
        }, 1500);

        fetch(location.href, { cache: 'reload' }).catch(() => {});
      }

      if (isManual && msg) {
        if (liveCheckSucceeded || updatedSomething) {
          msg.textContent = L.fastUpdated || (lang === 'fa' ? 'قیمت‌ها بررسی شدند.' : 'Prices checked.');
        } else {
          msg.textContent = L.upToDate || (lang === 'fa' ? 'دادهٔ جدیدی دریافت نشد.' : 'No new data received.');
        }
      }
    } catch {
      if (isManual && msg) {
        msg.textContent = L.failed || (lang === 'fa' ? 'بررسی ناموفق بود؛ دوباره تلاش کنید.' : 'Update failed; please try again.');
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

  if (btn) {
    btn.addEventListener('click', () => performUpdate(true));
  }

  function startAutoUpdate() {
    performUpdate(false);
    setInterval(() => {
      performUpdate(false);
    }, 60000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startAutoUpdate, { once: true });
  } else {
    startAutoUpdate();
  }
})();
