// Timer: EMOM, Countdown/AMRAP, Stoppuhr, Pausentimer – mit Signalton, Vibration und Wachhalten des Bildschirms
import { state } from './store.js';
import { clock, esc } from './util.js';

// ---------- Ton ----------
let ctx;
export function initAudio() {
  try {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  } catch (e) { /* kein Ton verfügbar */ }
}

function tone(freq, ms, when = 0, gainMul = 1) {
  if (!ctx || !state.settings.sound) return;
  const t0 = ctx.currentTime + when;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'square';
  osc.frequency.value = freq;
  const vol = 0.22 * state.settings.volume * gainMul;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(vol, 0.0002), t0 + 0.01);
  g.gain.setValueAtTime(Math.max(vol, 0.0002), t0 + ms / 1000 - 0.03);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + ms / 1000);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + ms / 1000 + 0.02);
}
function buzz(pattern) {
  if (state.settings.vibrate && navigator.vibrate) navigator.vibrate(pattern);
}

export const signal = {
  tick() { tone(660, 120); buzz(60); },          // 3-2-1
  go() { tone(990, 550); buzz(300); },           // los / neue Runde
  minute() { tone(740, 180); buzz(80); },        // Minutensignal
  done() {                                       // fertig
    tone(990, 180, 0); tone(990, 180, 0.25); tone(1320, 500, 0.5);
    buzz([200, 100, 200, 100, 400]);
  },
  test() { initAudio(); this.go(); },
};

// ---------- Bildschirm wach halten ----------
let lock = null;
let lockWanted = 0;
async function acquire() {
  if (!('wakeLock' in navigator) || !state.settings.wakeLock) return;
  try {
    lock = await navigator.wakeLock.request('screen');
    lock.addEventListener('release', () => { lock = null; });
  } catch (e) { /* z. B. Akkusparmodus */ }
}
export function wakeOn() { lockWanted++; if (!lock) acquire(); }
export function wakeOff() {
  lockWanted = Math.max(0, lockWanted - 1);
  if (lockWanted === 0 && lock) { lock.release(); lock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && lockWanted > 0 && !lock) acquire();
});

// ---------- Zeitmotor ----------
// Phasen: prep (Vorlauf) → work. Zeit wird aus Zeitstempeln berechnet, nicht hochgezählt.
class Engine {
  constructor(cfg) {
    this.cfg = cfg;
    this.startedAt = performance.now();
    this.pausedAt = null;
    this.pausedTotal = 0;
    this.lastSecond = null;
    this.finished = false;
  }
  elapsed() {
    const now = this.pausedAt ?? performance.now();
    return (now - this.startedAt - this.pausedTotal) / 1000;
  }
  pause() { if (this.pausedAt == null) this.pausedAt = performance.now(); }
  resume() {
    if (this.pausedAt != null) { this.pausedTotal += performance.now() - this.pausedAt; this.pausedAt = null; }
  }
  get paused() { return this.pausedAt != null; }

  // Liefert den Anzeigezustand und löst Signale beim Übergang in eine neue Sekunde aus
  snapshot() {
    const { mode, prep = 0, interval = 60, rounds = 1, total = 0 } = this.cfg;
    const t = this.elapsed();
    const s = { phase: 'work', display: 0, sub: '', progress: 0, done: false, workElapsed: 0 };
    if (t < prep) {
      s.phase = 'prep';
      s.display = Math.ceil(prep - t);
      s.progress = t / prep;
      s.sub = 'Gleich geht’s los';
      this.signalAt(`p${s.display}`, () => { if (s.display <= 3) signal.tick(); });
      return s;
    }
    const w = t - prep;
    s.workElapsed = w;
    if (prep > 0) this.signalAt('go', () => signal.go());

    if (mode === 'emom') {
      const end = interval * rounds;
      if (w >= end) { s.done = true; s.display = 0; s.round = rounds; s.progress = 1; return s; }
      const round = Math.floor(w / interval) + 1;
      const inRound = w - (round - 1) * interval;
      const left = Math.ceil(interval - inRound);
      s.round = round;
      s.display = left;
      s.sub = `Runde ${round} von ${rounds}`;
      s.progress = inRound / interval;
      s.totalLeft = end - w;
      if (round > 1 || prep === 0) this.signalAt(`r${round}`, () => signal.go());
      if (left <= 3) this.signalAt(`r${round}t${left}`, () => signal.tick());
    } else if (mode === 'countdown' || mode === 'rest') {
      if (w >= total) { s.done = true; s.display = 0; s.progress = 1; return s; }
      const left = Math.ceil(total - w);
      s.display = left;
      s.progress = w / total;
      s.sub = mode === 'rest' ? 'Pause' : `von ${clock(total)}`;
      if (left <= 3) this.signalAt(`c${left}`, () => signal.tick());
      if (mode === 'countdown' && state.settings.minuteBeep) {
        const min = Math.floor(w / 60);
        if (min > 0 && left > 3) this.signalAt(`m${min}`, () => signal.minute());
      }
    } else if (mode === 'stopwatch') {
      s.display = Math.floor(w);
      s.sub = 'Läuft';
      s.progress = (w % 60) / 60;
    }
    return s;
  }
  signalAt(key, fn) {
    this.fired ??= new Set();
    if (this.fired.has(key)) return;
    this.fired.add(key);
    // Nach langer Hintergrundzeit keine verpassten Töne nachholen
    if (!document.hidden) fn();
  }
}

// ---------- Vollbild-Timer ----------
let current = null;

export function timerRunning() { return !!current; }

/**
 * startTimer({ mode, title, interval, rounds, total, onDone })
 * onDone({ completedRounds, elapsed, stoppedEarly })
 */
export function startTimer(opts) {
  initAudio();
  stopRest();
  const prep = opts.mode === 'stopwatch' ? Math.min(state.settings.prepSec, 5) : state.settings.prepSec;
  const engine = new Engine({ ...opts, prep });
  const el = document.getElementById('timer');
  const modeName = { emom: 'EMOM', countdown: 'Countdown', stopwatch: 'Zeit messen' }[opts.mode];
  el.innerHTML = `
    <div class="timer-top">
      <div>
        <div class="timer-mode">${modeName}</div>
        <div class="timer-title">${esc(opts.title || '')}</div>
      </div>
      <div class="timer-total" data-total></div>
    </div>
    <div class="timer-face">
      <svg class="timer-ring" viewBox="0 0 200 200" aria-hidden="true">
        <circle cx="100" cy="100" r="90" class="ring-bg"/>
        <circle cx="100" cy="100" r="90" class="ring-fg" data-ring pathLength="1000"/>
      </svg>
      <div class="timer-center">
        <div class="timer-digits" data-digits role="timer" aria-live="off">0</div>
        <div class="timer-sub" data-sub></div>
      </div>
    </div>
    <div class="timer-actions">
      <button class="btn btn-ghost btn-xl" data-act="pause">Pause</button>
      <button class="btn btn-primary btn-xl" data-act="stop">${opts.mode === 'stopwatch' ? 'Stopp' : 'Beenden'}</button>
    </div>`;
  el.hidden = false;
  el.dataset.phase = 'prep';
  document.body.classList.add('timer-open');
  wakeOn();

  const digits = el.querySelector('[data-digits]');
  const sub = el.querySelector('[data-sub]');
  const ring = el.querySelector('[data-ring]');
  const totalEl = el.querySelector('[data-total]');
  const pauseBtn = el.querySelector('[data-act="pause"]');

  let lastRound = 0;
  function render() {
    const s = engine.snapshot();
    el.dataset.phase = s.phase;
    if (s.round) lastRound = s.round;
    if (s.done) return finish(false, s);
    const showMinutes = s.display >= 60 || opts.mode === 'stopwatch';
    digits.textContent = showMinutes && s.phase !== 'prep' ? clock(s.display) : String(s.display);
    sub.textContent = engine.paused ? 'Pausiert' : s.sub;
    ring.style.strokeDashoffset = String(1000 - Math.min(1, s.progress) * 1000);
    totalEl.textContent = s.totalLeft != null ? `noch ${clock(s.totalLeft)}` : '';
  }
  const iv = setInterval(render, 100);
  render();

  function finish(stoppedEarly, s = engine.snapshot()) {
    clearInterval(iv);
    if (!stoppedEarly) signal.done();
    el.hidden = true;
    el.innerHTML = '';
    document.body.classList.remove('timer-open');
    wakeOff();
    current = null;
    const elapsed = Math.round(s.workElapsed || 0);
    let completedRounds = 0;
    if (opts.mode === 'emom') {
      completedRounds = stoppedEarly ? Math.max(0, (s.round || lastRound) - 1) : opts.rounds;
      if (s.phase === 'prep') completedRounds = 0;
    }
    opts.onDone?.({ completedRounds, elapsed: opts.mode === 'countdown' && !stoppedEarly ? opts.total : elapsed, stoppedEarly, partialRound: stoppedEarly ? (s.round || lastRound) : 0 });
  }

  el.onclick = (ev) => {
    const act = ev.target.closest('[data-act]')?.dataset.act;
    if (act === 'pause') {
      if (engine.paused) { engine.resume(); pauseBtn.textContent = 'Pause'; }
      else { engine.pause(); pauseBtn.textContent = 'Weiter'; }
      render();
    } else if (act === 'stop') {
      finish(true);
    }
  };
  current = { engine, finish };
}

// ---------- Pausentimer (kleine Leiste über der Navigation) ----------
let rest = null;
export function startRest(sec, label = 'Pause') {
  initAudio();
  stopRest();
  const bar = document.getElementById('restbar');
  const engine = new Engine({ mode: 'rest', total: sec, prep: 0 });
  bar.innerHTML = `
    <div class="rest-fill" data-fill></div>
    <div class="rest-row">
      <span class="rest-label">${esc(label)}</span>
      <span class="rest-digits" data-d></span>
      <button class="chip" data-r="-15" aria-label="15 Sekunden weniger">−15</button>
      <button class="chip" data-r="15" aria-label="15 Sekunden mehr">+15</button>
      <button class="chip" data-r="x" aria-label="Pause beenden">Weiter</button>
    </div>`;
  bar.hidden = false;
  document.body.classList.add('rest-open');
  const d = bar.querySelector('[data-d]');
  const fill = bar.querySelector('[data-fill]');
  function render() {
    const s = engine.snapshot();
    if (s.done) { signal.go(); stopRest(); return; }
    d.textContent = clock(s.display);
    fill.style.transform = `scaleX(${1 - s.progress})`;
  }
  const iv = setInterval(render, 200);
  render();
  bar.onclick = (ev) => {
    const r = ev.target.closest('[data-r]')?.dataset.r;
    if (!r) return;
    if (r === 'x') return stopRest();
    engine.cfg.total = Math.max(5, engine.cfg.total + Number(r));
    engine.fired = new Set([...(engine.fired || [])].filter((k) => !k.startsWith('c')));
    render();
  };
  rest = { iv };
}
export function stopRest() {
  if (!rest) return;
  clearInterval(rest.iv);
  rest = null;
  const bar = document.getElementById('restbar');
  bar.hidden = true;
  bar.innerHTML = '';
  document.body.classList.remove('rest-open');
}
