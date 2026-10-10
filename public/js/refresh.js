// Footer "refresh" button & Fast-Update engine.
// Checks data/current.json (cache-busted) and updates DOM in-place immediately
// (fast-update) when new data is available. Also revalidates the cache.
(() => {
  const btn = document.getElementById('refresh-btn');
  const msg = document.getElementById('refresh-msg');
  if (!btn || !msg) return;
  const L = JSON.parse(document.getElementById('i18n-refresh').textContent);
  let pageT = Number(document.body.dataset.t);
  const lang = document.documentElement.lang === 'fa' ? 'fa' : 'en';
  const LOCALE = lang === 'fa' ? 'fa-IR' : 'en-GB';
  const depth = location.pathname.replace(/\/index\.html$/, '/').split('/').filter(Boolean).length;
  const prefix = '../'.repeat(depth);
  let busy = false;

  const fmt = (v, d) => new Intl.NumberFormat(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
  const fmtPct = (c) => `${c > 0 ? '+' : ''}${fmt(c, 2)}%`;
  const fmtTime = (t) =>
    new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Tehran' }).format(t * 1000);

  btn.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    msg.textContent = L.refreshing;
    try {
      const res = await fetch(`${prefix}data/current.json?_=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const j = await res.json();
      const isNewer = Number.isFinite(j.t) && Number.isFinite(pageT) && j.t > pageT;

      if (isNewer && j.a) {
        // Fast-Update: update all asset rows in the DOM in-place without page reload
        for (const [code, row] of Object.entries(j.a)) {
          const tr = document.querySelector(`tr[data-code="${code}"]`);
          if (tr) {
            const priceCell = tr.querySelector('.p.num');
            const chgCell = tr.querySelector('.num:not(.p)');
            if (priceCell && Number.isFinite(row.v)) {
              const decimals = code === 'EURUSD' || code === 'GBPUSD' ? 4 : row.v >= 1000 ? 0 : 2;
              priceCell.textContent = fmt(row.v, decimals);
              priceCell.classList.add('flash-update');
            }
            if (chgCell && Number.isFinite(row.c)) {
              chgCell.className = `num ${row.c > 0 ? 'up' : row.c < 0 ? 'down' : 'flat'}`;
              const arrow = row.c > 0 ? '▲' : row.c < 0 ? '▼' : '';
              chgCell.textContent = `${arrow} ${fmtPct(row.c)}`.trim();
              chgCell.classList.add('flash-update');
            }
          }
        }

        // Fast-update timestamps
        const timeStr = fmtTime(j.t);
        for (const el of document.querySelectorAll('.sb-upd .num, .status .num, footer .num')) {
          el.textContent = timeStr;
        }
        const dot = document.querySelector('.status .dot');
        if (dot) dot.className = 'dot ok';

        pageT = j.t;
        document.body.dataset.t = String(j.t);
        if (j.a.USDIRR?.v) document.body.dataset.usd = String(j.a.USDIRR.v);

        // Background cache revalidation
        fetch(location.href, { cache: 'reload' }).catch(() => {});

        setTimeout(() => {
          document.querySelectorAll('.flash-update').forEach((el) => el.classList.remove('flash-update'));
        }, 1500);

        msg.textContent = L.fastUpdated || L.upToDate;
      } else {
        msg.textContent = L.upToDate;
      }
    } catch {
      msg.textContent = L.failed;
    }
    setTimeout(() => { msg.textContent = ''; btn.disabled = false; busy = false; }, 2500);
  });
})();
