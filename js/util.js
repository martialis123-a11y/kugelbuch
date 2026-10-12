// Kleine Helfer: IDs, Zeit- und Zahlformate, HTML-Escaping

export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const nf1 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
export const num = (n, digits = 1) => (digits === 0 ? nf0 : nf1).format(n ?? 0);

// Sekunden → "1:05" bzw. "1:02:05"
export function clock(sec, { forceHours = false } = {}) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h > 0 || forceHours ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// Sekunden → "45 min", "1 h 20 min", "30 s"
export function duration(sec) {
  sec = Math.round(sec || 0);
  if (sec < 60) return `${sec} s`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h === 0) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

// Kurze Zeit für Sätze: 45 s, 1:30 min
export function setTime(sec) {
  if (!sec) return '';
  if (sec < 60) return `${sec} s`;
  return `${clock(sec)} min`;
}

// "1:30" oder "90" → 90
export function parseTime(str) {
  if (str == null) return null;
  str = String(str).trim().replace(',', '.');
  if (!str) return null;
  if (str.includes(':')) {
    const parts = str.split(':').map(Number);
    if (parts.some(isNaN)) return null;
    return parts.reduce((acc, p) => acc * 60 + p, 0);
  }
  const n = Number(str);
  return isNaN(n) ? null : Math.round(n);
}

const dfDay = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric', year: 'numeric' });
const dfLong = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const dfShort = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'numeric', year: '2-digit' });
const dfMonth = new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' });
const dfMonthShort = new Intl.DateTimeFormat('de-DE', { month: 'short' });
const dfTime = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });

export const fmtDay = (ts) => dfDay.format(ts);
export const fmtLong = (ts) => dfLong.format(ts);
export const fmtShort = (ts) => dfShort.format(ts);
export const fmtMonth = (ts) => dfMonth.format(ts);
export const fmtMonthShort = (ts) => dfMonthShort.format(ts);
export const fmtTime = (ts) => dfTime.format(ts);

export function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
// Montag als Wochenbeginn
export function startOfWeek(ts) {
  const d = new Date(startOfDay(ts));
  const wd = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - wd);
  return d.getTime();
}
export const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function relDays(ts) {
  const days = Math.round((startOfDay(Date.now()) - startOfDay(ts)) / 86400000);
  if (days <= 0) return 'heute';
  if (days === 1) return 'gestern';
  if (days < 30) return `vor ${days} Tagen`;
  const months = Math.round(days / 30);
  if (months < 12) return months === 1 ? 'vor einem Monat' : `vor ${months} Monaten`;
  const years = Math.round(days / 365);
  return years === 1 ? 'vor einem Jahr' : `vor ${years} Jahren`;
}

// Für <input type="datetime-local">
export function toLocalInput(ts) {
  const d = new Date(ts);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function download(filename, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
