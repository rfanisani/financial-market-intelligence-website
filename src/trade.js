// Gold buy / sell calculator (trade page). All formulas live in calc.js.
// Ounce price and USD rate follow the live feed until the visitor edits them.
import {
  tomanPerGram, buyTotal, sellTotal, karatOf,
  PURITY_MIN, PURITY_MAX, BUY_WAGE_MAX_PCT, SELL_FEE_MAX_PCT,
} from './calc.js';

const $ = (id) => document.getElementById(id);
const lang = document.documentElement.lang === 'fa' ? 'fa' : 'en';
const L = JSON.parse(document.getElementById('i18n-trade').textContent);
const LOC = lang === 'fa' ? 'fa-IR' : 'en-US';
const nf0 = new Intl.NumberFormat(LOC, { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat(LOC, { maximumFractionDigits: 2 });

const params = $('trade-params');
const DEFAULT = { ounce: params.dataset.xau, usd: params.dataset.usd };
const live = { ...DEFAULT };          // latest live values (or build-time values)
const touched = { ounce: false, usd: false };

// Accepts Persian and Arabic digits, the Persian decimal mark and thousands separators.
function parseNum(raw) {
  const s = String(raw ?? '').trim()
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/٫/g, '.').replace(/[،,\s]/g, '');
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  return Number(s);
}

const row = (label, value, strong = false) =>
  `<dt>${label}</dt><dd class="num">${strong ? `<strong>${value}</strong>` : value}</dd>`;

function compute() {
  const purity = parseNum($('purity').value);
  const ounce = parseNum($('ounce').value);
  const usd = parseNum($('usd').value);
  const grams = parseNum($('bGrams').value);
  const sGrams = parseNum($('sGrams').value);
  const wage = parseNum($('wage').value);
  const fee = parseNum($('fee').value);

  // Parameters
  const purityOk = purity != null && purity >= PURITY_MIN && purity <= PURITY_MAX;
  $('karat').textContent = purityOk ? L.karat.replace('{k}', nf2.format(karatOf(purity))) : '';
  const paramErr = !purityOk ? L.errPurity : ounce == null ? L.errOunce : usd == null ? L.errUsd : '';
  $('perr').textContent = paramErr;

  const perGram = paramErr ? null : tomanPerGram({ ounceUsd: ounce, usdToman: usd, purity });
  $('pg').textContent = perGram ? nf0.format(perGram) : '—';
  $('srcLine').textContent = L.src
    .replace('{xau}', ounce != null ? nf2.format(ounce) : '—')
    .replace('{usd}', usd != null ? nf0.format(usd) : '—');

  // Buy: grams -> value -> seller wage -> total
  const buyOk = perGram && grams != null && wage != null && wage >= 0 && wage <= BUY_WAGE_MAX_PCT;
  $('buyErr').textContent = !perGram ? '' : grams == null ? L.errGrams : !(wage >= 0 && wage <= BUY_WAGE_MAX_PCT) ? L.errWage : '';
  const b = buyOk ? buyTotal({ grams, perGram, wagePct: wage }) : null;
  $('buyOut').innerHTML = b
    ? row(L.buyBase, nf0.format(b.base)) + row(L.buyWage, nf0.format(b.wage)) + row(L.buyTotal, nf0.format(b.total), true)
    : '';

  // Sell: grams -> value -> shop deduction -> received
  const sellOk = perGram && sGrams != null && fee != null && fee >= 0 && fee <= SELL_FEE_MAX_PCT;
  $('sellErr').textContent = !perGram ? '' : sGrams == null ? L.errGrams : !(fee >= 0 && fee <= SELL_FEE_MAX_PCT) ? L.errFee : '';
  const s = sellOk ? sellTotal({ grams: sGrams, perGram, feePct: fee }) : null;
  $('sellOut').innerHTML = s
    ? row(L.sellBase, nf0.format(s.base)) + row(L.sellFee, nf0.format(s.fee)) + row(L.sellTotal, nf0.format(s.total), true)
    : '';
}

// Manual edits stop the live update for that field.
$('ounce').addEventListener('input', () => { touched.ounce = true; compute(); });
$('usd').addEventListener('input', () => { touched.usd = true; compute(); });
for (const id of ['purity', 'bGrams', 'wage', 'sGrams', 'fee']) {
  $(id).addEventListener('input', compute);
}

$('useLive').addEventListener('click', () => {
  touched.ounce = false;
  touched.usd = false;
  $('ounce').value = String(Math.round(live.ounce * 100) / 100);
  $('usd').value = String(Math.round(live.usd));
  compute();
});

// Live feed (live.js): update the inputs that the visitor has not edited.
document.addEventListener('market:live', (e) => {
  const a = e.detail?.a || {};
  if (a.XAU?.v > 0) {
    live.ounce = a.XAU.v;
    if (!touched.ounce) $('ounce').value = String(Math.round(a.XAU.v * 100) / 100);
  }
  if (a.USDIRR?.v > 0) {
    live.usd = a.USDIRR.v;
    if (!touched.usd) $('usd').value = String(Math.round(a.USDIRR.v));
  }
  compute();
});

compute();
