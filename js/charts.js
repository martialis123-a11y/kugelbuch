// Schlanke SVG-Diagramme ohne externe Bibliotheken (läuft offline)
import { num, fmtMonthShort, dayKey, startOfWeek, esc } from './util.js';

const NS = 'http://www.w3.org/2000/svg';

function niceTicks(max, count = 4) {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(+v.toFixed(6));
  if (ticks[ticks.length - 1] < max) ticks.push(+(ticks[ticks.length - 1] + step).toFixed(6));
  return ticks;
}

function shortNum(v) {
  if (v >= 10000) return `${num(v / 1000, 0)}k`;
  if (v >= 1000) return `${num(v / 1000, 1)}k`;
  return num(v, 1);
}

// Gemeinsamer Tooltip je Diagramm: Antippen oder Überfahren zeigt den Wert
function attachTooltip(wrap, svg) {
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  wrap.appendChild(tip);
  let activeEl = null;
  function show(target, clientX, clientY) {
    const html = target.dataset.tip;
    if (!html) return;
    if (activeEl) activeEl.classList.remove('is-active');
    activeEl = svg.querySelector(`[data-mark="${target.dataset.hit}"]`);
    activeEl?.classList.add('is-active');
    tip.innerHTML = html;
    tip.hidden = false;
    const wr = wrap.getBoundingClientRect();
    const tw = tip.offsetWidth;
    let x = clientX - wr.left + wrap.scrollLeft - tw / 2;
    x = Math.max(wrap.scrollLeft + 4, Math.min(x, wrap.scrollLeft + wr.width - tw - 4));
    let y = clientY - wr.top - tip.offsetHeight - 14;
    if (y < 0) y = clientY - wr.top + 18;
    tip.style.transform = `translate(${x}px, ${y}px)`;
  }
  function hide() {
    tip.hidden = true;
    activeEl?.classList.remove('is-active');
    activeEl = null;
  }
  svg.addEventListener('pointermove', (e) => {
    const t = e.target.closest('[data-tip]');
    if (t) show(t, e.clientX, e.clientY); else if (e.pointerType === 'mouse') hide();
  });
  svg.addEventListener('pointerdown', (e) => {
    const t = e.target.closest('[data-tip]');
    if (t) show(t, e.clientX, e.clientY); else hide();
  });
  svg.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hide(); });
}

function el(tag, attrs = {}, parent) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}

// ---------- Kalender-Heatmap ----------
// days: Map(dayKey → { sec, count, label })
export function heatmap(container, days, { weeks = 53, endTs = Date.now() } = {}) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'chart-wrap heat-wrap';
  container.appendChild(wrap);

  const cell = 14, gap = 3, left = 22, top = 18;
  const endWeek = startOfWeek(endTs);
  const firstWeek = endWeek - (weeks - 1) * 7 * 86400000;
  const W = left + weeks * (cell + gap);
  const H = top + 7 * (cell + gap);
  const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Trainingskalender' }, wrap);

  ['Mo', '', 'Mi', '', 'Fr', '', ''].forEach((d, i) => {
    if (d) el('text', { x: 0, y: top + i * (cell + gap) + cell - 3, class: 'axis-label' }, svg).textContent = d;
  });

  let lastMonth = -1;
  const today = dayKey(Date.now());
  for (let w = 0; w < weeks; w++) {
    const weekStart = new Date(firstWeek);
    weekStart.setDate(weekStart.getDate() + w * 7);
    const m = weekStart.getMonth();
    if (m !== lastMonth) {
      if (w < weeks - 1) el('text', { x: left + w * (cell + gap), y: 11, class: 'axis-label' }, svg).textContent = fmtMonthShort(weekStart);
      lastMonth = m;
    }
    for (let d = 0; d < 7; d++) {
      const day = new Date(weekStart);
      day.setDate(day.getDate() + d);
      if (day.getTime() > endTs) continue;
      const key = dayKey(day);
      const info = days.get(key);
      const min = info ? info.sec / 60 : 0;
      const lvl = !info ? 0 : min < 20 ? 1 : min < 40 ? 2 : min < 60 ? 3 : 4;
      const r = el('rect', {
        x: left + w * (cell + gap), y: top + d * (cell + gap), width: cell, height: cell, rx: 3,
        class: `heat heat-${lvl}${key === today ? ' is-today' : ''}`,
        'data-mark': key, 'data-hit': key,
        'data-tip': `<strong>${day.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</strong><br>${info ? esc(info.label) : 'kein Training'}`,
      }, svg);
      r.style.cursor = 'pointer';
    }
  }
  attachTooltip(wrap, svg);
  requestAnimationFrame(() => { wrap.scrollLeft = wrap.scrollWidth; });
}

// ---------- Säulendiagramm ----------
// data: [{ label, value, tip, tickLabel? }]
export function bars(container, data, { unit = '', height = 190 } = {}) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'chart-wrap';
  container.appendChild(wrap);
  const W = Math.max(280, container.clientWidth || 320);
  const H = height;
  const pad = { l: 40, r: 6, t: 10, b: 24 };
  const max = Math.max(...data.map((d) => d.value), 0);
  const ticks = niceTicks(max);
  const yMax = ticks[ticks.length - 1] || 1;
  const svg = el('svg', { width: '100%', height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Säulendiagramm' }, wrap);
  const ih = H - pad.t - pad.b;
  const iw = W - pad.l - pad.r;
  const y = (v) => pad.t + ih - (v / yMax) * ih;

  for (const t of ticks) {
    el('line', { x1: pad.l, x2: W - pad.r, y1: y(t), y2: y(t), class: t === 0 ? 'axis-base' : 'grid' }, svg);
    el('text', { x: pad.l - 6, y: y(t) + 4, 'text-anchor': 'end', class: 'axis-label' }, svg).textContent = shortNum(t);
  }
  const n = data.length || 1;
  const slot = iw / n;
  const bw = Math.max(2, Math.min(28, slot - 2));
  data.forEach((d, i) => {
    const x = pad.l + i * slot + (slot - bw) / 2;
    if (d.value > 0) {
      const h = Math.max(2, (d.value / yMax) * ih);
      const r = Math.min(4, bw / 2);
      // oben abgerundet, unten am Nullpunkt gerade
      const top = pad.t + ih - h;
      el('path', {
        d: `M${x},${pad.t + ih} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${pad.t + ih} Z`,
        class: 'bar', 'data-mark': i,
      }, svg);
    }
    if (d.tickLabel) el('text', { x: x + bw / 2, y: H - 6, 'text-anchor': 'middle', class: 'axis-label' }, svg).textContent = d.tickLabel;
    el('rect', { x: pad.l + i * slot, y: pad.t, width: slot, height: ih, class: 'hit', 'data-hit': i, 'data-tip': d.tip || `${esc(d.label)}: ${num(d.value)} ${unit}` }, svg);
  });
  attachTooltip(wrap, svg);
}

// ---------- Verlaufslinie über die Zeit ----------
// points: [{ x: timestamp, y, tip }]
export function timeline(container, points, { unit = '', height = 200, step = false, yFrom0 = false } = {}) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'chart-wrap';
  container.appendChild(wrap);
  const W = Math.max(280, container.clientWidth || 320);
  const H = height;
  const pad = { l: 40, r: 12, t: 12, b: 24 };
  const svg = el('svg', { width: '100%', height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Verlaufsdiagramm' }, wrap);
  const ih = H - pad.t - pad.b;
  const iw = W - pad.l - pad.r;
  const xs = points.map((p) => p.x);
  let x0 = Math.min(...xs), x1 = Math.max(...xs);
  if (x0 === x1) { x0 -= 7 * 86400000; x1 += 7 * 86400000; }
  const ysRaw = points.map((p) => p.y);
  const yMaxRaw = Math.max(...ysRaw);
  const yMinRaw = Math.min(...ysRaw);
  let ticks;
  if (yFrom0 || yMinRaw <= yMaxRaw * 0.35) {
    ticks = niceTicks(yMaxRaw);
  } else {
    // Bereich um die Werte, damit Fortschritt sichtbar wird
    const span = Math.max(1, yMaxRaw - yMinRaw);
    const t = niceTicks(span * 1.2, 4);
    const step = t[1] - t[0];
    const lo = Math.floor((yMinRaw - span * 0.1) / step) * step;
    ticks = [];
    for (let v = Math.max(0, lo); v <= yMaxRaw + step * 0.999; v += step) ticks.push(+v.toFixed(6));
    if (ticks[ticks.length - 1] < yMaxRaw) ticks.push(ticks[ticks.length - 1] + step);
  }
  const yLo = ticks[0], yHi = ticks[ticks.length - 1] || 1;
  const x = (v) => pad.l + ((v - x0) / (x1 - x0)) * iw;
  const y = (v) => pad.t + ih - ((v - yLo) / (yHi - yLo || 1)) * ih;

  for (const t of ticks) {
    el('line', { x1: pad.l, x2: W - pad.r, y1: y(t), y2: y(t), class: t === yLo ? 'axis-base' : 'grid' }, svg);
    el('text', { x: pad.l - 6, y: y(t) + 4, 'text-anchor': 'end', class: 'axis-label' }, svg).textContent = shortNum(t);
  }
  // Monats- oder Jahresmarken
  const spanDays = (x1 - x0) / 86400000;
  const d = new Date(x0); d.setDate(1); d.setHours(0, 0, 0, 0);
  const stepMonths = spanDays > 900 ? 6 : spanDays > 400 ? 3 : spanDays > 150 ? 2 : 1;
  let lastX = -100;
  while (d.getTime() <= x1) {
    if (d.getTime() >= x0) {
      const px = x(d.getTime());
      if (px - lastX > 34) {
        const label = d.getMonth() === 0 || stepMonths >= 6 ? `${fmtMonthShort(d)} ${String(d.getFullYear()).slice(2)}` : fmtMonthShort(d);
        el('text', { x: px, y: H - 6, 'text-anchor': 'middle', class: 'axis-label' }, svg).textContent = label;
        lastX = px;
      }
    }
    d.setMonth(d.getMonth() + stepMonths);
  }

  const sorted = [...points].sort((a, b) => a.x - b.x);
  if (sorted.length > 1) {
    let dPath = `M${x(sorted[0].x)},${y(sorted[0].y)}`;
    for (let i = 1; i < sorted.length; i++) {
      dPath += step ? ` H${x(sorted[i].x)} V${y(sorted[i].y)}` : ` L${x(sorted[i].x)},${y(sorted[i].y)}`;
    }
    el('path', { d: dPath, class: 'line' }, svg);
  }
  sorted.forEach((p, i) => {
    el('circle', { cx: x(p.x), cy: y(p.y), r: 4.5, class: 'dot', 'data-mark': i }, svg);
  });
  // Trefferflächen: je Punkt ein Streifen bis zur Mitte zum Nachbarn
  sorted.forEach((p, i) => {
    const prev = i > 0 ? (x(sorted[i - 1].x) + x(p.x)) / 2 : pad.l;
    const next = i < sorted.length - 1 ? (x(sorted[i + 1].x) + x(p.x)) / 2 : W - pad.r;
    el('rect', { x: prev, y: pad.t, width: Math.max(1, next - prev), height: ih, class: 'hit', 'data-hit': i, 'data-tip': p.tip || `${num(p.y)} ${unit}` }, svg);
  });
  attachTooltip(wrap, svg);
}
