// Lightweight tab switcher for week/month/year trend charts. Zero dependencies.
(() => {
  document.addEventListener('click', (e) => {
    const tab = e.target.closest('.trend-tab');
    if (!tab) return;
    const card = tab.closest('.trend-card');
    if (!card) return;
    const period = tab.dataset.period;
    if (!period) return;

    for (const b of card.querySelectorAll('.trend-tab')) {
      const active = b === tab;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    for (const p of card.querySelectorAll('.trend-panel')) {
      if (p.dataset.panel === period) {
        p.removeAttribute('hidden');
      } else {
        p.setAttribute('hidden', '');
      }
    }
  });
})();
