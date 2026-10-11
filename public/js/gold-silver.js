// Interactive Gold & Silver Market Analysis Controller.
// Zero runtime dependencies.
import {
  convertWeight,
  convertCurrency,
  goldSilverRatio,
  filterTimeRange,
  computeSeriesStats,
  OUNCE_GRAMS,
} from './gold-silver-calc.js';

(() => {
  const dataEl = document.getElementById('gs-data');
  const i18nEl = document.getElementById('i18n-gs');
  if (!dataEl || !i18nEl) return;

  const D = JSON.parse(dataEl.textContent);
  const L = JSON.parse(i18nEl.textContent);
  const lang = document.documentElement.lang === 'fa' ? 'fa' : 'en';
  const isRtl = lang === 'fa';
  const LOCALE = isRtl ? 'fa-IR' : 'en-GB';

  // State
  let state = {
    asset: 'gold',     // 'gold' | 'silver' | 'ratio'
    currency: 'USD',   // 'USD' | 'EUR' | 'AED' | 'TOMAN' | 'IRR' | 'GBP'
    unit: 'oz',        // 'oz' | 'g' | 'kg'
    range: '1y',       // '1d'..'all'
  };

  // DOM elements
  const elAsset = document.getElementById('gs-asset');
  const elCurrency = document.getElementById('gs-currency');
  const elUnit = document.getElementById('gs-unit');
  const elRange = document.getElementById('gs-range');
  const elCurrencyGroup = document.getElementById('gs-f-currency');
  const elUnitGroup = document.getElementById('gs-f-unit');

  const elChartWrap = document.getElementById('gs-chart-wrap');
  const elKpiCurrent = document.getElementById('kpi-current');
  const elKpiChange = document.getElementById('kpi-change');
  const elKpiHigh = document.getElementById('kpi-high');
  const elKpiLow = document.getElementById('kpi-low');
  const elKpiRatio = document.getElementById('kpi-ratio');
  const elRangeNote = document.getElementById('gs-range-note');

  // Formatters
  const nf = (d) => new Intl.NumberFormat(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmt = (v, d = 2) => nf(d).format(v);
  const fmtPct = (c) => `${c > 0 ? '+' : ''}${fmt(c, 2)}%`;

  function getDecimals(val, currency, isRatio) {
    if (isRatio) return 2;
    if (currency === 'TOMAN' || currency === 'IRR') return 0;
    if (val < 10) return 3;
    if (val < 1000) return 2;
    return Number.isInteger(val) ? 0 : 2;
  }

  function getUnitLabel(unit) {
    return L.units[unit] || unit;
  }

  function getCurrencyLabel(currency) {
    return L.currencies[currency] || currency;
  }

  function updateControlAvailability() {
    const isRatio = state.asset === 'ratio';
    if (elCurrency) elCurrency.disabled = isRatio;
    if (elUnit) elUnit.disabled = isRatio;
    if (elCurrencyGroup) elCurrencyGroup.classList.toggle('disabled', isRatio);
    if (elUnitGroup) elUnitGroup.classList.toggle('disabled', isRatio);
  }

  function render() {
    updateControlAvailability();

    const isRatio = state.asset === 'ratio';
    const { points, note } = filterTimeRange(D, state.range);

    if (elRangeNote) {
      if (note) {
        elRangeNote.textContent = note;
        elRangeNote.removeAttribute('hidden');
      } else {
        elRangeNote.setAttribute('hidden', '');
      }
    }

    if (!points || points.length === 0) {
      elChartWrap.innerHTML = `<div class="chart-empty"><p class="muted">${L.emptyData}</p></div>`;
      return;
    }

    // Transform points according to asset, currency, and unit
    const seriesData = points.map((p) => {
      let val;
      if (state.asset === 'gold') val = p.gold;
      else if (state.asset === 'silver') val = p.silver;
      else val = p.ratio;

      if (!isRatio) {
        // Convert currency
        val = convertCurrency(val, state.currency, D.rates) ?? val;
        // Convert weight unit
        val = convertWeight(val, state.unit) ?? val;
      }

      return {
        date: p.date,
        timestamp: p.timestamp,
        value: val,
        rawGold: p.gold,
        rawSilver: p.silver,
        rawRatio: p.ratio,
      };
    });

    const values = seriesData.map((d) => d.value);
    const stats = computeSeriesStats(values);

    // Update KPI cards
    const latest = seriesData[seriesData.length - 1];
    const dec = getDecimals(latest.value, state.currency, isRatio);
    const unitSuffix = isRatio ? '' : ` ${getCurrencyLabel(state.currency)} / ${getUnitLabel(state.unit)}`;

    if (elKpiCurrent) elKpiCurrent.textContent = `${fmt(latest.value, dec)}${unitSuffix}`;
    if (elKpiChange && stats) {
      const cls = stats.change > 0 ? 'up' : stats.change < 0 ? 'down' : 'flat';
      const arrow = stats.change > 0 ? '▲' : stats.change < 0 ? '▼' : '';
      elKpiChange.className = `kpi-val ${cls}`;
      elKpiChange.textContent = `${arrow} ${fmt(stats.change, dec)} (${fmtPct(stats.changePct)})`;
    }
    if (elKpiHigh && stats) elKpiHigh.textContent = fmt(stats.max, dec);
    if (elKpiLow && stats) elKpiLow.textContent = fmt(stats.min, dec);
    if (elKpiRatio) elKpiRatio.textContent = fmt(latest.rawRatio, 2);

    // Build interactive SVG Chart
    renderSvgChart(seriesData, stats, dec, isRatio);
  }

  function renderSvgChart(seriesData, stats, dec, isRatio) {
    const w = 700;
    const h = 280;
    const padX = 40;
    const padY = 24;
    const n = seriesData.length;

    const min = stats ? stats.min : 0;
    const max = stats ? stats.max : 1;
    const span = max - min || 1;

    const x = (i) => padX + (i / Math.max(1, n - 1)) * (w - 2 * padX);
    const y = (v) => h - padY - ((v - min) / span) * (h - 2 * padY);

    const pointsStr = seriesData.map((d, i) => `${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join(' ');
    const strokeColor = state.asset === 'gold' ? '#d97706' : state.asset === 'silver' ? '#64748b' : '#3b82f6';
    const areaColor = state.asset === 'gold' ? 'rgba(217, 119, 6, 0.12)' : state.asset === 'silver' ? 'rgba(100, 116, 139, 0.12)' : 'rgba(59, 130, 246, 0.12)';

    const areaPath = `M ${x(0).toFixed(1)},${h - padY} ` +
      seriesData.map((d, i) => `L ${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join(' ') +
      ` L ${x(n - 1).toFixed(1)},${h - padY} Z`;

    const mid = (min + max) / 2;

    const svg = `
      <svg class="gs-chart-svg" viewBox="0 0 ${w} ${h}" role="region" aria-label="${L.chartAria}">
        <defs>
          <linearGradient id="gs-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${strokeColor}" stop-opacity="0.22"/>
            <stop offset="100%" stop-color="${strokeColor}" stop-opacity="0.01"/>
          </linearGradient>
        </defs>

        <!-- Grid lines & axis labels -->
        <line x1="${padX}" y1="${y(max).toFixed(1)}" x2="${w - padX}" y2="${y(max).toFixed(1)}" stroke="currentColor" stroke-opacity=".12"/>
        <line x1="${padX}" y1="${y(mid).toFixed(1)}" x2="${w - padX}" y2="${y(mid).toFixed(1)}" stroke="currentColor" stroke-opacity=".08" stroke-dasharray="3,3"/>
        <line x1="${padX}" y1="${y(min).toFixed(1)}" x2="${w - padX}" y2="${y(min).toFixed(1)}" stroke="currentColor" stroke-opacity=".12"/>

        <text x="${isRtl ? w - padX : padX}" y="${y(max) - 4}" font-size="10" text-anchor="${isRtl ? 'end' : 'start'}" fill="currentColor" fill-opacity=".55">${fmt(max, dec)}</text>
        <text x="${isRtl ? w - padX : padX}" y="${y(mid) - 3}" font-size="10" text-anchor="${isRtl ? 'end' : 'start'}" fill="currentColor" fill-opacity=".4">${fmt(mid, dec)}</text>
        <text x="${isRtl ? w - padX : padX}" y="${y(min) + 12}" font-size="10" text-anchor="${isRtl ? 'end' : 'start'}" fill="currentColor" fill-opacity=".55">${fmt(min, dec)}</text>

        <!-- X-axis date labels -->
        <text x="${padX}" y="${h - 4}" font-size="10" fill="currentColor" fill-opacity=".55">${seriesData[0].date}</text>
        <text x="${w - padX}" y="${h - 4}" font-size="10" text-anchor="end" fill="currentColor" fill-opacity=".55">${seriesData[n - 1].date}</text>

        <!-- Area & line -->
        <path d="${areaPath}" fill="url(#gs-grad)"/>
        <polyline fill="none" stroke="${strokeColor}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" points="${pointsStr}"/>

        <!-- Interactive hover elements -->
        <line id="gs-cursor-line" x1="0" y1="${padY}" x2="0" y2="${h - padY}" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.2" stroke-dasharray="3,3" style="display:none;"/>
        <circle id="gs-cursor-dot" cx="0" cy="0" r="4.5" fill="${strokeColor}" stroke="#fff" stroke-width="2" style="display:none;"/>
      </svg>
      <div id="gs-tooltip" class="gs-tooltip" style="display:none;" aria-hidden="true"></div>
    `;

    elChartWrap.innerHTML = svg;

    // Attach crosshair interactions
    const svgEl = elChartWrap.querySelector('.gs-chart-svg');
    const lineEl = document.getElementById('gs-cursor-line');
    const dotEl = document.getElementById('gs-cursor-dot');
    const tooltipEl = document.getElementById('gs-tooltip');

    if (!svgEl || !lineEl || !dotEl || !tooltipEl) return;

    function handlePointer(clientX, clientY) {
      const rect = svgEl.getBoundingClientRect();
      const pointerX = clientX - rect.left;
      const svgX = (pointerX / rect.width) * w;

      if (svgX < padX || svgX > w - padX) {
        lineEl.style.display = 'none';
        dotEl.style.display = 'none';
        tooltipEl.style.display = 'none';
        return;
      }

      // Find closest index
      const ratioX = (svgX - padX) / (w - 2 * padX);
      const idx = Math.min(n - 1, Math.max(0, Math.round(ratioX * (n - 1))));
      const pt = seriesData[idx];

      const px = x(idx);
      const py = y(pt.value);

      lineEl.setAttribute('x1', px.toFixed(1));
      lineEl.setAttribute('x2', px.toFixed(1));
      lineEl.style.display = 'block';

      dotEl.setAttribute('cx', px.toFixed(1));
      dotEl.setAttribute('cy', py.toFixed(1));
      dotEl.style.display = 'block';

      // Tooltip content
      const unitStr = isRatio ? '' : ` ${getCurrencyLabel(state.currency)} / ${getUnitLabel(state.unit)}`;
      tooltipEl.innerHTML = `
        <div class="tt-date">${pt.date}</div>
        <div class="tt-val"><strong>${fmt(pt.value, dec)}</strong>${unitStr}</div>
        ${!isRatio ? `<div class="tt-sub">${L.ratio}: ${fmt(pt.rawRatio, 2)}</div>` : ''}
      `;
      tooltipEl.style.display = 'block';

      // Position tooltip inside wrap
      const relX = (px / w) * rect.width;
      const relY = (py / h) * rect.height;
      const ttWidth = tooltipEl.offsetWidth || 130;
      let left = relX - ttWidth / 2;
      if (left < 6) left = 6;
      if (left + ttWidth > rect.width - 6) left = rect.width - ttWidth - 6;

      tooltipEl.style.left = `${left}px`;
      tooltipEl.style.top = `${Math.max(6, relY - 58)}px`;
    }

    svgEl.addEventListener('mousemove', (e) => handlePointer(e.clientX, e.clientY));
    svgEl.addEventListener('mouseleave', () => {
      lineEl.style.display = 'none';
      dotEl.style.display = 'none';
      tooltipEl.style.display = 'none';
    });

    svgEl.addEventListener('touchmove', (e) => {
      if (e.touches && e.touches[0]) {
        handlePointer(e.touches[0].clientX, e.touches[0].clientY);
      }
    }, { passive: true });
    svgEl.addEventListener('touchend', () => {
      lineEl.style.display = 'none';
      dotEl.style.display = 'none';
      tooltipEl.style.display = 'none';
    });
  }

  // Event listeners on controls
  if (elAsset) {
    elAsset.addEventListener('change', (e) => {
      state.asset = e.target.value;
      render();
    });
  }
  if (elCurrency) {
    elCurrency.addEventListener('change', (e) => {
      state.currency = e.target.value;
      render();
    });
  }
  if (elUnit) {
    elUnit.addEventListener('change', (e) => {
      state.unit = e.target.value;
      render();
    });
  }
  if (elRange) {
    elRange.addEventListener('change', (e) => {
      state.range = e.target.value;
      render();
    });
  }

  // Initial render
  render();
})();
