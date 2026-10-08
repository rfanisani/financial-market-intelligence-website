// Calculator page logic. The formula itself lives in calc.js (single source).
import { impliedUsd, difference, expectedDomesticPrice } from './calc.js';

const $ = (id) => document.getElementById(id);
const lang = document.documentElement.lang === 'fa' ? 'fa' : 'en';
const L = JSON.parse(document.getElementById('i18n-calc').textContent);
const actualUsd = parseFloat(document.body.dataset.usd);
const PURITY = { k18: 0.75, k24: 0.999, coin: 0.9 };
const nf = new Intl.NumberFormat(lang === 'fa' ? 'fa-IR' : 'en-US', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat(lang === 'fa' ? 'fa-IR' : 'en-US', { maximumFractionDigits: 2 });

const num = (id) => {
  const v = parseFloat($(id).value.replace(/[,\s]/g, '').replace(/[٫،]/g, '.'));
  return Number.isFinite(v) && v > 0 ? v : null;
};

$('purity').addEventListener('change', () => {
  $('weight').value = $('purity').value === 'coin' ? '8.133' : '1';
});

$('f1').addEventListener('submit', (e) => {
  e.preventDefault();
  const out = $('r1');
  const d = num('domestic'), g = num('global'), w = num('weight') || 1;
  const implied = d && g ? impliedUsd({ domesticPrice: d, globalOunceUsd: g, purity: PURITY[$('purity').value], weightGrams: w }) : null;
  if (!implied) { out.innerHTML = `<p class="error">${L.err}</p>`; return; }
  const diff = actualUsd ? difference(actualUsd, implied) : null;
  out.innerHTML = `
    <div class="result"><b class="num">${nf2.format(implied)}</b> ${L.toman}
      <div class="sub">${L.rActual}: <span class="num">${actualUsd ? nf.format(actualUsd) : '—'}</span>${diff ? ` · ${L.rDiff}: <span class="num ${diff.abs >= 0 ? 'up' : 'down'}">${nf2.format(diff.pct)}%</span>` : ''}</div>
    </div>`;
});

$('f2').addEventListener('submit', (e) => {
  e.preventDefault();
  const out = $('r2');
  const rate = num('rate'), g = num('global2');
  const expected = rate && g ? expectedDomesticPrice({ usdRate: rate, globalOunceUsd: g, purity: 0.75, weightGrams: 1 }) : null;
  if (!expected) { out.innerHTML = `<p class="error">${L.err}</p>`; return; }
  out.innerHTML = `<div class="result"><b class="num">${nf.format(expected)}</b> ${L.toman}/${L.gram}</div>`;
});
