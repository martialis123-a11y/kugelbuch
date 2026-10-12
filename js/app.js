// Kugelbuch – App-Logik und Ansichten
import {
  uid, $, $$, esc, num, clock, duration, setTime, parseTime,
  fmtDay, fmtLong, fmtMonth, fmtTime, fmtShort, startOfDay, startOfWeek, dayKey, relDays, toLocalInput, download,
} from './util.js';
import {
  state, load, saveSettings, setActive, INSTRUMENTS, sideOptions, sideLabel, METRICS, STANDARD_BELLS, bellColor,
  exById, exName, saveExercise, deleteExercise, exerciseUsage, sessionById, saveSession, deleteSession,
  setVolume, setReps, sessionDuration, sessionVolume, finishedSessions, lastPerformance,
  exportData, importData, wipeAll, STARTER_EXERCISES,
} from './store.js';
import { startTimer, startRest, stopRest, signal, initAudio, wakeOn, wakeOff } from './timer.js';
import { heatmap, bars, timeline } from './charts.js';

const VERSION = '1.0.0';
const view = $('#view');
const ui = {
  tab: 'training',
  editing: null,          // ID einer abgeschlossenen Einheit, die gerade bearbeitet wird
  drafts: new Map(),      // Eingaben je Übungseintrag: { w, r, t }
  justAdded: null,        // Satz-ID für kurzes Aufleuchten
  range: '12m',
  statEx: null,
  statMetric: null,
  historyFilter: '',
  sessionWake: false,
};

// ---------- Symbole ----------
const ICON = {
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  timer: '<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9 2h6"/></svg>',
};

// ---------- Kleine UI-Bausteine ----------
function toast(msg, action) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action.label)}</button>` : ''}`;
  t.hidden = false;
  clearTimeout(toast.timer);
  if (action) t.querySelector('button').onclick = () => { t.hidden = true; action.run(); };
  toast.timer = setTimeout(() => { t.hidden = true; }, action ? 6000 : 2600);
}

const sheets = [];
let ignorePop = 0;
function openSheet({ title, body, foot = '', onMount, onClose }) {
  const root = $('#sheet-root');
  $('#toast').hidden = true;
  const back = document.createElement('div');
  back.className = 'sheet-backdrop';
  back.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet-grip"></div>
      <div class="sheet-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="Schließen">${ICON.x}</button></div>
      <div class="sheet-body">${body}</div>
      ${foot ? `<div class="sheet-foot">${foot}</div>` : ''}
    </div>`;
  root.appendChild(back);
  const sheet = back.querySelector('.sheet');
  const entry = { back, onClose };
  sheets.push(entry);
  history.pushState({ sheet: sheets.length }, '');
  const close = (fromPop = false) => {
    const i = sheets.indexOf(entry);
    if (i < 0) return;
    sheets.splice(i, 1);
    back.remove();
    onClose?.();
    if (!fromPop && history.state?.sheet) { ignorePop++; history.back(); }
  };
  entry.close = close;
  back.addEventListener('click', (e) => {
    if (e.target === back || e.target.closest('[data-close]')) close();
  });
  onMount?.(sheet, close);
  const first = sheet.querySelector('input:not([type=hidden]), select, textarea');
  if (first && first.dataset.autofocus !== undefined) setTimeout(() => first.focus(), 80);
  return close;
}
window.addEventListener('popstate', () => {
  if (ignorePop > 0) { ignorePop--; return; }
  const top = sheets[sheets.length - 1];
  if (top) top.close(true);
});

function confirmSheet({ title, text, ok = 'OK', danger = false, cancel = 'Abbrechen' }) {
  return new Promise((resolve) => {
    let result = false;
    openSheet({
      title,
      body: `<p class="muted">${text}</p>`,
      foot: `<button class="btn btn-ghost" data-close>${esc(cancel)}</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(ok)}</button>`,
      onMount: (s, close) => { s.querySelector('[data-ok]').onclick = () => { result = true; close(); }; },
      onClose: () => resolve(result),
    });
  });
}

function stepper({ field, value, step = 1, min = 0, max = 9999, kind = 'num', entry = '', wide = false, label = '' }) {
  const display = kind === 'time' ? (value ? clock(value) : '') : value ?? '';
  return `<div class="stepper${wide ? ' wide' : ''}" data-step="${step}" data-min="${min}" data-max="${max}" data-kind="${kind}">
    <button type="button" data-stp="-1" aria-label="${esc(label)} verringern">−</button>
    <input ${kind === 'time' ? 'type="text" inputmode="numeric" placeholder="0:00"' : 'type="number" inputmode="decimal"'}
      value="${esc(display)}" data-field="${field}" ${entry ? `data-draft="${entry}"` : ''} aria-label="${esc(label)}">
    <button type="button" data-stp="1" aria-label="${esc(label)} erhöhen">+</button>
  </div>`;
}
function readStepper(input) {
  const kind = input.closest('.stepper')?.dataset.kind;
  if (kind === 'time') return parseTime(input.value);
  const v = parseFloat(String(input.value).replace(',', '.'));
  return isNaN(v) ? null : v;
}
// Plus/Minus für alle Stepper (auch in Sheets)
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-stp]');
  if (!b) return;
  const st = b.closest('.stepper');
  const input = st.querySelector('input');
  const step = parseFloat(st.dataset.step);
  const min = parseFloat(st.dataset.min);
  const max = parseFloat(st.dataset.max);
  let v = readStepper(input) ?? 0;
  v = Math.round((v + step * Number(b.dataset.stp)) * 100) / 100;
  // auf Schrittweite einrasten
  if (st.dataset.kind !== 'time' && step >= 1) v = Math.round(v / step) * step;
  v = Math.max(min, Math.min(max, v));
  input.value = st.dataset.kind === 'time' ? clock(v) : String(v);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});

function seg(name, options, value) {
  return `<div class="seg" role="group" data-seg="${name}">${Object.entries(options)
    .map(([k, l]) => `<button type="button" data-val="${k}" aria-pressed="${k === value}">${esc(l)}</button>`).join('')}</div>`;
}
function segValue(root, name) {
  return root.querySelector(`[data-seg="${name}"] [aria-pressed="true"]`)?.dataset.val;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-seg] > button');
  if (!b) return;
  const g = b.parentElement;
  $$('button', g).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  g.dispatchEvent(new CustomEvent('segchange', { bubbles: true, detail: b.dataset.val }));
});

function bellSvg(w) {
  const [fill, tone] = bellColor(w);
  const txt = tone === 'dark' ? '#1B1B1B' : '#FFFFFF';
  const label = Number.isInteger(w) ? w : num(w);
  return `<svg viewBox="0 0 44 48" aria-hidden="true">
    <path class="b-handle" d="M12.5 23 C9 5, 35 5, 31.5 23"/>
    <circle class="b-ring" cx="22" cy="30" r="17.5"/>
    <circle class="b-body" cx="22" cy="30" r="15" fill="${fill}"/>
    <text x="22" y="34.5" text-anchor="middle" fill="${txt}">${label}</text></svg>`;
}
function weightDot(w) {
  const [fill] = bellColor(w);
  return `<span class="dotw" style="background:${fill}"></span>`;
}

function weightText(ex, w) {
  if (!w) return '–';
  if (ex?.instrument === 'bw') return `+${num(w)} kg`;
  if (ex?.side === 'double') return `2 × ${num(w)} kg`;
  return `${num(w)} kg`;
}
function entrySummary(ex, entry) {
  // gleiche Sätze zusammenfassen: "3 × 10 @ 24 kg"
  const groups = [];
  for (const s of entry.sets) {
    const key = `${s.w}|${s.r}|${s.t}`;
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.n++;
    else groups.push({ key, n: 1, s });
  }
  return groups.map((g) => {
    const s = g.s;
    const bits = [];
    if (s.r) bits.push(`${g.n > 1 ? `${g.n} × ` : ''}${num(s.r)}${ex?.side === 'one' ? '/Seite' : ''}`);
    else if (g.n > 1) bits.push(`${g.n} ×`);
    if (s.t) bits.push(s.r ? `in ${setTime(s.t)}` : setTime(s.t));
    let txt = bits.join(' ');
    if (s.w) txt += ` mit ${weightText(ex, s.w)}`;
    return txt.trim();
  }).join(', ');
}

// ---------- Navigation ----------
function setTab(tab) {
  const ed = ui.editing && sessionById(ui.editing);
  if (ed && !ed.entries.length) deleteSession(ed.id);
  ui.tab = tab;
  ui.editing = null;
  render();
  window.scrollTo(0, 0);
}
$$('.tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

function render() {
  $$('.tabs button').forEach((b) => {
    if (b.dataset.tab === ui.tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  $('.tabs [data-tab="training"]').classList.toggle('has-live', !!state.activeId);
  const extra = $('#appbar-extra');
  extra.innerHTML = '';
  if (ui.editing && sessionById(ui.editing)) return renderEditor(sessionById(ui.editing), 'edit');
  ui.editing = null;
  ({ training: renderTraining, verlauf: renderHistory, auswertung: renderStats, uebungen: renderExercises, daten: renderData })[ui.tab]();
}
function setTitle(t) { $('#title').textContent = t; document.title = t === 'Kugelbuch' ? 'Kugelbuch' : `${t} – Kugelbuch`; }

// ---------- Backup-Erinnerung ----------
function needsBackup() {
  const done = finishedSessions();
  if (!done.length) return false;
  const last = state.settings.lastBackup;
  if (!last) return done.length >= 2 || Date.now() - done[done.length - 1].start > 3 * 86400000;
  const newer = done.some((s) => (s.end || s.start) > last || (s.edited || 0) > last);
  return newer && Date.now() - last > state.settings.backupNagDays * 86400000;
}
function backupNotice() {
  if (!needsBackup()) return '';
  const last = state.settings.lastBackup;
  return `<div class="notice">
    <div class="grow">
      <strong>Zeit für ein Backup.</strong>
      <p>${last ? `Dein letztes Backup ist ${relDays(last).replace('vor ', '')} alt.` : 'Du hast noch kein Backup gespeichert.'} Deine Daten liegen nur auf diesem Handy.</p>
      <button class="btn btn-s btn-primary" data-act="backup-now">Backup speichern</button>
    </div></div>`;
}

// =====================================================================
// Training
// =====================================================================
function renderTraining() {
  const active = state.activeId && sessionById(state.activeId);
  if (active) return renderEditor(active, 'live');
  setTitle('Kugelbuch');

  const weekStart = startOfWeek(Date.now());
  const trainedDays = new Set(finishedSessions().filter((s) => s.start >= weekStart).map((s) => dayKey(s.start)));
  const todayKey = dayKey(Date.now());
  const days = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].map((d, i) => {
    const k = dayKey(weekStart + i * 86400000 + 3600000 * 3);
    return `<div class="${k === todayKey ? 'today' : ''}"><i class="${trainedDays.has(k) ? 'on' : ''}"></i><b>${d}</b></div>`;
  }).join('');
  const weekCount = finishedSessions().filter((s) => s.start >= weekStart).length;
  const last = finishedSessions()[0];

  view.innerHTML = `
    <div class="stack-l">
      ${backupNotice()}
      ${!state.exercises.length ? `
        <div class="panel stack">
          <h2>Willkommen</h2>
          <p class="muted">Lege zuerst deine Übungen an. Du kannst auch mit einer Auswahl typischer Kugelhantel- und Körpergewichtsübungen starten und sie danach anpassen.</p>
          <div class="row" style="flex-wrap:wrap">
            <button class="btn btn-primary" data-act="new-exercise">Übung anlegen</button>
            <button class="btn btn-ghost" data-act="starter">Beispielübungen übernehmen</button>
          </div>
        </div>` : ''}
      <section class="start">
        <div class="row-between">
          <h2>Diese Woche</h2>
          <span class="muted small">${weekCount === 0 ? 'noch kein Training' : weekCount === 1 ? '1 Einheit' : `${weekCount} Einheiten`}</span>
        </div>
        <div class="start-week">${days}</div>
        <button class="btn btn-primary btn-xl btn-block" data-act="start">Training starten</button>
        <button class="btn btn-text" data-act="backfill">Vergangenes Training nachtragen</button>
      </section>
      ${last ? `
        <section>
          <div class="section-title"><h2>Letztes Training</h2><span class="muted small">${relDays(last.start)}</span></div>
          <div class="list">${historyItem(last)}</div>
          <button class="btn btn-ghost btn-block" style="margin-top:12px" data-act="repeat" data-id="${last.id}">Mit diesen Übungen starten</button>
        </section>` : ''}
    </div>`;
}

async function startTraining(template) {
  if (state.activeId) { setTab('training'); return; }
  initAudio();
  const s = { id: uid(), start: Date.now(), end: null, entries: [], note: '' };
  if (template) s.entries = template.entries.map((e) => ({ id: uid(), exId: e.exId, sets: [] }));
  await saveSession(s);
  await setActive(s.id);
  requestPersist();
  sessionWakeOn();
  ui.tab = 'training';
  ui.editing = null;
  render();
  if (!template) openExercisePicker(s);
}
function sessionWakeOn() { if (!ui.sessionWake) { ui.sessionWake = true; wakeOn(); } }
function sessionWakeOff() { if (ui.sessionWake) { ui.sessionWake = false; wakeOff(); } }

async function backfill() {
  const d = new Date();
  d.setMinutes(Math.floor(d.getMinutes() / 15) * 15, 0, 0);
  const start = d.getTime() - 3600000;
  const s = { id: uid(), start, end: start + 45 * 60000, entries: [], note: '', edited: Date.now() };
  await saveSession(s);
  ui.editing = s.id;
  render();
  window.scrollTo(0, 0);
}

// ---------- Editor für eine Einheit (laufend oder nachträglich) ----------
function renderEditor(s, mode) {
  const live = mode === 'live';
  setTitle(live ? 'Training läuft' : 'Training bearbeiten');
  const setCount = s.entries.reduce((n, e) => n + e.sets.length, 0);
  const head = live ? `
    <div class="live-head">
      <div>
        <div class="live-clock" data-live-clock>${clock(sessionDuration(s))}</div>
        <div class="live-meta">seit ${fmtTime(s.start)} Uhr, ${setCount === 1 ? '1 Satz' : `${setCount} Sätze`}</div>
      </div>
      <button class="btn" data-act="finish">Beenden</button>
    </div>` : `
    <div class="panel edit-head">
      <label class="field"><span>Beginn</span><input type="datetime-local" data-edit="start" value="${toLocalInput(s.start)}"></label>
      <label class="field"><span>Dauer in Minuten</span><input type="number" inputmode="numeric" min="1" data-edit="dur" value="${Math.round(sessionDuration(s) / 60)}"></label>
      <button class="btn btn-primary" data-act="edit-done">Fertig</button>
    </div>`;

  view.innerHTML = `
    ${head}
    ${s.entries.length ? s.entries.map((e) => entryCard(s, e, live)).join('') : `
      <div class="empty">
        <h2>${live ? 'Los geht’s' : 'Noch keine Übungen'}</h2>
        <p>Füge die erste Übung hinzu.</p>
      </div>`}
    <div class="stack" style="margin-top:16px">
      <button class="btn btn-ghost btn-block" data-act="add-ex">${ICON.plus} Übung hinzufügen</button>
      ${live && !s.entries.length && finishedSessions()[0] ? `<button class="btn btn-text btn-block" data-act="copy-last">Übungen vom letzten Training übernehmen</button>` : ''}
      <label class="field"><span>Notiz</span><textarea data-edit="note" placeholder="Wie lief’s? Besonderheiten?">${esc(s.note || '')}</textarea></label>
      ${live ? `<button class="btn btn-text btn-block" data-act="discard">Training verwerfen</button>` : `<button class="btn btn-danger btn-block" data-act="delete-session" data-id="${s.id}">Einheit löschen</button>`}
    </div>`;
  ui.justAdded = null;
  view.dataset.session = s.id;
}

function defaultDraft(s, entry) {
  const ex = exById(entry.exId);
  const lastSet = entry.sets[entry.sets.length - 1];
  if (lastSet) return { w: lastSet.w ?? null, r: lastSet.r ?? null, t: lastSet.t ?? null };
  const prev = lastPerformance(entry.exId, s.id);
  if (prev) {
    const f = prev.entry.sets[0];
    return { w: f.w ?? null, r: f.r ?? null, t: f.t ?? null };
  }
  const bells = state.settings.bells;
  return {
    w: ex?.instrument === 'kb' ? (bells.find((b) => b >= 16) ?? bells[0] ?? 16) : ex?.instrument === 'bb' ? 20 : null,
    r: ex?.metric === 'time' ? null : 10,
    t: ex?.metric === 'time' ? 30 : null,
  };
}
function draftFor(s, entry) {
  if (!ui.drafts.has(entry.id)) ui.drafts.set(entry.id, defaultDraft(s, entry));
  return ui.drafts.get(entry.id);
}

function entryCard(s, entry, live) {
  const ex = exById(entry.exId);
  const metric = ex?.metric || 'reps';
  const showW = ex?.instrument !== 'bw' || entry.sets.some((x) => x.w);
  const showR = metric !== 'time';
  const showT = metric !== 'reps';
  const prev = lastPerformance(entry.exId, s.id);
  const d = draftFor(s, entry);
  const repLabel = ex?.side === 'one' ? 'Wdh je Seite' : 'Wdh';

  const rows = entry.sets.map((set, i) => `
    <tr class="${set.id === ui.justAdded ? 'just-added' : ''}" data-set="${set.id}">
      <td>${i + 1}</td>
      ${showW ? `<td><span class="w-cell">${set.w && ex?.instrument === 'kb' ? weightDot(set.w) : ''}${weightText(ex, set.w)}</span></td>` : ''}
      ${showR ? `<td>${set.r ? num(set.r) : '–'}${set.tag ? ` <span class="tiny muted">${esc(set.tag)}</span>` : ''}</td>` : ''}
      ${showT ? `<td>${set.t ? setTime(set.t) : '–'}${!showR && set.tag ? ` <span class="tiny muted">${esc(set.tag)}</span>` : ''}</td>` : ''}
      <td><button class="icon-btn" data-act="edit-set" aria-label="Satz ${i + 1} bearbeiten">${ICON.more}</button></td>
    </tr>`).join('');

  // Gewichtsauswahl
  let weightUI = '';
  if (ex?.instrument === 'kb') {
    const list = [...new Set([...state.settings.bells, ...(d.w ? [d.w] : [])])].sort((a, b) => a - b);
    weightUI = `<span class="composer-label">${ex.side === 'double' ? 'Gewicht je Kugel' : 'Kugel'}</span>
      <div class="bells" role="group" aria-label="Kugel wählen">${list.map((w) => `
        <button class="bell" data-act="pick-bell" data-w="${w}" aria-pressed="${w === d.w}" aria-label="${num(w)} Kilogramm">${bellSvg(w)}</button>`).join('')}
      </div>`;
  }
  const otherWeight = ex?.instrument === 'bb' || ex?.instrument === 'other' || ex?.instrument === 'bw';

  return `
  <section class="entry" data-entry="${entry.id}">
    <div class="entry-head">
      <div class="grow">
        <div class="entry-title">${esc(exName(ex))}</div>
        <div class="entry-sub">${ex ? INSTRUMENTS[ex.instrument] : ''}${entry.sets.length ? `, ${entry.sets.length} ${entry.sets.length === 1 ? 'Satz' : 'Sätze'}` : ''}</div>
      </div>
      <button class="icon-btn" data-act="entry-menu" aria-label="Optionen für ${esc(exName(ex))}">${ICON.more}</button>
    </div>
    ${prev ? `<div class="entry-last">Letztes Mal (${fmtShort(prev.session.start)}): ${esc(entrySummary(ex, prev.entry))}</div>` : ''}
    ${entry.sets.length ? `
      <table class="sets">
        <thead><tr><th>#</th>${showW ? '<th>Gewicht</th>' : ''}${showR ? `<th>${repLabel}</th>` : ''}${showT ? '<th>Zeit</th>' : ''}<th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>` : ''}
    <div class="composer">
      ${weightUI}
      <div class="composer-row">
        ${otherWeight ? `<div><span class="composer-label">${ex?.instrument === 'bw' ? 'Zusatzgewicht kg' : 'Gewicht kg'}</span>${stepper({ field: 'w', value: d.w ?? (ex?.instrument === 'bw' ? 0 : ''), step: ex?.instrument === 'other' ? 1 : 2.5, entry: entry.id, wide: true, label: 'Gewicht' })}</div>` : ''}
        ${showR ? `<div><span class="composer-label">${repLabel}</span>${stepper({ field: 'r', value: d.r ?? '', step: 1, entry: entry.id, label: 'Wiederholungen' })}</div>` : ''}
        ${showT ? `<div><span class="composer-label">Zeit${metric === 'both' ? ' (optional)' : ''}</span>${stepper({ field: 't', value: d.t, step: 15, kind: 'time', entry: entry.id, wide: true, label: 'Zeit' })}</div>` : ''}
      </div>
      <div class="actions">
        <button class="btn btn-primary" data-act="log-set">Satz eintragen</button>
        ${live ? `
          <button class="btn btn-ghost" data-act="timer-menu" aria-label="Timer">${ICON.timer} Timer</button>` : ''}
      </div>
    </div>
  </section>`;
}

// Eingaben in der Satzzeile merken
view.addEventListener('input', async (e) => {
  const t = e.target;
  if (t.dataset.draft) {
    const d = ui.drafts.get(t.dataset.draft);
    if (d) d[t.dataset.field] = readStepper(t);
    return;
  }
  const s = sessionById(view.dataset.session);
  if (!s || !t.dataset.edit) return;
  if (t.dataset.edit === 'note') { s.note = t.value; debounceSave(s); }
  else if (t.dataset.edit === 'start' && t.value) {
    const dur = s.end - s.start;
    s.start = new Date(t.value).getTime();
    s.end = s.start + dur;
    s.edited = Date.now();
    debounceSave(s);
  } else if (t.dataset.edit === 'dur') {
    const m = parseInt(t.value, 10);
    if (m > 0) { s.end = s.start + m * 60000; s.edited = Date.now(); debounceSave(s); }
  }
});
let saveTimer;
function debounceSave(s) { clearTimeout(saveTimer); saveTimer = setTimeout(() => saveSession(s), 400); }

// Laufende Uhr
setInterval(() => {
  const el = $('[data-live-clock]');
  const s = state.activeId && sessionById(state.activeId);
  if (el && s) el.textContent = clock(sessionDuration(s));
}, 1000);

function currentSession() { return sessionById(view.dataset.session); }
function entryFromEl(el) {
  const s = currentSession();
  const id = el.closest('[data-entry]')?.dataset.entry;
  return { s, entry: s?.entries.find((e) => e.id === id) };
}

async function logSet(s, entry, values, { tag, rest = true } = {}) {
  const ex = exById(entry.exId);
  const metric = ex?.metric || 'reps';
  const set = { id: uid(), w: values.w || null, r: values.r || null, t: values.t || null, ts: Date.now() };
  if (tag) set.tag = tag;
  if (metric === 'reps' && !set.r) return toast('Trag noch die Wiederholungen ein.');
  if (metric === 'time' && !set.t) return toast('Trag noch die Zeit ein.');
  if (metric === 'both' && !set.r && !set.t) return toast('Trag Wiederholungen oder Zeit ein.');
  entry.sets.push(set);
  if (!s.end) { /* laufend */ } else s.edited = Date.now();
  await saveSession(s);
  ui.justAdded = set.id;
  const y = window.scrollY;
  render();
  window.scrollTo(0, y);
  if (rest && s.id === state.activeId && state.settings.restAuto) startRest(state.settings.restSec);
  return set;
}

view.addEventListener('click', async (e) => {
  const a = e.target.closest('[data-act]');
  if (!a) return;
  const act = a.dataset.act;
  switch (act) {
    case 'start': return startTraining();
    case 'backfill': return backfill();
    case 'repeat': return startTraining(sessionById(a.dataset.id));
    case 'starter': return addStarter();
    case 'new-exercise': return openExerciseForm();
    case 'backup-now': return doBackup();
    case 'open-session': return openSessionDetail(sessionById(a.dataset.id));
    case 'add-ex': return openExercisePicker(currentSession());
    case 'copy-last': {
      const s = currentSession();
      const last = finishedSessions()[0];
      if (!last) return;
      s.entries.push(...last.entries.map((x) => ({ id: uid(), exId: x.exId, sets: [] })));
      await saveSession(s);
      return render();
    }
    case 'finish': return finishTraining();
    case 'discard': {
      const s = currentSession();
      if (await confirmSheet({ title: 'Training verwerfen?', text: 'Alle Sätze dieser Einheit werden gelöscht.', ok: 'Verwerfen', danger: true })) {
        await deleteSession(s.id);
        stopRest();
        sessionWakeOff();
        render();
        toast('Training verworfen');
      }
      return;
    }
    case 'edit-done': {
      const s = currentSession();
      clearTimeout(saveTimer);
      if (!s.entries.length) { await deleteSession(s.id); toast('Leere Einheit verworfen'); }
      else { await saveSession(s); toast('Gespeichert'); }
      ui.editing = null;
      ui.tab = 'verlauf';
      render();
      return window.scrollTo(0, 0);
    }
    case 'delete-session': {
      const s = sessionById(a.dataset.id);
      if (await confirmSheet({ title: 'Einheit löschen?', text: `Das Training vom ${fmtDay(s.start)} wird endgültig gelöscht.`, ok: 'Löschen', danger: true })) {
        await deleteSession(s.id);
        ui.editing = null;
        render();
        toast('Einheit gelöscht');
      }
      return;
    }
    case 'pick-bell': {
      const { s, entry } = entryFromEl(a);
      const d = draftFor(s, entry);
      d.w = Number(a.dataset.w);
      $$('.bell', a.parentElement).forEach((b) => b.setAttribute('aria-pressed', String(b === a)));
      return;
    }
    case 'log-set': {
      const { s, entry } = entryFromEl(a);
      return logSet(s, entry, draftFor(s, entry));
    }
    case 'edit-set': {
      const { s, entry } = entryFromEl(a);
      const setId = a.closest('[data-set]').dataset.set;
      return openSetEditor(s, entry, entry.sets.find((x) => x.id === setId));
    }
    case 'entry-menu': {
      const { s, entry } = entryFromEl(a);
      return openEntryMenu(s, entry);
    }
    case 'timer-menu': {
      const { s, entry } = entryFromEl(a);
      return openTimerMenu(s, entry);
    }
  }
});

function openSetEditor(s, entry, set) {
  const ex = exById(entry.exId);
  const metric = ex?.metric || 'reps';
  openSheet({
    title: `Satz ${entry.sets.indexOf(set) + 1}`,
    body: `<div class="stack">
      ${ex?.instrument !== 'bw' || set.w ? `<label class="field"><span>${ex?.instrument === 'bw' ? 'Zusatzgewicht' : ex?.side === 'double' ? 'Gewicht je Kugel' : 'Gewicht'} (kg)</span>${stepper({ field: 'w', value: set.w ?? '', step: ex?.instrument === 'kb' ? 4 : 2.5, wide: true, label: 'Gewicht' })}</label>` : `<label class="field"><span>Zusatzgewicht (kg)</span>${stepper({ field: 'w', value: 0, step: 2.5, wide: true, label: 'Gewicht' })}</label>`}
      ${metric !== 'time' ? `<label class="field"><span>${ex?.side === 'one' ? 'Wiederholungen je Seite' : 'Wiederholungen'}</span>${stepper({ field: 'r', value: set.r ?? '', label: 'Wiederholungen' })}</label>` : ''}
      ${metric !== 'reps' ? `<label class="field"><span>Zeit (Minuten:Sekunden)</span>${stepper({ field: 't', value: set.t, step: 15, kind: 'time', wide: true, label: 'Zeit' })}</label>` : ''}
    </div>`,
    foot: `<button class="btn btn-danger" data-del>${ICON.trash} Löschen</button><button class="btn btn-primary" data-save>Speichern</button>`,
    onMount: (sh, close) => {
      sh.querySelector('[data-save]').onclick = async () => {
        for (const inp of $$('input[data-field]', sh)) set[inp.dataset.field] = readStepper(inp) || null;
        if (s.end) s.edited = Date.now();
        await saveSession(s);
        close();
        const y = window.scrollY; render(); window.scrollTo(0, y);
      };
      sh.querySelector('[data-del]').onclick = async () => {
        entry.sets = entry.sets.filter((x) => x !== set);
        if (s.end) s.edited = Date.now();
        await saveSession(s);
        close();
        const y = window.scrollY; render(); window.scrollTo(0, y);
        toast('Satz gelöscht', { label: 'Rückgängig', run: async () => { entry.sets.push(set); entry.sets.sort((a, b) => a.ts - b.ts); await saveSession(s); render(); } });
      };
    },
  });
}

function openEntryMenu(s, entry) {
  const ex = exById(entry.exId);
  const i = s.entries.indexOf(entry);
  openSheet({
    title: exName(ex),
    body: `<div class="list">
      ${i > 0 ? `<button class="list-item" data-m="up"><span class="grow t">Nach oben schieben</span></button>` : ''}
      ${i < s.entries.length - 1 ? `<button class="list-item" data-m="down"><span class="grow t">Nach unten schieben</span></button>` : ''}
      <button class="list-item" data-m="history"><span class="grow t">Verlauf dieser Übung</span>${ICON.chev}</button>
      <button class="list-item" data-m="remove"><span class="grow t" style="color:var(--danger)">Aus dem Training entfernen</span></button>
    </div>`,
    onMount: (sh, close) => sh.addEventListener('click', async (e) => {
      const m = e.target.closest('[data-m]')?.dataset.m;
      if (!m) return;
      if (m === 'up' || m === 'down') {
        const j = m === 'up' ? i - 1 : i + 1;
        [s.entries[i], s.entries[j]] = [s.entries[j], s.entries[i]];
        await saveSession(s); close(); render();
      } else if (m === 'history') {
        close();
        ui.statEx = entry.exId; ui.statMetric = null;
        setTab('auswertung');
        setTimeout(() => $('#ex-detail')?.scrollIntoView({ block: 'start' }), 60);
      } else if (m === 'remove') {
        close();
        if (entry.sets.length && !(await confirmSheet({ title: 'Übung entfernen?', text: `${entry.sets.length} eingetragene Sätze gehen dabei verloren.`, ok: 'Entfernen', danger: true }))) return;
        s.entries = s.entries.filter((x) => x !== entry);
        await saveSession(s); render();
      }
    }),
  });
}

// ---------- Timer starten ----------
function openTimerMenu(s, entry) {
  const ex = exById(entry.exId);
  const d = draftFor(s, entry);
  const metric = ex?.metric || 'reps';
  const wTxt = d.w ? ` mit ${weightText(ex, d.w)}` : '';
  openSheet({
    title: 'Timer',
    body: `<div class="list">
      <button class="list-item" data-t="emom"><div class="grow"><div class="t">EMOM</div><div class="s">Jede Minute (oder in deinem Intervall) eine Runde, mit Signal zum Rundenbeginn</div></div>${ICON.chev}</button>
      <button class="list-item" data-t="countdown"><div class="grow"><div class="t">Countdown / AMRAP</div><div class="s">Feste Zeit, so viele Wiederholungen wie möglich</div></div>${ICON.chev}</button>
      ${metric !== 'reps' ? `<button class="list-item" data-t="stopwatch"><div class="grow"><div class="t">Zeit messen</div><div class="s">Stoppuhr, die Zeit wird in den Satz übernommen</div></div>${ICON.chev}</button>` : ''}
      <button class="list-item" data-t="rest"><div class="grow"><div class="t">Pause jetzt starten</div><div class="s">${clock(state.settings.restSec)} min</div></div>${ICON.chev}</button>
    </div>
    <p class="small muted" style="margin-top:12px">${esc(exName(ex))}${esc(wTxt)}. Gewicht vorher in der Satzzeile wählen.</p>`,
    onMount: (sh, close) => sh.addEventListener('click', (e) => {
      const t = e.target.closest('[data-t]')?.dataset.t;
      if (!t) return;
      close();
      if (t === 'emom') setTimeout(() => openEmomSetup(s, entry), 50);
      if (t === 'countdown') setTimeout(() => openCountdownSetup(s, entry), 50);
      if (t === 'rest') startRest(state.settings.restSec);
      if (t === 'stopwatch') {
        startTimer({
          mode: 'stopwatch', title: exName(ex),
          onDone: ({ elapsed }) => {
            if (!elapsed) return;
            d.t = elapsed;
            const y = window.scrollY; render(); window.scrollTo(0, y);
            toast(`Zeit übernommen: ${setTime(elapsed)}`);
          },
        });
      }
    }),
  });
}

function openEmomSetup(s, entry) {
  const ex = exById(entry.exId);
  const d = draftFor(s, entry);
  const metric = ex?.metric || 'reps';
  const saved = state.settings.lastEmom || { interval: 60, rounds: 10 };
  openSheet({
    title: 'EMOM einstellen',
    body: `<div class="stack">
      <label class="field"><span>Intervall</span>${stepper({ field: 'interval', value: saved.interval, step: 15, min: 10, kind: 'time', wide: true, label: 'Intervall' })}<span class="hint">Meist 1:00 – jede volle Minute beginnt eine neue Runde.</span></label>
      <label class="field"><span>Runden</span>${stepper({ field: 'rounds', value: saved.rounds, step: 1, min: 1, max: 99, label: 'Runden' })}</label>
      ${metric !== 'time' ? `<label class="field"><span>${ex?.side === 'one' ? 'Wiederholungen je Runde (je Seite)' : 'Wiederholungen je Runde'}</span>${stepper({ field: 'r', value: d.r ?? 5, label: 'Wiederholungen' })}</label>` : ''}
      <p class="small muted" data-sum></p>
    </div>`,
    foot: `<button class="btn btn-primary btn-xl" data-go>Start</button>`,
    onMount: (sh, close) => {
      const sum = sh.querySelector('[data-sum]');
      const read = () => Object.fromEntries($$('input[data-field]', sh).map((i) => [i.dataset.field, readStepper(i)]));
      const upd = () => { const v = read(); sum.textContent = `Dauer: ${clock((v.interval || 0) * (v.rounds || 0))} min${d.w ? `, ${weightText(ex, d.w)}` : ''}`; };
      sh.addEventListener('input', upd); upd();
      sh.querySelector('[data-go]').onclick = async () => {
        const v = read();
        if (!v.interval || !v.rounds) return;
        state.settings.lastEmom = { interval: v.interval, rounds: v.rounds };
        saveSettings();
        if (v.r) d.r = v.r;
        close();
        startTimer({
          mode: 'emom', title: exName(ex), interval: v.interval, rounds: v.rounds,
          onDone: (res) => emomResult(s, entry, v, res),
        });
      };
    },
  });
}

function emomResult(s, entry, cfg, res) {
  const ex = exById(entry.exId);
  const d = draftFor(s, entry);
  const metric = ex?.metric || 'reps';
  const rounds = res.stoppedEarly ? Math.max(res.completedRounds, 0) : cfg.rounds;
  openSheet({
    title: res.stoppedEarly ? 'EMOM beendet' : 'EMOM geschafft',
    body: `<div class="stack">
      <p class="muted">Jede Runde wird als eigener Satz eingetragen${d.w ? ` (${weightText(ex, d.w)})` : ''}.</p>
      <label class="field"><span>Geschaffte Runden</span>${stepper({ field: 'n', value: rounds, min: 0, max: 99, label: 'Runden' })}</label>
      ${metric !== 'time' ? `<label class="field"><span>${ex?.side === 'one' ? 'Wiederholungen je Runde (je Seite)' : 'Wiederholungen je Runde'}</span>${stepper({ field: 'r', value: cfg.r ?? d.r ?? 5, label: 'Wiederholungen' })}</label>` : ''}
      ${metric !== 'reps' ? `<label class="field"><span>Arbeitszeit je Runde${metric === 'both' ? ' (optional)' : ''}</span>${stepper({ field: 't', value: metric === 'time' ? 30 : null, step: 5, kind: 'time', wide: true, label: 'Zeit' })}</label>` : ''}
    </div>`,
    foot: `<button class="btn btn-ghost" data-close>Nicht eintragen</button><button class="btn btn-primary" data-save>Eintragen</button>`,
    onMount: (sh, close) => {
      sh.querySelector('[data-save]').onclick = async () => {
        const v = Object.fromEntries($$('input[data-field]', sh).map((i) => [i.dataset.field, readStepper(i)]));
        const n = Math.round(v.n || 0);
        if (!n) { close(); return; }
        const tag = `EMOM ${clock(cfg.interval)}`;
        const now = Date.now();
        for (let i = 0; i < n; i++) {
          entry.sets.push({ id: uid(), w: d.w || null, r: v.r || null, t: v.t || null, ts: now + i, tag });
        }
        await saveSession(s);
        close();
        render();
        toast(`${n} ${n === 1 ? 'Satz' : 'Sätze'} eingetragen`);
      };
    },
  });
}

function openCountdownSetup(s, entry) {
  const ex = exById(entry.exId);
  const d = draftFor(s, entry);
  const saved = state.settings.lastCountdown || 600;
  openSheet({
    title: 'Countdown einstellen',
    body: `<div class="stack">
      <label class="field"><span>Dauer</span>${stepper({ field: 'total', value: saved, step: 30, min: 10, kind: 'time', wide: true, label: 'Dauer' })}</label>
      <div class="row" style="flex-wrap:wrap">${[300, 600, 900, 1200].map((v) => `<button class="chip" data-preset="${v}">${v / 60} min</button>`).join('')}</div>
      <p class="small muted">${d.w ? `${esc(exName(ex))} mit ${weightText(ex, d.w)}. ` : ''}Am Ende trägst du dein Ergebnis ein.</p>
    </div>`,
    foot: `<button class="btn btn-primary btn-xl" data-go>Start</button>`,
    onMount: (sh, close) => {
      const inp = sh.querySelector('input[data-field="total"]');
      sh.addEventListener('click', (e) => {
        const p = e.target.closest('[data-preset]');
        if (p) inp.value = clock(Number(p.dataset.preset));
      });
      sh.querySelector('[data-go]').onclick = () => {
        const total = readStepper(inp);
        if (!total) return;
        state.settings.lastCountdown = total;
        saveSettings();
        close();
        startTimer({ mode: 'countdown', title: exName(ex), total, onDone: (res) => countdownResult(s, entry, total, res) });
      };
    },
  });
}

function countdownResult(s, entry, total, res) {
  const ex = exById(entry.exId);
  const d = draftFor(s, entry);
  const metric = ex?.metric || 'reps';
  const t = res.stoppedEarly ? res.elapsed : total;
  const one = ex?.side === 'one';
  openSheet({
    title: res.stoppedEarly ? 'Countdown beendet' : 'Zeit ist um',
    body: `<div class="stack">
      <label class="field"><span>Zeit</span>${stepper({ field: 't', value: t, step: 15, kind: 'time', wide: true, label: 'Zeit' })}</label>
      ${metric !== 'time' ? `<label class="field"><span>${one ? 'Wiederholungen gesamt (beide Seiten)' : 'Wiederholungen gesamt'}</span>${stepper({ field: 'r', value: '', label: 'Wiederholungen', wide: true })}
        ${one ? '<span class="hint">Wird halbiert als Wiederholungen je Seite gespeichert.</span>' : ''}</label>` : ''}
      ${d.w ? `<p class="small muted">Gewicht: ${weightText(ex, d.w)}</p>` : ''}
    </div>`,
    foot: `<button class="btn btn-ghost" data-close>Nicht eintragen</button><button class="btn btn-primary" data-save>Eintragen</button>`,
    onMount: (sh, close) => {
      sh.querySelector('[data-save]').onclick = async () => {
        const v = Object.fromEntries($$('input[data-field]', sh).map((i) => [i.dataset.field, readStepper(i)]));
        let r = v.r || null;
        if (r && one) r = r / 2;
        close();
        await logSet(s, entry, { w: d.w, r, t: v.t }, { tag: 'AMRAP', rest: false });
      };
    },
  });
}

async function finishTraining() {
  const s = currentSession();
  const sets = s.entries.reduce((n, e) => n + e.sets.length, 0);
  if (!sets) {
    const ok = await confirmSheet({ title: 'Noch keine Sätze', text: 'Du hast noch nichts eingetragen. Soll die Einheit verworfen werden?', ok: 'Verwerfen', danger: true, cancel: 'Weiter trainieren' });
    if (ok) { await deleteSession(s.id); stopRest(); sessionWakeOff(); render(); }
    return;
  }
  const dur = sessionDuration(s);
  const vol = sessionVolume(s);
  openSheet({
    title: 'Training beenden',
    body: `<dl class="kv">
        <dt>Dauer</dt><dd>${duration(dur)}</dd>
        <dt>Übungen</dt><dd>${s.entries.filter((e) => e.sets.length).length}</dd>
        <dt>Sätze</dt><dd>${sets}</dd>
        ${vol ? `<dt>Volumen</dt><dd>${num(vol, 0)} kg</dd>` : ''}
      </dl>`,
    foot: `<button class="btn btn-ghost" data-close>Weiter trainieren</button><button class="btn btn-primary" data-ok>Speichern</button>`,
    onMount: (sh, close) => {
      sh.querySelector('[data-ok]').onclick = async () => {
        s.end = Date.now();
        s.entries = s.entries.filter((e) => e.sets.length);
        clearTimeout(saveTimer);
        await saveSession(s);
        await setActive(null);
        stopRest();
        sessionWakeOff();
        ui.drafts.clear();
        close();
        render();
        window.scrollTo(0, 0);
        toast('Training gespeichert');
      };
    },
  });
}

// ---------- Übungsauswahl ----------
function openExercisePicker(s) {
  if (!state.exercises.filter((e) => !e.archived).length) {
    return openExerciseForm(null, async (ex) => {
      s.entries.push({ id: uid(), exId: ex.id, sets: [] });
      await saveSession(s); render();
    });
  }
  const recent = [];
  for (const ses of state.sessions) {
    if (ses.id === s.id) continue;
    for (const e of ses.entries) if (!recent.includes(e.exId) && exById(e.exId) && !exById(e.exId).archived) recent.push(e.exId);
    if (recent.length >= 6) break;
  }
  const chosen = new Set();
  const item = (ex) => `<button class="list-item" data-pick="${ex.id}" aria-pressed="false">
      <div class="grow"><div class="t">${esc(exName(ex))}</div><div class="s">${INSTRUMENTS[ex.instrument]}, ${METRICS[ex.metric]}</div></div>
      <span class="pick-mark" aria-hidden="true"></span></button>`;
  const groups = Object.keys(INSTRUMENTS).map((k) => {
    const list = state.exercises.filter((e) => e.instrument === k && !e.archived);
    return list.length ? `<div class="month-label">${INSTRUMENTS[k]}</div><div class="list" data-group>${list.map(item).join('')}</div>` : '';
  }).join('');

  openSheet({
    title: 'Übungen hinzufügen',
    body: `<input class="search" type="search" placeholder="Übung suchen" data-search aria-label="Übung suchen">
      ${recent.length ? `<div data-recent><div class="month-label">Zuletzt trainiert</div><div class="list">${recent.map((id) => item(exById(id))).join('')}</div></div>` : ''}
      <div data-all>${groups}</div>
      <button class="btn btn-text btn-block" style="margin-top:12px" data-new>${ICON.plus} Neue Übung anlegen</button>`,
    foot: `<button class="btn btn-primary btn-block" data-add disabled>Übungen auswählen</button>`,
    onMount: (sh, close) => {
      const addBtn = sh.querySelector('[data-add]');
      const sync = () => {
        $$('[data-pick]', sh).forEach((b) => {
          const on = chosen.has(b.dataset.pick);
          b.setAttribute('aria-pressed', String(on));
          b.querySelector('.pick-mark').innerHTML = on ? ICON.check : '';
        });
        addBtn.disabled = !chosen.size;
        addBtn.textContent = !chosen.size ? 'Übungen auswählen' : chosen.size === 1 ? '1 Übung hinzufügen' : `${chosen.size} Übungen hinzufügen`;
      };
      sh.addEventListener('click', (e) => {
        const p = e.target.closest('[data-pick]');
        if (p) { chosen.has(p.dataset.pick) ? chosen.delete(p.dataset.pick) : chosen.add(p.dataset.pick); sync(); }
      });
      sh.querySelector('[data-search]').addEventListener('input', (e) => {
        const q = e.target.value.trim().toLowerCase();
        const rec = sh.querySelector('[data-recent]');
        if (rec) rec.hidden = !!q;
        $$('[data-all] [data-pick]', sh).forEach((b) => { b.hidden = q && !b.textContent.toLowerCase().includes(q); });
        $$('[data-all] [data-group]', sh).forEach((g) => {
          const any = $$('[data-pick]', g).some((b) => !b.hidden);
          g.hidden = !any; g.previousElementSibling.hidden = !any;
        });
      });
      addBtn.onclick = async () => {
        for (const id of chosen) s.entries.push({ id: uid(), exId: id, sets: [] });
        if (s.end) s.edited = Date.now();
        await saveSession(s);
        close();
        render();
        setTimeout(() => $$('.entry').at(-1)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
      };
      sh.querySelector('[data-new]').onclick = () => {
        close();
        setTimeout(() => openExerciseForm(null, async (ex) => {
          s.entries.push({ id: uid(), exId: ex.id, sets: [] });
          await saveSession(s); render();
        }), 50);
      };
    },
  });
}

// ---------- Übung anlegen / bearbeiten ----------
function openExerciseForm(ex, onSaved) {
  const isNew = !ex;
  const draft = ex ? { ...ex } : { name: '', instrument: 'kb', side: 'both', metric: 'reps' };
  const usage = ex ? exerciseUsage(ex.id) : 0;
  openSheet({
    title: isNew ? 'Neue Übung' : 'Übung bearbeiten',
    body: `<div class="stack">
      <label class="field"><span>Name</span><input type="text" data-f="name" value="${esc(draft.name)}" placeholder="z. B. Swing" autocomplete="off" ${isNew ? 'data-autofocus' : ''}></label>
      <div class="field"><span>Gerät</span>${seg('instrument', { kb: 'Kugel', bw: 'Körper', bb: 'Langhantel', other: 'Sonst.' }, draft.instrument)}</div>
      <div class="field" data-side-wrap><span>Ausführung</span><div data-side-slot></div><span class="hint" data-side-hint></span></div>
      <div class="field"><span>Erfassen nach</span>${seg('metric', { reps: 'Wdh', time: 'Zeit', both: 'Wdh + Zeit' }, draft.metric)}</div>
      <p class="small" style="color:var(--danger)" data-err hidden></p>
      ${!isNew ? `<div class="divider"></div>
        <p class="small muted">${usage ? `In ${usage} ${usage === 1 ? 'Training' : 'Trainings'} verwendet. ${ex.archived ? 'Diese Übung ist ausgeblendet.' : 'Ausgeblendete Übungen erscheinen nicht mehr in der Auswahl, bleiben aber im Verlauf erhalten.'}` : 'Noch in keinem Training verwendet.'}</p>
        ${usage ? `<button class="btn btn-ghost btn-block" data-archive>${ex.archived ? 'Wieder einblenden' : 'Ausblenden'}</button>` : `<button class="btn btn-danger btn-block" data-delete>${ICON.trash} Übung löschen</button>`}` : ''}
    </div>`,
    foot: `<button class="btn btn-ghost" data-close>Abbrechen</button><button class="btn btn-primary" data-save>Speichern</button>`,
    onMount: (sh, close) => {
      const slot = sh.querySelector('[data-side-slot]');
      const hint = sh.querySelector('[data-side-hint]');
      const wrap = sh.querySelector('[data-side-wrap]');
      const drawSide = () => {
        const inst = segValue(sh, 'instrument');
        const opts = sideOptions(inst);
        if (!opts[draft.side]) draft.side = 'both';
        wrap.hidden = Object.keys(opts).length < 2;
        slot.innerHTML = seg('side', opts, draft.side);
        hint.textContent = draft.side === 'one' ? 'Wiederholungen werden je Seite eingetragen.' : draft.side === 'double' ? 'Zwei Kugeln gleichzeitig, beim Volumen zählen beide.' : '';
      };
      drawSide();
      sh.addEventListener('segchange', (e) => {
        const name = e.target.dataset.seg;
        if (name === 'instrument') drawSide();
        if (name === 'side') { draft.side = e.detail; drawSide(); }
      });
      sh.querySelector('[data-save]').onclick = async () => {
        const err = sh.querySelector('[data-err]');
        const name = sh.querySelector('[data-f="name"]').value.trim();
        if (!name) { err.textContent = 'Gib der Übung einen Namen.'; err.hidden = false; return; }
        const next = { ...draft, name, instrument: segValue(sh, 'instrument'), side: segValue(sh, 'side') || 'both', metric: segValue(sh, 'metric') };
        if (!sideOptions(next.instrument)[next.side]) next.side = 'both';
        const dup = state.exercises.find((x) => x.id !== next.id && x.name.toLowerCase() === name.toLowerCase() && x.instrument === next.instrument && (x.side || 'both') === next.side);
        if (dup) { err.textContent = `„${exName(dup)}“ gibt es schon.`; err.hidden = false; return; }
        const saved = await saveExercise(next);
        close();
        if (onSaved) await onSaved(saved);
        else render();
        toast(isNew ? 'Übung angelegt' : 'Übung gespeichert');
      };
      sh.querySelector('[data-archive]')?.addEventListener('click', async () => {
        ex.archived = !ex.archived;
        await saveExercise(ex);
        close(); render();
      });
      sh.querySelector('[data-delete]')?.addEventListener('click', async () => {
        await deleteExercise(ex.id);
        close(); render();
        toast('Übung gelöscht');
      });
    },
  });
}

async function addStarter() {
  for (const e of STARTER_EXERCISES) {
    const exists = state.exercises.some((x) => x.name === e.name && x.instrument === e.instrument && (x.side || 'both') === e.side);
    if (!exists) await saveExercise({ ...e });
  }
  render();
  toast(`${STARTER_EXERCISES.length} Übungen angelegt`);
}

// =====================================================================
// Übungen
// =====================================================================
function renderExercises() {
  setTitle('Übungen');
  $('#appbar-extra').innerHTML = `<button class="btn btn-s btn-primary" data-top="new-ex">${ICON.plus} Neu</button>`;
  if (!state.exercises.length) {
    view.innerHTML = `<div class="empty">
      <h2>Noch keine Übungen</h2>
      <p>Lege deine Übungen mit Gerät und Ausführung an, z. B. „Swing, einarmig“.</p>
      <button class="btn btn-primary" data-act="new-exercise">Übung anlegen</button><br>
      <button class="btn btn-ghost" data-act="starter">Beispielübungen übernehmen</button>
    </div>`;
    return;
  }
  const last = new Map();
  for (const s of state.sessions) for (const e of s.entries) if (!last.has(e.exId)) last.set(e.exId, s.start);
  const block = (list) => `<div class="list">${list.map((ex) => `
    <button class="list-item" data-ex="${ex.id}">
      <div class="grow"><div class="t">${esc(exName(ex))}</div><div class="s">${METRICS[ex.metric]}${last.has(ex.id) ? `, zuletzt ${relDays(last.get(ex.id))}` : ''}</div></div>
      ${ICON.chev}
    </button>`).join('')}</div>`;
  const active = state.exercises.filter((e) => !e.archived);
  const archived = state.exercises.filter((e) => e.archived);
  view.innerHTML = Object.keys(INSTRUMENTS).map((k) => {
    const list = active.filter((e) => e.instrument === k);
    return list.length ? `<div class="month-label">${INSTRUMENTS[k]}</div>${block(list)}` : '';
  }).join('') + (archived.length ? `<div class="month-label">Ausgeblendet</div>${block(archived)}` : '');
}
view.addEventListener('click', (e) => {
  const b = e.target.closest('[data-ex]');
  if (b) openExerciseForm(exById(b.dataset.ex));
});
$('#appbar-extra').addEventListener('click', (e) => {
  const t = e.target.closest('[data-top]')?.dataset.top;
  if (t === 'new-ex') openExerciseForm();
  if (t === 'backfill') backfill();
});

// =====================================================================
// Verlauf
// =====================================================================
function historyItem(s) {
  const names = [...new Set(s.entries.map((e) => exName(exById(e.exId))))];
  const sets = s.entries.reduce((n, e) => n + e.sets.length, 0);
  const live = s.id === state.activeId;
  return `<button class="list-item" data-act="open-session" data-id="${s.id}">
    <div class="grow">
      <div class="t">${fmtDay(s.start)} ${live ? '<span class="badge badge-live">läuft</span>' : ''}</div>
      <div class="s">${names.length ? esc(names.join(', ')) : 'keine Übungen'}</div>
    </div>
    <div class="end">${duration(sessionDuration(s))}<br>${sets} ${sets === 1 ? 'Satz' : 'Sätze'}</div>
  </button>`;
}

function renderHistory() {
  setTitle('Verlauf');
  $('#appbar-extra').innerHTML = `<button class="btn btn-s btn-ghost" data-top="backfill">${ICON.plus} Nachtragen</button>`;
  const used = new Set();
  for (const s of state.sessions) for (const e of s.entries) used.add(e.exId);
  const options = state.exercises.filter((e) => used.has(e.id));
  let list = state.sessions;
  if (ui.historyFilter) list = list.filter((s) => s.entries.some((e) => e.exId === ui.historyFilter));

  if (!state.sessions.length) {
    view.innerHTML = `<div class="empty"><h2>Noch keine Trainings</h2><p>Sobald du ein Training beendest, erscheint es hier.</p>
      <button class="btn btn-primary" data-act="start">Training starten</button></div>`;
    return;
  }
  let html = `<select class="search" data-hfilter aria-label="Nach Übung filtern">
      <option value="">Alle Übungen</option>
      ${options.map((e) => `<option value="${e.id}" ${e.id === ui.historyFilter ? 'selected' : ''}>${esc(exName(e))}</option>`).join('')}
    </select>`;
  if (ui.historyFilter) {
    const ex = exById(ui.historyFilter);
    html += `<p class="small muted" style="margin:10px 4px 0">${list.length} ${list.length === 1 ? 'Training' : 'Trainings'} mit ${esc(exName(ex))}</p>`;
  }
  let month = '';
  let open = false;
  for (const s of list) {
    const m = fmtMonth(s.start);
    if (m !== month) {
      if (open) html += '</div>';
      html += `<div class="month-label">${m}</div><div class="list">`;
      month = m; open = true;
    }
    html += ui.historyFilter ? historyItemFiltered(s, ui.historyFilter) : historyItem(s);
  }
  if (open) html += '</div>';
  view.innerHTML = html;
  $('[data-hfilter]', view).addEventListener('change', (e) => { ui.historyFilter = e.target.value; renderHistory(); });
}
function historyItemFiltered(s, exId) {
  const ex = exById(exId);
  const parts = s.entries.filter((e) => e.exId === exId).map((e) => entrySummary(ex, e)).join('; ');
  return `<button class="list-item" data-act="open-session" data-id="${s.id}">
    <div class="grow"><div class="t">${fmtDay(s.start)}</div><div class="s">${esc(parts)}</div></div>${ICON.chev}</button>`;
}

function openSessionDetail(s) {
  if (!s) return;
  if (s.id === state.activeId) { setTab('training'); return; }
  const vol = sessionVolume(s);
  const sets = s.entries.reduce((n, e) => n + e.sets.length, 0);
  openSheet({
    title: fmtLong(s.start),
    body: `<dl class="kv">
        <dt>Beginn</dt><dd>${fmtTime(s.start)} Uhr</dd>
        <dt>Dauer</dt><dd>${duration(sessionDuration(s))}</dd>
        <dt>Sätze</dt><dd>${sets}</dd>
        ${vol ? `<dt>Volumen</dt><dd>${num(vol, 0)} kg</dd>` : ''}
      </dl>
      <div class="list" style="margin-top:16px">
        ${s.entries.map((e) => {
          const ex = exById(e.exId);
          return `<div class="list-item"><div class="grow"><div class="t">${esc(exName(ex))}</div>
            <div class="s">${esc(entrySummary(ex, e))}</div></div></div>`;
        }).join('')}
      </div>
      ${s.note ? `<p style="margin-top:14px;white-space:pre-wrap">${esc(s.note)}</p>` : ''}`,
    foot: `<button class="btn btn-ghost" data-edit>Bearbeiten</button>${!state.activeId ? '<button class="btn btn-primary" data-repeat>Wiederholen</button>' : ''}`,
    onMount: (sh, close) => {
      sh.querySelector('[data-edit]').onclick = () => {
        close();
        ui.editing = s.id;
        render();
        window.scrollTo(0, 0);
      };
      sh.querySelector('[data-repeat]')?.addEventListener('click', () => { close(); startTraining(s); });
    },
  });
}

// =====================================================================
// Auswertung
// =====================================================================
function rangeStart() {
  const now = Date.now();
  if (ui.range === '3m') return now - 91 * 86400000;
  if (ui.range === '12m') return now - 365 * 86400000;
  const all = finishedSessions();
  return all.length ? startOfDay(all[all.length - 1].start) : now - 365 * 86400000;
}

function renderStats() {
  setTitle('Auswertung');
  const all = finishedSessions();
  if (!all.length) {
    view.innerHTML = `<div class="empty"><h2>Noch nichts auszuwerten</h2><p>Nach deinen ersten Trainings siehst du hier Kalender, Volumen, Gewichtsentwicklung und Bestleistungen.</p></div>`;
    return;
  }
  const from = rangeStart();
  const inRange = all.filter((s) => s.start >= from);
  const totalSec = inRange.reduce((n, s) => n + sessionDuration(s), 0);
  const totalVol = inRange.reduce((n, s) => n + sessionVolume(s), 0);
  const weeks = Math.max(1, (Date.now() - from) / (7 * 86400000));

  // Übungen mit Daten
  const exWithData = state.exercises.filter((ex) => all.some((s) => s.entries.some((e) => e.exId === ex.id && e.sets.length)));
  if (!ui.statEx || !exWithData.some((e) => e.id === ui.statEx)) {
    ui.statEx = all[0].entries.find((e) => e.sets.length)?.exId || exWithData[0]?.id;
  }

  view.innerHTML = `
    ${seg('range', { '3m': '3 Monate', '12m': '12 Monate', all: 'Alles' }, ui.range)}
    <div class="tiles" style="margin-top:14px">
      <div class="tile"><div class="v">${inRange.length}</div><div class="l">Einheiten</div></div>
      <div class="tile"><div class="v">${num(totalSec / 3600, 1)}<small>h</small></div><div class="l">Trainingszeit</div></div>
      <div class="tile"><div class="v">${totalVol >= 10000 ? `${num(totalVol / 1000, 1)}<small>t</small>` : `${num(totalVol, 0)}<small>kg</small>`}</div><div class="l">Bewegtes Gewicht</div></div>
      <div class="tile"><div class="v">${num(inRange.length / weeks, 1)}</div><div class="l">Einheiten pro Woche</div></div>
    </div>

    <div class="section-title"><h2>Kalender</h2></div>
    <div class="chart-panel">
      <div id="heat"></div>
      <div class="heat-legend">kürzer <i style="background:var(--heat-1)"></i><i style="background:var(--heat-2)"></i><i style="background:var(--heat-3)"></i><i style="background:var(--heat-4)"></i> länger</div>
    </div>

    <div class="section-title"><h2>Bewegtes Gewicht</h2></div>
    <div class="chart-panel">
      <p class="chart-note" id="vol-note"></p>
      <div id="vol"></div>
    </div>

    <div class="section-title" id="ex-detail"><h2>Übung im Verlauf</h2></div>
    <div class="chart-panel">
      <select class="search" data-statex aria-label="Übung wählen" style="margin-bottom:10px">
        ${exWithData.map((e) => `<option value="${e.id}" ${e.id === ui.statEx ? 'selected' : ''}>${esc(exName(e))}</option>`).join('')}
      </select>
      <div id="ex-metrics"></div>
      <p class="chart-note" id="ex-note" style="margin-top:10px"></p>
      <div id="ex-chart"></div>
      <div id="ex-table"></div>
    </div>

    <div class="section-title"><h2>Bestleistungen</h2><span class="small muted">seit Beginn</span></div>
    <div class="list pr-list" id="prs"></div>
  `;

  view.querySelector('[data-seg="range"]').addEventListener('segchange', (e) => { ui.range = e.detail; renderStats(); });
  view.querySelector('[data-statex]').addEventListener('change', (e) => { ui.statEx = e.target.value; ui.statMetric = null; drawExercise(); });

  // Kalender
  const days = new Map();
  for (const s of all) {
    const k = dayKey(s.start);
    const d = days.get(k) || { sec: 0, count: 0, names: new Set() };
    d.sec += sessionDuration(s); d.count++;
    s.entries.forEach((e) => d.names.add(exById(e.exId)?.name || ''));
    days.set(k, d);
  }
  for (const d of days.values()) d.label = `${duration(d.sec)}${d.count > 1 ? ` in ${d.count} Einheiten` : ''}: ${[...d.names].filter(Boolean).slice(0, 4).join(', ')}`;
  const heatWeeks = ui.range === '3m' ? 14 : ui.range === '12m' ? 53 : Math.max(53, Math.ceil((Date.now() - from) / (7 * 86400000)) + 1);
  heatmap($('#heat'), days, { weeks: heatWeeks });

  drawVolume(inRange, from);
  drawExercise();
  drawPRs(exWithData);
}

function drawVolume(sessions, from) {
  const spanWeeks = Math.ceil((Date.now() - startOfWeek(from)) / (7 * 86400000));
  const byMonth = spanWeeks > 70;
  const buckets = new Map();
  if (byMonth) {
    const d = new Date(from); d.setDate(1); d.setHours(0, 0, 0, 0);
    while (d.getTime() <= Date.now()) { buckets.set(d.getTime(), 0); d.setMonth(d.getMonth() + 1); }
    for (const s of sessions) {
      const m = new Date(s.start); m.setDate(1); m.setHours(0, 0, 0, 0);
      buckets.set(m.getTime(), (buckets.get(m.getTime()) || 0) + sessionVolume(s));
    }
  } else {
    for (let w = startOfWeek(from); w <= Date.now(); w += 7 * 86400000) buckets.set(startOfWeek(w + 3600000 * 12), 0);
    for (const s of sessions) {
      const w = startOfWeek(s.start);
      buckets.set(w, (buckets.get(w) || 0) + sessionVolume(s));
    }
  }
  let lastMonth = -1;
  const data = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([ts, v]) => {
    const d = new Date(ts);
    let tickLabel = '';
    if (byMonth) { if (d.getMonth() % 3 === 0) tickLabel = d.toLocaleDateString('de-DE', { month: 'short' }) + (d.getMonth() === 0 ? ` ${String(d.getFullYear()).slice(2)}` : ''); }
    else if (d.getMonth() !== lastMonth) { tickLabel = d.toLocaleDateString('de-DE', { month: 'short' }); lastMonth = d.getMonth(); }
    const label = byMonth ? fmtMonth(ts) : `Woche ab ${d.toLocaleDateString('de-DE', { day: 'numeric', month: 'short' })}`;
    return { value: Math.round(v), tickLabel, tip: `<strong>${esc(label)}</strong><br>${num(v, 0)} kg` };
  });
  // Monatsmarken bei Wochen ausdünnen, damit sie nicht kollidieren
  if (!byMonth && data.length > 30) { let k = 0; data.forEach((d) => { if (d.tickLabel) { if (k++ % 2) d.tickLabel = ''; } }); }
  $('#vol-note').textContent = `${byMonth ? 'Pro Monat' : 'Pro Woche'}, Kilogramm × Wiederholungen (bei einarmig beide Seiten, bei doppelt beide Kugeln)`;
  bars($('#vol'), data, { unit: 'kg' });
}

const EX_METRICS = {
  maxw: { label: 'Schwerstes Gewicht', unit: 'kg', has: (sets) => sets.some((s) => s.w), val: (ex, sets) => Math.max(...sets.map((s) => s.w || 0)), step: true },
  vol: { label: 'Volumen', unit: 'kg', has: (sets) => sets.some((s) => s.w && s.r), val: (ex, sets) => sets.reduce((n, s) => n + setVolume(ex, s), 0), yFrom0: true },
  reps: { label: 'Wdh gesamt', unit: 'Wdh', has: (sets) => sets.some((s) => s.r), val: (ex, sets) => sets.reduce((n, s) => n + setReps(ex, s), 0), yFrom0: true },
  best: { label: 'Bester Satz', unit: 'Wdh', has: (sets) => sets.some((s) => s.r), val: (ex, sets) => Math.max(...sets.map((s) => s.r || 0)) },
  time: { label: 'Zeit gesamt', unit: 's', has: (sets) => sets.some((s) => s.t), val: (ex, sets) => sets.reduce((n, s) => n + (s.t || 0), 0), yFrom0: true, isTime: true },
  tbest: { label: 'Längste Zeit', unit: 's', has: (sets) => sets.some((s) => s.t), val: (ex, sets) => Math.max(...sets.map((s) => s.t || 0)), isTime: true },
};

function drawExercise() {
  const ex = exById(ui.statEx);
  if (!ex) return;
  const from = rangeStart();
  const perSession = [];
  for (const s of finishedSessions()) {
    if (s.start < from) continue;
    const sets = s.entries.filter((e) => e.exId === ex.id).flatMap((e) => e.sets);
    if (sets.length) perSession.push({ s, sets });
  }
  const allSets = perSession.flatMap((p) => p.sets);
  const available = Object.entries(EX_METRICS).filter(([, m]) => m.has(allSets));
  if (!ui.statMetric || !available.some(([k]) => k === ui.statMetric)) ui.statMetric = available[0]?.[0];
  const mBox = $('#ex-metrics');
  mBox.innerHTML = available.length > 1
    ? `<div class="row" style="flex-wrap:wrap;gap:6px">${available.map(([k, m]) => `<button class="chip" data-metric="${k}" aria-pressed="${k === ui.statMetric}">${m.label}</button>`).join('')}</div>` : '';
  mBox.onclick = (e) => { const b = e.target.closest('[data-metric]'); if (b) { ui.statMetric = b.dataset.metric; drawExercise(); } };

  const chart = $('#ex-chart');
  const table = $('#ex-table');
  if (!perSession.length || !ui.statMetric) {
    chart.innerHTML = `<div class="chart-empty">In diesem Zeitraum keine Einträge zu dieser Übung.</div>`;
    table.innerHTML = '';
    $('#ex-note').textContent = '';
    return;
  }
  const m = EX_METRICS[ui.statMetric];
  const fmtVal = (v) => (m.isTime ? setTime(v) || '0 s' : `${num(v)} ${m.unit}`);
  const points = perSession.map(({ s, sets }) => {
    const v = m.val(ex, sets);
    return { x: s.start, y: m.isTime ? v / 60 : v, raw: v, tip: `<strong>${fmtDay(s.start)}</strong><br>${fmtVal(v)}<br><span style="opacity:.75">${esc(entrySummary(ex, { sets }))}</span>`, s, sets };
  });
  const notes = {
    maxw: ex.side === 'double' ? 'Schwerste Kugel je Training (je Kugel)' : 'Schwerstes Gewicht je Training',
    vol: 'Kilogramm × Wiederholungen je Training',
    reps: ex.side === 'one' ? 'Wiederholungen je Training, beide Seiten zusammen' : 'Wiederholungen je Training',
    best: ex.side === 'one' ? 'Meiste Wiederholungen in einem Satz (je Seite)' : 'Meiste Wiederholungen in einem Satz',
    time: 'Gesamte Zeit je Training, in Minuten',
    tbest: 'Längster Satz je Training, in Minuten',
  };
  $('#ex-note').textContent = notes[ui.statMetric];
  timeline(chart, points, { unit: m.isTime ? 'min' : m.unit, step: m.step, yFrom0: m.yFrom0 });
  const rows = [...points].reverse().slice(0, 60);
  table.innerHTML = `<details class="table-view"><summary>Als Tabelle anzeigen</summary>
    <table class="data-table"><thead><tr><th>Datum</th><th>Sätze</th><th class="r">${esc(m.label)}</th></tr></thead>
    <tbody>${rows.map((p) => `<tr><td>${fmtShort(p.x)}</td><td>${esc(entrySummary(ex, { sets: p.sets }))}</td><td class="r">${fmtVal(p.raw)}</td></tr>`).join('')}</tbody></table></details>`;
}

function drawPRs(exList) {
  const box = $('#prs');
  const lastUse = new Map();
  for (const s of finishedSessions()) for (const e of s.entries) if (!lastUse.has(e.exId)) lastUse.set(e.exId, s.start);
  const sorted = [...exList].sort((a, b) => (lastUse.get(b.id) || 0) - (lastUse.get(a.id) || 0));
  box.innerHTML = sorted.map((ex) => {
    let heavy = null, mostReps = null, longest = null, bestVol = null;
    for (const s of finishedSessions()) {
      let vol = 0;
      for (const e of s.entries) {
        if (e.exId !== ex.id) continue;
        for (const set of e.sets) {
          vol += setVolume(ex, set);
          if (set.w && (!heavy || set.w > heavy.set.w || (set.w === heavy.set.w && (set.r || 0) > (heavy.set.r || 0)))) heavy = { set, s };
          if (set.r && (!mostReps || set.r > mostReps.set.r || (set.r === mostReps.set.r && (set.w || 0) > (mostReps.set.w || 0)))) mostReps = { set, s };
          if (set.t && (!longest || set.t > longest.set.t)) longest = { set, s };
        }
      }
      if (vol && (!bestVol || vol > bestVol.vol)) bestVol = { vol, s };
    }
    const cells = [];
    if (heavy) cells.push(`<div>Schwerstes Gewicht<b>${weightText(ex, heavy.set.w)}${heavy.set.r ? ` × ${num(heavy.set.r)}` : ''}</b>${fmtShort(heavy.s.start)}</div>`);
    if (mostReps) cells.push(`<div>Meiste Wdh im Satz<b>${num(mostReps.set.r)}${ex.side === 'one' ? ' je Seite' : ''}${mostReps.set.w ? ` mit ${num(mostReps.set.w)} kg` : ''}</b>${fmtShort(mostReps.s.start)}</div>`);
    if (longest) cells.push(`<div>Längste Zeit<b>${setTime(longest.set.t)}${longest.set.w ? ` mit ${num(longest.set.w)} kg` : ''}</b>${fmtShort(longest.s.start)}</div>`);
    if (bestVol) cells.push(`<div>Meistes Volumen<b>${num(bestVol.vol, 0)} kg</b>${fmtShort(bestVol.s.start)}</div>`);
    return `<div class="list-item"><div class="grow"><div class="t">${esc(exName(ex))}</div><div class="pr-grid">${cells.join('')}</div></div></div>`;
  }).join('');
}

// =====================================================================
// Daten & Einstellungen
// =====================================================================
async function storageInfo() {
  const out = { persisted: null, usage: null };
  try { out.persisted = await navigator.storage?.persisted?.(); } catch (e) { /* */ }
  try { const est = await navigator.storage?.estimate?.(); out.usage = est?.usage; } catch (e) { /* */ }
  return out;
}
async function requestPersist() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) return await navigator.storage.persist();
    return true;
  } catch (e) { return false; }
}

function backupFilename(ext) {
  const d = new Date();
  return `kugelbuch-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.${ext}`;
}
async function markBackup() {
  state.settings.lastBackup = Date.now();
  await saveSettings();
}
async function doBackup() {
  download(backupFilename('json'), JSON.stringify(exportData(), null, 1), 'application/json');
  await markBackup();
  toast('Backup im Ordner „Downloads“ gespeichert');
  render();
}
async function shareBackup() {
  const file = new File([JSON.stringify(exportData(), null, 1)], backupFilename('json'), { type: 'application/json' });
  try {
    await navigator.share({ files: [file], title: 'Kugelbuch-Backup' });
    await markBackup();
    toast('Backup geteilt');
    render();
  } catch (e) {
    if (e.name !== 'AbortError') toast('Teilen hat nicht geklappt. Nutze „Backup speichern“.');
  }
}
function csvExport() {
  const sideTxt = (ex) => (ex ? sideLabel(ex) : '');
  const n = (v) => (v == null || v === '' ? '' : String(v).replace('.', ','));
  const rows = [['Datum', 'Uhrzeit', 'Training', 'Übung', 'Gerät', 'Ausführung', 'Satz', 'Gewicht kg', 'Wiederholungen', 'Wdh je Seite', 'Zeit s', 'Volumen kg', 'Markierung', 'Dauer Training min']];
  const sessions = [...finishedSessions()].sort((a, b) => a.start - b.start);
  sessions.forEach((s, si) => {
    for (const e of s.entries) {
      const ex = exById(e.exId);
      e.sets.forEach((set, i) => {
        const d = new Date(s.start);
        rows.push([
          d.toLocaleDateString('de-DE'), fmtTime(s.start), si + 1, ex?.name || 'Gelöschte Übung', ex ? INSTRUMENTS[ex.instrument] : '', sideTxt(ex),
          i + 1, n(set.w), n(set.r), ex?.side === 'one' ? 'ja' : 'nein', n(set.t), n(setVolume(ex, set)), set.tag || '', Math.round(sessionDuration(s) / 60),
        ]);
      });
    }
  });
  const csv = '﻿' + rows.map((r) => r.map((c) => {
    const v = String(c ?? '');
    return /[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(';')).join('\r\n');
  download(backupFilename('csv'), csv, 'text/csv;charset=utf-8');
  toast('Tabelle im Ordner „Downloads“ gespeichert');
}

function restoreFlow(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try { data = JSON.parse(reader.result); } catch (e) { return toast('Die Datei lässt sich nicht lesen.'); }
    if (data?.app !== 'kugelbuch') return toast('Diese Datei ist kein Kugelbuch-Backup.');
    openSheet({
      title: 'Backup wiederherstellen',
      body: `<p class="muted">Backup vom ${new Date(data.exported).toLocaleString('de-DE')} mit ${data.sessions.length} Trainings und ${data.exercises.length} Übungen.</p>
        <div class="list" style="margin-top:14px">
          <button class="list-item" data-mode="merge"><div class="grow"><div class="t">Zusammenführen</div><div class="s">Fehlende Trainings ergänzen, vorhandene behalten</div></div>${ICON.chev}</button>
          <button class="list-item" data-mode="replace"><div class="grow"><div class="t" style="color:var(--danger)">Alles ersetzen</div><div class="s">Aktuelle Daten auf diesem Handy werden gelöscht</div></div>${ICON.chev}</button>
        </div>`,
      onMount: (sh, close) => sh.addEventListener('click', async (e) => {
        const mode = e.target.closest('[data-mode]')?.dataset.mode;
        if (!mode) return;
        close();
        if (mode === 'replace' && !(await confirmSheet({ title: 'Wirklich ersetzen?', text: 'Alle Trainings und Übungen auf diesem Handy werden durch das Backup ersetzt.', ok: 'Ersetzen', danger: true }))) return;
        try {
          const r = await importData(data, mode);
          applyTheme();
          render();
          toast(`${r.sessions} Trainings wiederhergestellt`);
        } catch (err) { toast(err.message); }
      }),
    });
  };
  reader.readAsText(file);
}

async function renderData() {
  setTitle('Daten');
  const st = state.settings;
  const info = await storageInfo();
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.json', { type: 'application/json' })] }));
  const custom = st.bells.filter((b) => !STANDARD_BELLS.includes(b));
  const allBells = [...STANDARD_BELLS, ...custom].sort((a, b) => a - b);
  const done = finishedSessions().length;

  view.innerHTML = `
    ${backupNotice()}
    <div class="section-title"><h2>Sicherung</h2></div>
    <div class="panel stack">
      <p class="small muted">Deine Trainings liegen nur auf diesem Handy. Speichere regelmäßig ein Backup und leg es z. B. in Google Drive ab. Mit der Datei kannst du alles wiederherstellen, auch auf einem neuen Handy.</p>
      <dl class="kv">
        <dt>Trainings</dt><dd>${done}</dd>
        <dt>Übungen</dt><dd>${state.exercises.length}</dd>
        <dt>Letztes Backup</dt><dd>${st.lastBackup ? `${fmtShort(st.lastBackup)} (${relDays(st.lastBackup)})` : 'noch keins'}</dd>
      </dl>
      <button class="btn btn-primary btn-block" data-d="backup">Backup speichern</button>
      ${canShare ? `<button class="btn btn-ghost btn-block" data-d="share">Backup teilen, z. B. an Google Drive</button>` : ''}
      <button class="btn btn-ghost btn-block" data-d="csv">Tabelle für Excel exportieren (CSV)</button>
      <button class="btn btn-text btn-block" data-d="restore">Backup wiederherstellen …</button>
      <input type="file" accept="application/json,.json" data-file hidden>
    </div>

    <div class="section-title"><h2>Speicher</h2></div>
    <div class="panel stack">
      <div class="stack">
        <div><strong>${info.persisted ? 'Dauerhaft gespeichert' : info.persisted === false ? 'Nicht dauerhaft geschützt' : 'Status unbekannt'}</strong>
        <p class="small muted">${info.persisted ? 'Android löscht deine Daten nicht von selbst, auch nicht bei wenig Speicherplatz.' : 'Bei wenig Speicherplatz dürfte der Browser aufräumen. Installiere die App auf dem Startbildschirm und tippe auf „Daten schützen“.'}</p></div>
        ${info.persisted === false ? '<button class="btn btn-primary btn-block" data-d="persist">Daten schützen</button>' : ''}
      </div>
      ${info.usage != null ? `<p class="small muted">Belegt: ${num(info.usage / 1024 / 1024, 1)} MB</p>` : ''}
    </div>

    <div class="section-title"><h2>Meine Kugeln</h2></div>
    <div class="panel stack">
      <p class="small muted">Diese Gewichte erscheinen beim Eintragen zur Auswahl.</p>
      <div class="bells wrap">${allBells.map((w) => `<button class="bell" data-bell="${w}" aria-pressed="${st.bells.includes(w)}" aria-label="${num(w)} Kilogramm">${bellSvg(w)}</button>`).join('')}</div>
      <div class="row"><input class="search grow" type="number" inputmode="decimal" placeholder="Anderes Gewicht in kg" data-newbell aria-label="Anderes Gewicht"><button class="btn btn-ghost" data-d="addbell">Hinzufügen</button></div>
    </div>

    <div class="section-title"><h2>Pausen und Timer</h2></div>
    <div class="panel">
      <label class="switch"><span>Pause nach jedem Satz starten</span><input type="checkbox" data-set="restAuto" ${st.restAuto ? 'checked' : ''}></label>
      <div class="switch"><span>Pausenlänge</span>${stepper({ field: 'restSec', value: st.restSec, step: 15, min: 15, kind: 'time', wide: true, label: 'Pausenlänge' })}</div>
      <div class="switch"><span>Vorlauf vor dem Timer</span>${stepper({ field: 'prepSec', value: st.prepSec, step: 5, min: 0, max: 30, label: 'Vorlauf in Sekunden' })}</div>
      <label class="switch"><span>Signal zu jeder vollen Minute beim Countdown</span><input type="checkbox" data-set="minuteBeep" ${st.minuteBeep ? 'checked' : ''}></label>
      <div class="divider"></div>
      <label class="switch"><span>Signalton</span><input type="checkbox" data-set="sound" ${st.sound ? 'checked' : ''}></label>
      <label class="switch"><span>Lautstärke</span><input type="range" min="0.1" max="1" step="0.1" value="${st.volume}" data-set="volume" style="width:50%"></label>
      <label class="switch"><span>Vibration</span><input type="checkbox" data-set="vibrate" ${st.vibrate ? 'checked' : ''}></label>
      <label class="switch"><span>Bildschirm während des Trainings anlassen</span><input type="checkbox" data-set="wakeLock" ${st.wakeLock ? 'checked' : ''}></label>
      <button class="btn btn-ghost btn-block" style="margin-top:8px" data-d="testsound">Signal testen</button>
    </div>

    <div class="section-title"><h2>Darstellung</h2></div>
    <div class="panel">${seg('theme', { auto: 'Automatisch', light: 'Hell', dark: 'Dunkel' }, st.theme || 'auto')}</div>

    <div class="section-title"><h2>Über die App</h2></div>
    <div class="panel stack">
      <p class="small muted">Kugelbuch ${VERSION}. Läuft ohne Internet, alle Daten bleiben auf diesem Gerät.</p>
      <button class="btn btn-danger btn-block" data-d="wipe">Alle Daten löschen</button>
    </div>`;

  const fileInput = $('[data-file]', view);
  fileInput.onchange = () => { if (fileInput.files[0]) restoreFlow(fileInput.files[0]); fileInput.value = ''; };

  view.querySelector('[data-seg="theme"]').addEventListener('segchange', async (e) => {
    st.theme = e.detail; await saveSettings(); applyTheme();
  });
}
view.addEventListener('click', async (e) => {
  if (ui.tab !== 'daten' || ui.editing) return;
  const st = state.settings;
  const bell = e.target.closest('[data-bell]');
  if (bell) {
    const w = Number(bell.dataset.bell);
    st.bells = st.bells.includes(w) ? st.bells.filter((b) => b !== w) : [...st.bells, w].sort((a, b) => a - b);
    bell.setAttribute('aria-pressed', String(st.bells.includes(w)));
    return saveSettings();
  }
  const d = e.target.closest('[data-d]')?.dataset.d;
  if (!d) return;
  if (d === 'backup') return doBackup();
  if (d === 'share') return shareBackup();
  if (d === 'csv') return csvExport();
  if (d === 'restore') return $('[data-file]', view).click();
  if (d === 'persist') {
    const ok = await requestPersist();
    toast(ok ? 'Daten sind jetzt dauerhaft geschützt' : 'Android hat den Schutz noch nicht erlaubt. Installiere die App auf dem Startbildschirm und versuch es erneut.');
    return renderData();
  }
  if (d === 'addbell') {
    const inp = $('[data-newbell]', view);
    const w = parseFloat(String(inp.value).replace(',', '.'));
    if (!w || w <= 0 || w > 200) return toast('Gib ein Gewicht in Kilogramm ein.');
    if (!st.bells.includes(w)) st.bells = [...st.bells, w].sort((a, b) => a - b);
    await saveSettings();
    return renderData();
  }
  if (d === 'testsound') return signal.test();
  if (d === 'wipe') {
    if (!(await confirmSheet({ title: 'Alle Daten löschen?', text: 'Alle Trainings, Übungen und Einstellungen werden von diesem Handy gelöscht. Das lässt sich nur mit einem Backup rückgängig machen.', ok: 'Weiter', danger: true }))) return;
    if (!(await confirmSheet({ title: 'Wirklich alles löschen?', text: 'Letzte Rückfrage. Hast du ein aktuelles Backup?', ok: 'Endgültig löschen', danger: true }))) return;
    await wipeAll();
    stopRest(); sessionWakeOff();
    applyTheme();
    toast('Alle Daten gelöscht');
    return setTab('training');
  }
});
view.addEventListener('change', async (e) => {
  if (ui.tab !== 'daten' || ui.editing) return;
  const key = e.target.dataset.set;
  if (!key) return;
  state.settings[key] = e.target.type === 'checkbox' ? e.target.checked : Number(e.target.value);
  await saveSettings();
  if (key === 'volume') signal.test();
});
view.addEventListener('input', async (e) => {
  if (ui.tab !== 'daten' || ui.editing) return;
  const f = e.target.dataset.field;
  if (f === 'restSec' || f === 'prepSec') {
    const v = readStepper(e.target);
    if (v != null) { state.settings[f] = v; await saveSettings(); }
  }
});

function applyTheme() {
  const t = state.settings.theme || 'auto';
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = t;
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  $$('meta[name="theme-color"]').forEach((m) => {
    if (t === 'auto') m.setAttribute('content', m.media.includes('dark') ? '#121518' : '#E4E7EA');
    else m.setAttribute('content', dark ? '#121518' : '#E4E7EA');
  });
}

// ---------- Offline-Fähigkeit und Updates ----------
function registerSW() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const ask = (w) => toast('Neue Version verfügbar', { label: 'Neu laden', run: () => w.postMessage('skip') });
    if (reg.waiting && navigator.serviceWorker.controller) ask(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) ask(w);
      });
    });
  }).catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    location.reload();
  });
}

// ---------- Start ----------
(async function init() {
  try {
    await load();
  } catch (e) {
    view.innerHTML = `<div class="empty"><h2>Speicher nicht verfügbar</h2><p>Der Browser erlaubt keinen Zugriff auf den Gerätespeicher (z. B. im Inkognito-Modus). Öffne die App normal in Chrome.</p></div>`;
    return;
  }
  // leere, nicht weiter bearbeitete Nachträge aufräumen
  for (const s of [...state.sessions]) if (s.end && !s.entries.length) await deleteSession(s.id);
  applyTheme();
  if (state.activeId) sessionWakeOn();
  if (matchMedia('(display-mode: standalone)').matches && finishedSessions().length) requestPersist();
  render();
  registerSW();
  // Für Tests und Fehlersuche
  window.__kugelbuch = { state, VERSION };
})();
