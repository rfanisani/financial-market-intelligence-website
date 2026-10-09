// Footer "refresh" button. Checks data/current.json (cache-busted) and reloads
// the page when fresher data has been published since this page was built.
// If the content is already current, it says so inline instead of reloading.
(() => {
  const btn = document.getElementById('refresh-btn');
  const msg = document.getElementById('refresh-msg');
  if (!btn || !msg) return;
  const L = JSON.parse(document.getElementById('i18n-refresh').textContent);
  const pageT = Number(document.body.dataset.t);
  // Pages live at /<lang>/ and /<lang>/<section>/ — derive the root-relative
  // prefix from the path depth so data/current.json always resolves.
  const depth = location.pathname.replace(/\/index\.html$/, '/').split('/').filter(Boolean).length;
  const prefix = '../'.repeat(depth);
  let busy = false;

  btn.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    msg.textContent = L.refreshing;
    try {
      const res = await fetch(`${prefix}data/current.json?_=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const j = await res.json();
      if (Number.isFinite(j.t) && Number.isFinite(pageT) && j.t > pageT) {
        // Fresher data is published: revalidate this HTML (bypass the cache,
        // which also updates it) and reload so the new content is shown.
        await fetch(location.href, { cache: 'reload' }).catch(() => {});
        location.reload();
        return; // the page is unloading
      }
      msg.textContent = L.upToDate;
    } catch {
      msg.textContent = L.failed;
    }
    setTimeout(() => { msg.textContent = ''; btn.disabled = false; busy = false; }, 2500);
  });
})();
