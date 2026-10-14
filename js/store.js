// Datenhaltung: IndexedDB auf dem Gerät, gespiegelt in einem Arbeitsstand im Speicher.
import { uid } from './util.js';

const DB_NAME = 'kugelbuch';
// Version 2: zusätzlicher Speicher für Trainingsvorlagen. Vorhandene Daten bleiben beim Upgrade unverändert.
const DB_VERSION = 2;
const STORES = ['exercises', 'sessions', 'meta', 'templates'];

let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const s of STORES) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const d = req.result;
      // Falls eine neuere Version in einem anderen Tab startet: Verbindung freigeben
      d.onversionchange = () => { d.close(); location.reload(); };
      resolve(d);
    };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const getAll = (store) => tx(store, 'readonly', (s) => s.getAll());
const put = (store, obj) => tx(store, 'readwrite', (s) => s.put(structuredClone(obj)));
const del = (store, id) => tx(store, 'readwrite', (s) => s.delete(id));
const clear = (store) => tx(store, 'readwrite', (s) => s.clear());

// ---------- Fachliche Konstanten ----------

export const INSTRUMENTS = {
  kb: 'Kugelhantel',
  bw: 'Körpergewicht',
  bb: 'Langhantel',
  other: 'Sonstiges',
};

// Variante: wie die Übung ausgeführt und gezählt wird
export function sideOptions(instrument) {
  if (instrument === 'kb') return { both: 'beidarmig', one: 'einarmig', double: 'doppelt' };
  if (instrument === 'bw') return { both: 'normal', one: 'einseitig' };
  return { both: 'normal' };
}
export function sideLabel(ex) {
  if (!ex.side || ex.side === 'both') return ex.instrument === 'kb' ? 'beidarmig' : '';
  return sideOptions(ex.instrument)[ex.side] || '';
}

export const METRICS = { reps: 'Wiederholungen', time: 'Zeit', both: 'Wiederholungen und Zeit' };

export const STANDARD_BELLS = [4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 32, 36, 40, 44, 48];

// Farbcodes von Wettkampf-Kugelhanteln. Text dunkel oder hell, je nach Kontrast.
const BELL_COLORS = {
  8: ['#F2A7C3', 'dark'],
  10: ['#9AD1F0', 'dark'],
  12: ['#2F6FD0', 'light'],
  14: ['#E1C49B', 'dark'],
  16: ['#F4D23C', 'dark'],
  18: ['#7FB6E8', 'dark'],
  20: ['#7B4FB8', 'light'],
  22: ['#A3B0BC', 'dark'],
  24: ['#2E9B58', 'light'],
  26: ['#8F6B4A', 'light'],
  28: ['#EE8A2C', 'dark'],
  32: ['#D23A2F', 'light'],
  36: ['#7E8790', 'light'],
  40: ['#F2F2EE', 'dark'],
  44: ['#C6CCD2', 'dark'],
  48: ['#D9B44A', 'dark'],
};
export function bellColor(w) {
  return BELL_COLORS[w] || ['#4B545D', 'light'];
}

export const DEFAULT_SETTINGS = {
  id: 'settings',
  bells: [8, 12, 16, 20, 24, 28, 32],
  restAuto: true,
  restSec: 90,
  sound: true,
  volume: 0.7,
  vibrate: true,
  wakeLock: true,
  prepSec: 10,
  minuteBeep: false,
  lastBackup: null,
  backupNagDays: 14,
};

// ---------- Arbeitsstand ----------

export const state = {
  exercises: [],
  sessions: [],
  templates: [],
  settings: { ...DEFAULT_SETTINGS },
  activeId: null,
};

export async function load() {
  db = await openDB();
  const [ex, se, meta, tp] = await Promise.all(STORES.map(getAll));
  state.exercises = ex.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  state.sessions = se.sort((a, b) => b.start - a.start);
  state.templates = tp;
  sortTemplates();
  const settings = meta.find((m) => m.id === 'settings');
  state.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const active = meta.find((m) => m.id === 'active');
  state.activeId = active?.sessionId && state.sessions.some((s) => s.id === active.sessionId) ? active.sessionId : null;
}

export async function saveSettings() {
  await put('meta', state.settings);
}

export async function setActive(id) {
  state.activeId = id;
  await put('meta', { id: 'active', sessionId: id });
}

// Übungen
export function exById(id) {
  return state.exercises.find((e) => e.id === id);
}
export function exName(ex) {
  if (!ex) return 'Gelöschte Übung';
  const s = sideLabel(ex);
  return ex.instrument === 'kb' && s ? `${ex.name}, ${s}` : s ? `${ex.name}, ${s}` : ex.name;
}
export async function saveExercise(ex) {
  if (!ex.id) ex.id = uid();
  if (!ex.created) ex.created = Date.now();
  const i = state.exercises.findIndex((e) => e.id === ex.id);
  if (i >= 0) state.exercises[i] = ex;
  else state.exercises.push(ex);
  state.exercises.sort((a, b) => a.name.localeCompare(b.name, 'de') || (a.side || '').localeCompare(b.side || ''));
  await put('exercises', ex);
  return ex;
}
export async function deleteExercise(id) {
  state.exercises = state.exercises.filter((e) => e.id !== id);
  await del('exercises', id);
  // auch aus Vorlagen entfernen
  for (const t of state.templates) {
    if (t.items.some((it) => it.exId === id)) {
      t.items = t.items.filter((it) => it.exId !== id);
      await put('templates', t);
    }
  }
}
export function exerciseUsage(id) {
  let n = 0;
  for (const s of state.sessions) for (const e of s.entries) if (e.exId === id) n++;
  return n;
}
export function exerciseTemplates(id) {
  return state.templates.filter((t) => t.items.some((it) => it.exId === id));
}

// Trainingseinheiten
export function sessionById(id) {
  return state.sessions.find((s) => s.id === id);
}
export async function saveSession(s) {
  if (!s.id) s.id = uid();
  const i = state.sessions.findIndex((x) => x.id === s.id);
  if (i >= 0) state.sessions[i] = s;
  else state.sessions.push(s);
  state.sessions.sort((a, b) => b.start - a.start);
  await put('sessions', s);
  return s;
}
export async function deleteSession(id) {
  state.sessions = state.sessions.filter((s) => s.id !== id);
  await del('sessions', id);
  if (state.activeId === id) await setActive(null);
}

// ---------- Trainingsvorlagen ----------
// template: { id, name, created, updated, lastUsed, items: [item] }
// item:     { id, exId, sets: [{ w, r, t }], timer: null | { mode: 'emom', interval, rounds, r, w, t } | { mode: 'countdown', total, w } }

function sortTemplates() {
  state.templates.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.created - b.created);
}
export function templateById(id) {
  return state.templates.find((t) => t.id === id);
}
export async function saveTemplate(t) {
  if (!t.id) t.id = uid();
  if (!t.created) t.created = Date.now();
  if (t.order == null) t.order = Math.max(0, ...state.templates.map((x) => (x.order ?? 0) + 1));
  t.updated = Date.now();
  const i = state.templates.findIndex((x) => x.id === t.id);
  if (i >= 0) state.templates[i] = t;
  else state.templates.push(t);
  sortTemplates();
  await put('templates', t);
  return t;
}
export async function deleteTemplate(id) {
  state.templates = state.templates.filter((t) => t.id !== id);
  await del('templates', id);
}
export async function moveTemplate(id, dir) {
  const i = state.templates.findIndex((t) => t.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= state.templates.length) return;
  const list = state.templates;
  [list[i], list[j]] = [list[j], list[i]];
  for (let k = 0; k < list.length; k++) {
    if (list[k].order !== k) { list[k].order = k; await put('templates', list[k]); }
  }
}

const cleanSet = (s) => ({ w: s.w ?? null, r: s.r ?? null, t: s.t ?? null });

// Ein erledigter Übungseintrag wird zu einem Vorlagen-Baustein.
// EMOM-Runden werden wieder zu einer EMOM-Vorgabe, ein AMRAP-Ergebnis zu einer Countdown-Vorgabe.
export function entryToItem(entry) {
  const emom = entry.sets.filter((s) => s.tag?.startsWith('EMOM'));
  const amrap = entry.sets.filter((s) => s.tag === 'AMRAP');
  const plain = entry.sets.filter((s) => !s.tag?.startsWith('EMOM') && s.tag !== 'AMRAP');
  let timer = null;
  if (emom.length) {
    const f = emom[0];
    timer = { mode: 'emom', interval: parseIntervalTag(f.tag) || 60, rounds: emom.length, r: f.r ?? null, w: f.w ?? null, t: f.t ?? null };
  } else if (amrap.length) {
    const f = amrap[0];
    timer = { mode: 'countdown', total: f.t || 600, w: f.w ?? null };
  }
  return { id: uid(), exId: entry.exId, sets: plain.map(cleanSet), timer };
}
function parseIntervalTag(tag) {
  const m = /(\d+):(\d{2})/.exec(tag || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
export function sessionToItems(s) {
  return s.entries.filter((e) => e.sets.length).map(entryToItem);
}
// Vorlagen-Baustein → Eintrag einer neuen Einheit mit geplanten (noch offenen) Sätzen
export function itemToEntry(item) {
  const e = { id: uid(), exId: item.exId, sets: [], plan: (item.sets || []).map((s) => ({ id: uid(), ...cleanSet(s) })) };
  if (item.timer) e.timer = { ...item.timer };
  return e;
}
// Vergleich ohne IDs: hat sich gegenüber der Vorlage etwas geändert?
export function itemsSignature(items) {
  return JSON.stringify(items.map((it) => [it.exId, (it.sets || []).map((s) => [s.w ?? null, s.r ?? null, s.t ?? null]), it.timer || null]));
}

// ---------- Kennzahlen ----------

// Faktor für Volumen und Gesamtwiederholungen
export function sideFactor(ex) {
  if (!ex) return 1;
  if (ex.side === 'one' || ex.side === 'double') return 2;
  return 1;
}
export function setVolume(ex, set) {
  if (!set.w || !set.r) return 0;
  return set.w * set.r * sideFactor(ex);
}
export function setReps(ex, set) {
  if (!set.r) return 0;
  return ex?.side === 'one' ? set.r * 2 : set.r;
}
export function sessionDuration(s) {
  const end = s.end ?? Date.now();
  return Math.max(0, Math.round((end - s.start) / 1000));
}
export function sessionVolume(s) {
  let v = 0;
  for (const e of s.entries) {
    const ex = exById(e.exId);
    for (const set of e.sets) v += setVolume(ex, set);
  }
  return v;
}
export function finishedSessions() {
  return state.sessions.filter((s) => s.end);
}

// Letzte abgeschlossene Durchführung einer Übung (außer in der angegebenen Einheit)
export function lastPerformance(exId, excludeSessionId) {
  for (const s of state.sessions) {
    if (s.id === excludeSessionId) continue;
    const e = s.entries.find((en) => en.exId === exId && en.sets.length);
    if (e) return { session: s, entry: e };
  }
  return null;
}

// ---------- Sicherung ----------

export function exportData() {
  return {
    app: 'kugelbuch',
    format: 2,
    exported: new Date().toISOString(),
    exercises: state.exercises,
    sessions: state.sessions,
    templates: state.templates,
    settings: { ...state.settings, lastBackup: undefined },
  };
}

export async function importData(data, mode) {
  if (!data || data.app !== 'kugelbuch' || !Array.isArray(data.sessions) || !Array.isArray(data.exercises)) {
    throw new Error('Diese Datei ist kein Kugelbuch-Backup.');
  }
  if (mode === 'replace') {
    await clear('exercises');
    await clear('sessions');
    await clear('templates');
    state.exercises = [];
    state.sessions = [];
    state.templates = [];
    await setActive(null);
  }
  for (const ex of data.exercises) await saveExercise(ex);
  for (const s of data.sessions) await saveSession(s);
  // Backups im alten Format (1) haben noch keine Vorlagen
  if (Array.isArray(data.templates)) {
    for (const t of data.templates) if (t && Array.isArray(t.items)) await saveTemplate(t);
  }
  if (data.settings && mode === 'replace') {
    const keep = state.settings.lastBackup;
    state.settings = { ...DEFAULT_SETTINGS, ...data.settings, id: 'settings', lastBackup: keep };
    await saveSettings();
  }
  return { exercises: data.exercises.length, sessions: data.sessions.length, templates: data.templates?.length || 0 };
}

export async function wipeAll() {
  for (const s of STORES) await clear(s);
  state.exercises = [];
  state.sessions = [];
  state.templates = [];
  state.settings = { ...DEFAULT_SETTINGS };
  state.activeId = null;
}

// Übungen für den Schnellstart (lassen sich danach frei ändern oder löschen)
export const STARTER_EXERCISES = [
  { name: 'Swing', instrument: 'kb', side: 'both', metric: 'reps' },
  { name: 'Swing', instrument: 'kb', side: 'one', metric: 'reps' },
  { name: 'Clean & Press', instrument: 'kb', side: 'one', metric: 'reps' },
  { name: 'Snatch', instrument: 'kb', side: 'one', metric: 'both' },
  { name: 'Turkish Get-Up', instrument: 'kb', side: 'one', metric: 'reps' },
  { name: 'Goblet Squat', instrument: 'kb', side: 'both', metric: 'reps' },
  { name: 'Front Squat', instrument: 'kb', side: 'double', metric: 'reps' },
  { name: 'Liegestütz', instrument: 'bw', side: 'both', metric: 'reps' },
  { name: 'Klimmzug', instrument: 'bw', side: 'both', metric: 'reps' },
  { name: 'Unterarmstütz', instrument: 'bw', side: 'both', metric: 'time' },
];
