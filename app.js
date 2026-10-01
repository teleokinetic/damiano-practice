/* Strength Rebuild — v2: one gym surface, one-press set (silent timer).
   No per-set logging: tracked slots capture one working weight (prefilled
   from last session), menu slots take a note. Sets are counted, never
   logged — on "N×" slots the ring banks a set per tap and each tap starts
   that exercise's rest itself; the dock stays for manual rests. */

'use strict';

/* ============================== state ============================== */

const STORE_KEY = 'damiano-state-v1';
const V1_KEY = 'damiano-no-v1';        // read-only: migration source, never written
const APP_VERSION = '1.4.0';

let state = null;

function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function defaultState() {
  return {
    version: 2,
    settings: {
      unit: 'lb', theme: 'auto', restNormal: 120, restHeavy: 180, lastExport: null,
      recalDate: '', targetsOpen: false,
    },
    videoReqs: defaultVideoReqs(),
    program: JSON.parse(JSON.stringify(SEED_PROGRAM)),
    sessions: [],
    active: null,
  };
}

function validState(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.version !== 2) return false;
  const s = obj.settings;
  if (!s || typeof s !== 'object') return false;
  if (s.unit == null || s.theme == null || !(s.restNormal > 0) || !(s.restHeavy > 0)) return false;
  if (!obj.program || !Array.isArray(obj.program.days)) return false;
  if (!Array.isArray(obj.sessions)) return false;
  return true;
}

// v1 → v2: per-set logs collapse to one working weight (the heaviest set),
// but the raw sets ride along under `sets` so nothing is lost for export
// analysis. The v1 blob itself is left in localStorage untouched as a backup.
function migrateV1Sessions(v1) {
  const out = [];
  const collapse = (entry) => {
    let w = '';
    for (const set of entry.sets || []) {
      const n = parseFloat(set.w);
      if (Number.isFinite(n) && (w === '' || n > w)) w = n;
    }
    return {
      exerciseId: entry.exerciseId || slug(entry.name),
      name: entry.name,
      weight: w,
      note: entry.note || '',
      sets: entry.sets || [],
    };
  };
  for (const sess of v1.sessions || []) {
    out.push({
      id: sess.id, v: 1,
      dayId: sess.dayId, dayName: sess.dayName,
      startedAt: sess.startedAt, endedAt: sess.endedAt,
      note: sess.note || '',
      entries: (sess.entries || []).map(collapse),
    });
  }
  // A v1 session left mid-flight still holds real logged sets — keep them.
  if (v1.active && v1.active.entries) {
    const entries = [];
    for (const slotId in v1.active.entries) {
      const e = v1.active.entries[slotId];
      const done = (e.sets || []).filter((s) => s.done);
      if (done.length) entries.push(collapse({ exerciseId: e.exerciseId, name: e.exerciseId, note: e.note, sets: done }));
    }
    if (entries.length) {
      out.push({
        id: 'v1-active', v: 1,
        dayId: v1.active.dayId, dayName: v1.active.dayId,
        startedAt: v1.active.startedAt, endedAt: v1.active.startedAt,
        note: '(recovered mid-session log)',
        entries,
      });
    }
  }
  return out;
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (validState(parsed)) {
        state = parsed;
        // settings added after v2 shipped — backfill on existing devices
        if (state.settings.recalDate == null) state.settings.recalDate = '2026-08-29';
        if (state.settings.targetsOpen == null) state.settings.targetsOpen = false;
        if (!state.videoReqs) state.videoReqs = defaultVideoReqs();
        if (!state.program || state.program.specVersion !== SEED_PROGRAM.specVersion) {
          state.program = JSON.parse(JSON.stringify(SEED_PROGRAM));
          if (state.active && !findDay(state.active.dayId)) state.active = null;
          save();
        }
        return;
      }
    }
  } catch (e) { /* corrupted → fall through */ }

  state = defaultState();
  try {
    const rawV1 = localStorage.getItem(V1_KEY);
    if (rawV1) {
      const v1 = JSON.parse(rawV1);
      if (v1 && v1.version === 1) {
        state.sessions = migrateV1Sessions(v1);
        if (v1.settings) {
          if (v1.settings.theme) state.settings.theme = v1.settings.theme;
          if (v1.settings.unit) state.settings.unit = v1.settings.unit;
        }
      }
    }
  } catch (e) { /* v1 unreadable → fresh start */ }
  save();
}

// One-time program updates for installed devices — the seed only reaches
// fresh installs; the live program sits in localStorage. Staged by
// specVersion so each patch runs once and in-app edits afterward stick.
function patchProgram() {
  return;   // Damiano's program changes ship through the seed (see load()).
  const p = state.program;
  if (!p) return;
  const v = parseFloat(p.specVersion) || 0;
  if (v >= 1.8) return;

  // 0.4: Bulgarian split squat becomes Stork squat; both days open
  // with a no-weight Prep slot (wrist prep + passive/active hangs).
  if (v < 0.4) {
    for (const day of p.days) {
      const bsq = day.slots.find((s) => slug(s.name) === 'bulgarian-split-squat-rfe');
      if (bsq) bsq.name = 'Stork squat';
      if (!day.slots.some((s) => slug(s.name) === 'prep')) {
        day.slots.unshift({
          id: 'prep-' + day.id, name: 'Prep', target: '~4 min',
          track: false, rest: 'normal',
          menu: [
            'Wrist circles — slow, through the end-ranges',
            'Quadruped rocking on palms — fingers forward, out, back toward knees',
            'Back-of-hand rocking, light',
            'Passive hang → active hang × 2',
          ],
          cue: 'Wake the wrists and shoulders — easy loading, wide angles, nothing near effort',
        });
      }
    }
  }

  // 0.5: Day A prep drops the hangs — that day already closes on them.
  if (v < 0.5) {
    const dayA = p.days.find((d) => d.id === 'dayA');
    const prepA = dayA && dayA.slots.find((s) => slug(s.name) === 'prep');
    if (prepA && prepA.menu) {
      prepA.menu = prepA.menu.filter((m) => !/passive hang/i.test(m));
      if (prepA.target === '~4 min') prepA.target = '~3 min';
      if (/wrists and shoulders/.test(prepA.cue || '')) {
        prepA.cue = 'Wake the wrists — easy loading, wide angles, nothing near effort';
      }
    }
  }

  // 0.6: he's been back-squatting — rename the slot AND relabel the
  // logged history, since those loads were back-squat loads all along.
  // Prefill follows the history rewrite automatically.
  if (v < 0.6) {
    for (const day of p.days) {
      const sq = day.slots.find((s) => slug(s.name) === 'front-squat');
      if (sq) sq.name = 'Back squat';
    }
    for (const sess of state.sessions) {
      for (const e of sess.entries || []) {
        if (e.exerciseId === 'front-squat') { e.exerciseId = 'back-squat'; e.name = 'Back squat'; }
      }
    }
  }

  // 0.7: row progression made explicit — reps before load.
  if (v < 0.7) {
    for (const day of p.days) {
      const row = day.slots.find((s) => slug(s.name) === 'one-arm-db-row');
      if (row) row.cue = 'Reps first — build to 3×8–10, then +5 · bench support, lead with the shoulder blade';
    }
  }

  // 0.8: working-reps capture on reps-first slots (row, chins), plus a
  // one-time backfill of entry.reps from v1 per-set history so prefill
  // and the board have honest numbers on day one.
  if (v < 0.8) {
    for (const sess of state.sessions) {
      for (const e of sess.entries || []) {
        if (e.reps == null && Array.isArray(e.sets)) {
          let best = '';
          for (const set of e.sets) {
            const n = parseInt(set.r, 10);
            if (Number.isFinite(n) && (best === '' || n > best)) best = n;
          }
          if (best !== '') e.reps = best;
        }
      }
    }
  }

  // 0.9: reps tracking on every double-progression slot — anything with a
  // rep RANGE (the range is the trigger mechanism; fixed-rep and distance
  // slots have no rep dial and stay weight-only).
  if (v < 0.9) {
    const DOUBLE_PROGRESSION = [
      'one-arm-db-row', 'chin-up-strict',
      'db-bench-press', 'stork-squat', 'pallof-press',
      'db-romanian-deadlift', 'db-standing-overhead-press',
    ];
    for (const day of p.days) {
      for (const s of day.slots) {
        if (DOUBLE_PROGRESSION.indexOf(slug(s.name)) !== -1) s.reps = true;
      }
    }
  }

  // 1.0: dead-hang time test on the Day A hang slot — occasional, logged
  // via the note button, read at recalibrations.
  if (v < 1.0) {
    for (const day of p.days) {
      const hang = day.slots.find((s) => slug(s.name) === 'hang-grip');
      if (hang && hang.menu && !hang.menu.some((m) => /Dead-hang max/.test(m))) {
        hang.menu.push('Dead-hang max — occasional test: 60 s solid · 90 s strong (log it in a note)');
      }
    }
  }

  // 1.1: deep-flexion reclaim (his 8/1 ask) — active knee flexion at short
  // muscle length, the semiT+gracilis harvest deficit; opposite end from the
  // slider curl's long-length eccentrics, so knee-flexion work lands both days.
  if (v < 1.1) {
    const dayB = p.days.find((d) => d.id === 'dayB');
    if (dayB && !dayB.slots.some((s) => slug(s.name) === 'heel-to-butt-curl')) {
      dayB.slots.push({
        id: 'b7', name: 'Heel-to-butt curl', target: '2×5–8 /side',
        track: false, rest: 'normal',
        menu: [
          'Prone curl — pause 3–5 s at max closure',
          'Standing pull — hip extended, no back arch',
          'Assisted overpressure — hand or strap closes the last bit, hold against it',
          'Any of these with toes turned in — medial-hamstring bias',
        ],
        cue: 'Right leads, rep-matched — the last 20° of closure is the exercise; clicking OK, sharp pinch = back off',
      });
    }
  }

  // 1.2: single-leg calf closes Day B (pulled forward from the 8/29 recal
  // agenda at his ask) — soleus-biased bent-knee work, ACL-side capacity;
  // also supports the dorsiflexion strategy that quiets the knee click.
  if (v < 1.2) {
    const dayB = p.days.find((d) => d.id === 'dayB');
    if (dayB && !dayB.slots.some((s) => slug(s.name) === 'calf-single-leg')) {
      dayB.slots.push({
        id: 'b8', name: 'Calf, single-leg', target: '2×8–15 /side',
        track: true, reps: true, rest: 'normal',
        menu: [
          'Split Squat Iso w Calf Raise — front foot off a box edge, nothing moves but the heel',
          '3D Calf Raise — drive the roller into the wall, find the angles',
        ],
        cue: 'Right leads, rep-matched — bent knee, full range, slow heel drop; ribs down, weight forward',
      });
    }
  }

  // 1.3: hollow body replaces the hanging leg raise — shared slot with
  // Carolina's Forte program so they can do it together; anti-extension
  // work the week was otherwise missing (Pallof covers rotation, carry
  // covers lateral). Same position in the Day B order.
  if (v < 1.3) {
    const dayB = p.days.find((d) => d.id === 'dayB');
    const hlr = dayB && dayB.slots.find((s) => slug(s.name) === 'hanging-leg-raise');
    if (hlr) {
      hlr.name = 'Hollow body';
      hlr.target = '3×20–30 s';
      hlr.menu = [
        'Tuck hollow — low back pressed into the floor',
        'One leg extended',
        'Full hollow — arms overhead last',
        'Rocking hollow — once the shape is solid',
      ];
      hlr.cue = 'Low back glued down — shrink the shape before it breaks';
    }
  }

  // 1.4: the slider curl becomes the Nordic ladder — the loose variant menu
  // becomes ordered rungs (Forte's rung-pill pattern). Tap today's rung; it
  // carries forward like a weight, and the board's Nordic row reads it live.
  // Old slider-leg-curl note entries stay put — they really were slider curls.
  if (v < 1.4) {
    const dayA = p.days.find((d) => d.id === 'dayA');
    const s = dayA && dayA.slots.find((x) => slug(x.name) === 'slider-leg-curl');
    if (s && !s.rungs) {
      s.name = 'Nordic ladder';
      s.target = '3×4–8';
      delete s.menu;
      s.rungs = [
        'Bilateral slider', 'Single-leg slider', 'Shallow negative',
        'Full negative', 'Band assist', 'Full Nordic',
      ];
      s.cue = 'Slow 3–5 s eccentric; right leads, rep-matched — own a rung crisp, then move up';
    }
  }

  // 1.5: the anti-extension package (his call, 2026-08-07). The Pallof after
  // bench was pressing on spent muscles — four buffer slots didn't save it,
  // so it moves to the bench-free day: Day B, after the transitional squats
  // and BEFORE the walkout ladder (the light press-out goes first, walkouts
  // would wreck it in return). Hollow body folds in as the ladder's floor
  // rung; the hanging leg raise returns as a hang-slot option — its limits
  // are grip and hip flexors, so it lives with the hangs, not the ladder.
  if (v < 1.5) {
    const dayA = p.days.find((d) => d.id === 'dayA');
    const dayB = p.days.find((d) => d.id === 'dayB');
    if (dayA && dayB) {
      const i = dayA.slots.findIndex((s) => slug(s.name) === 'pallof-press');
      if (i !== -1 && !dayB.slots.some((s) => slug(s.name) === 'pallof-press')) {
        const pallof = dayA.slots.splice(i, 1)[0];
        pallof.cue = "Resist rotation, don't create it — moved off bench day, fresh shoulders";
        const j = dayB.slots.findIndex((s) => slug(s.name) === 'transitional-squats');
        dayB.slots.splice(j === -1 ? dayB.slots.length : j + 1, 0, pallof);
      }
    }
    const hb = dayB && dayB.slots.find((s) => slug(s.name) === 'hollow-body');
    if (hb && !hb.rungs) {
      hb.name = 'Anti-extension ladder';
      hb.target = '1–2×5–8';
      delete hb.menu;
      hb.rungs = [
        'Hollow body — 45 s',
        'All-fours → plank',
        'Accordion walk — down dog → plank',
        'Elbow accordion — knees ↔ elbows',
        'Kneeling walkout — reach is the dial',
        'Kneeling rollout — wheel or sliders',
        'Standing rollout',
      ];
      hb.cue = 'Pass a rung: full reps, no low-back sag, breath never stops — then reach further';
    }
    const hang = dayA && dayA.slots.find((s) => slug(s.name) === 'hang-grip');
    if (hang && hang.menu && !hang.menu.some((m) => /leg raise/i.test(m))) {
      hang.menu.splice(4, 0, 'Hanging leg raise — knees or toes-to-bar; curl the pelvis first, no swing');
    }
  }

  // 1.6: the pairing map (his 8/12 call — Forte's pair model, ported).
  // Same-letter slots within a day are done together, alternating sets; a
  // group can carry its own rest (pairRest) — press + chins at 1:30, the
  // Day B finisher trio at 1:00. The Pallof stands alone before the trio.
  if (v < 1.6) {
    const set = (day, key, fields) => {
      const s = day && day.slots.find((x) => slug(x.name) === key);
      if (s) Object.assign(s, fields);
    };
    const dayA = p.days.find((d) => d.id === 'dayA');
    set(dayA, 'db-bench-press', { pair: 'a', short: 'the bench' });
    set(dayA, 'one-arm-db-row', { pair: 'a', short: 'the row' });
    set(dayA, 'nordic-ladder', { pair: 'b', short: 'Nordics' });
    set(dayA, 'suitcase-carry', { pair: 'b', short: 'the carry' });
    const dayB = p.days.find((d) => d.id === 'dayB');
    set(dayB, 'db-standing-overhead-press', { pair: 'a', short: 'the press', pairRest: 90 });
    set(dayB, 'chin-up-strict', { pair: 'a', short: 'chins', pairRest: 90 });
    set(dayB, 'anti-extension-ladder', { pair: 'b', short: 'the ladder', pairRest: 60 });
    set(dayB, 'heel-to-butt-curl', { pair: 'b', short: 'heel curls', pairRest: 60 });
    set(dayB, 'calf-single-leg', { pair: 'b', short: 'calves', pairRest: 60 });
  }

  // 1.7: press range widens to 6–10 (his 8/15 call) — a little joint room;
  // he waves load up and down inside the range rather than riding the top.
  if (v < 1.7) {
    const dayB = p.days.find((d) => d.id === 'dayB');
    const press = dayB && dayB.slots.find((s) => slug(s.name) === 'db-standing-overhead-press');
    if (press) press.target = '3×6–10 · RIR 2–3';
  }

  // 1.8: the quiet program (his 9/30 call). He knows the work now, so the
  // cues and warm-up lines come off everything but the hang, the prep and
  // jump menus go, and the Day B finishers read in short names. Ladder
  // rungs are renamed in the logged history too so the rail and the board
  // keep their place. Transitional squats get a set count so the ring
  // counts them like the other lifts.
  if (v < 1.8) {
    const RUNGS = {
      'Hollow body — 45 s': 'Hollow body',
      'All-fours → plank': 'All-fours to plank',
      'Accordion walk — down dog → plank': 'Accordion walk',
      'Elbow accordion — knees ↔ elbows': 'Elbow accordion',
      'Kneeling walkout — reach is the dial': 'Kneeling walkout',
      'Kneeling rollout — wheel or sliders': 'Kneeling rollout',
    };
    const MENUS = {
      'Prone curl — pause 3–5 s at max closure': 'Prone curl',
      'Standing pull — hip extended, no back arch': 'Standing pull',
      'Assisted overpressure — hand or strap closes the last bit, hold against it': 'Assisted overpressure',
      'Any of these with toes turned in — medial-hamstring bias': 'Toes turned in',
      'Split Squat Iso w Calf Raise — front foot off a box edge, nothing moves but the heel': 'Split squat iso + calf raise',
      '3D Calf Raise — drive the roller into the wall, find the angles': '3D calf raise',
    };
    for (const day of p.days) {
      for (const s of day.slots) {
        const k = slug(s.name);
        if (k !== 'hang-grip') { delete s.cue; delete s.warmup; }
        if (k === 'prep' || k === 'jump-to-targets') delete s.menu;
        if (k === 'transitional-squats' && /shapes/.test(s.target || '')) s.target = '3 sets · one per shape';
        if (k === 'anti-extension-ladder' && Array.isArray(s.rungs)) s.rungs = s.rungs.map((r) => RUNGS[r] || r);
        if ((k === 'heel-to-butt-curl' || k === 'calf-single-leg') && Array.isArray(s.menu)) {
          s.menu = s.menu.map((m) => MENUS[m] || m);
        }
      }
    }
    for (const sess of state.sessions) {
      for (const e of sess.entries || []) {
        if (e.exerciseId === 'anti-extension-ladder' && RUNGS[e.rung]) e.rung = RUNGS[e.rung];
      }
    }
    if (state.active && state.active.entries) {
      for (const id in state.active.entries) {
        const e = state.active.entries[id];
        if (e && RUNGS[e.rung]) e.rung = RUNGS[e.rung];
      }
    }
  }

  p.specVersion = '1.8';
  save();
}

let saveTimer = null;
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { toast('Could not save — storage full?'); }
}
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
}
function flushSave() { clearTimeout(saveTimer); save(); }
window.addEventListener('pagehide', flushSave);
document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });

/* ============================== helpers ============================== */

const $ = (sel) => document.querySelector(sel);

function esc(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function fmtMMSS(sec) {
  sec = Math.max(0, Math.round(sec));
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function greeting() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return 'Good morning';
  if (h >= 12 && h < 17) return 'Good afternoon';
  return 'Good evening';
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function relPhrase(ts) {
  const days = Math.round((startOfDay(Date.now()) - startOfDay(ts)) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 11) return 'a week ago';
  return `${Math.round(days / 7)} weeks ago`;
}

// Training weeks start Monday.
function weekStart(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (d.getDay() + 6) % 7);
  return d.getTime();
}

function cap(s) { s = String(s); return s.charAt(0).toUpperCase() + s.slice(1); }

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function findDay(dayId) { return state.program.days.find((d) => d.id === dayId); }
function findSlot(day, slotId) { return day ? day.slots.find((s) => s.id === slotId) : null; }

function applyTheme() {
  const t = state.settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  else document.documentElement.removeAttribute('data-theme');
}

let toastTimer = null;
function toast(msg) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ========================= history & prefill ========================= */

// Most recent recorded weight for an exercise, matched by name-slug so it
// survives program edits and the v1→v2 migration alike.
function lastWeightFor(exerciseId) {
  for (let i = state.sessions.length - 1; i >= 0; i--) {
    const entry = (state.sessions[i].entries || []).find(
      (e) => e.exerciseId === exerciseId && e.weight !== '' && e.weight != null
    );
    if (entry) return entry.weight;
  }
  return '';
}

// Working reps mirror the working weight: one number per exercise per
// session ("what did your work sets hit"), never per-set entry.
function lastRepsFor(exerciseId) {
  for (let i = state.sessions.length - 1; i >= 0; i--) {
    const entry = (state.sessions[i].entries || []).find(
      (e) => e.exerciseId === exerciseId && e.reps > 0
    );
    if (entry) return entry.reps;
  }
  return '';
}

// Ladder position mirrors the working weight: the rung picked (or carried)
// per session, matched by name so ladder edits don't orphan history.
function lastRungFor(exerciseId) {
  for (let i = state.sessions.length - 1; i >= 0; i--) {
    const entry = (state.sessions[i].entries || []).find(
      (e) => e.exerciseId === exerciseId && e.rung
    );
    if (entry) return entry.rung;
  }
  return '';
}

function lastSessionFor(dayId) {
  for (let i = state.sessions.length - 1; i >= 0; i--) {
    if (state.sessions[i].dayId === dayId) return state.sessions[i];
  }
  return null;
}

// Legacy: sessions older versions banked automatically carry this note. They
// now move out of the log at boot (quarantineAutoSessions), so this filter
// only matters for an old export imported mid-launch.
const AUTO_NOTE = '(auto-saved — session left open)';
function isAutoSession(s) { return s.note === AUTO_NOTE; }
function realSessions() { return state.sessions.filter((s) => !isAutoSession(s)); }

/* ======================= targets board (ledger) =======================
   Treatment 1 "instrument ledger": collapsed = 7-column equalizer,
   expanded = current / target rows. The definition lives in CODE, not
   state — targets change at recalibration sessions (export → redesign),
   which land here as updates. Static `cur`/`pct` entries are calibration
   snapshots (chins, Nordic) refreshed the same way. Targets doc:
   vault → Projects/Strength Rebuild/Project Context, "Targets" section. */

const TARGETS = [
  { key: 'squat',  label: 'Back squat', eq: 'Sqt', ex: 'back-squat',     goal: 230, goalText: '230 ×5' },
  // bench mark is barbell 155×5; DB-equivalent proxy ≈ 70s (155 / 2 / ~1.1)
  { key: 'bench',  label: 'Bench',      eq: 'Bch', ex: 'db-bench-press', goal: 70,  goalText: 'bar 155 ×5', curFmt: (w) => `DB ${w}s` },
  { key: 'dl',     label: 'Deadlift',   eq: 'DL',  locked: true,         goalText: '310 ×5 · later phase' },
  // chins current reads live from working-reps once logged; the static
  // cur/pct is the 7/9 calibration fallback until then
  { key: 'mu',     label: 'Muscle-up',  eq: 'MU',  repsEx: 'chin-up-strict', repsGoal: 12,
    curFmt: (r) => `chins ${r}`, cur: 'chins 5', pct: 42, goalText: '12 strict',
    pips: ['12 chins', '+40 chin', 'dips ×10', 'ring MU'], pipNow: 0 },
  { key: 'row',    label: 'Row',        eq: 'Row', ex: 'one-arm-db-row', goal: 75,  goalText: '75 ×8', repsAlong: true },
  // nordic reads live from the Day A ladder once a rung is tapped; the
  // static cur/pct is the calibration fallback until then
  { key: 'nordic', label: 'Nordic',     eq: 'Nrd', rungEx: 'nordic-ladder', cur: 'negs begun', pct: 25, goalText: '5 · R=L' },
  { key: 'carry',  label: 'Carry',      eq: 'Cry', ex: 'suitcase-carry', goal: 80,  goalText: '80 lb' },
];

// The ladder itself lives in the program (editable in-app); the board reads it.
function rungLadderFor(exerciseId) {
  for (const day of state.program.days) {
    for (const s of day.slots) {
      if (slug(s.name) === exerciseId && Array.isArray(s.rungs)) return s.rungs;
    }
  }
  return [];
}

// Latest weight > 0 — a logged 0 is a logging mishap, not a current.
function targetState(item) {
  if (item.locked) return { cur: '', pct: 0 };
  if (item.rungEx) {
    const ladder = rungLadderFor(item.rungEx);
    const i = ladder.indexOf(lastRungFor(item.rungEx));
    if (i !== -1) {
      return {
        cur: ladder[i],
        pct: Math.round(((i + 1) / ladder.length) * 100),
        pips: ladder, pipNow: i,
      };
    }
    return { cur: item.cur, pct: item.pct };
  }
  if (item.repsEx) {
    const r = lastRepsFor(item.repsEx);
    if (r > 0) {
      return {
        cur: item.curFmt ? item.curFmt(r) : String(r),
        pct: Math.max(0, Math.min(100, Math.round((r / item.repsGoal) * 100))),
      };
    }
    return { cur: item.cur, pct: item.pct };
  }
  if (item.ex) {
    for (let i = state.sessions.length - 1; i >= 0; i--) {
      const e = (state.sessions[i].entries || []).find((x) => x.exerciseId === item.ex && x.weight > 0);
      if (e) {
        const pct = Math.max(0, Math.min(100, Math.round((e.weight / item.goal) * 100)));
        let cur = item.curFmt ? item.curFmt(e.weight) : String(e.weight);
        if (item.repsAlong) {
          const r = lastRepsFor(item.ex);
          if (r > 0) cur += ' ×' + r;
        }
        return { cur, pct };
      }
    }
    return { cur: 'log a weight', pct: 0 };
  }
  return { cur: item.cur, pct: item.pct };
}

function recalTs() {
  const parts = (state.settings.recalDate || '').split('-').map(Number);
  if (parts.length !== 3 || !parts[0]) return null;
  return new Date(parts[0], parts[1] - 1, parts[2]).getTime();
}

function ledgerRowsHTML() {
  return TARGETS.map((item) => {
    const s = targetState(item);
    if (item.locked) {
      return `<div class="litem"><div class="lrow dim">
        <span class="lrow-name">${esc(item.label)}</span>
        <span class="lrow-num">/ ${esc(item.goalText)}</span></div></div>`;
    }
    const pipList = s.pips || item.pips;
    const pipNow = s.pipNow != null ? s.pipNow : item.pipNow;
    const pips = pipList
      ? `<div class="pips">${pipList.map((p, i) =>
          `<span class="pip ${i === pipNow ? 'now' : ''}">${esc(p)}</span>` +
          (i < pipList.length - 1 ? '<span class="pip-arrow">›</span>' : '')).join('')}</div>`
      : '';
    const bar = pipList ? '' : `<div class="lbar"><i style="width:${s.pct}%"></i></div>`;
    return `<div class="litem"><div class="lrow">
      <span class="lrow-name">${esc(item.label)}</span>
      <span class="lrow-num"><b>${esc(String(s.cur))}</b> / ${esc(item.goalText)}</span></div>${bar}${pips}</div>`;
  }).join('');
}

function ledgerHTML() {
  const open = !!state.settings.targetsOpen;
  const ts = recalTs();
  const due = ts != null && Date.now() >= ts;
  const check = due
    ? `<a class="ledger-check due" href="#/settings">Export → recalibrate</a>`
    : `<a class="ledger-check" href="#/settings">Export → recal ${ts != null ? esc(fmtDate(ts)) : '—'}</a>`;
  const body = open
    ? `<div class="ledger-rows">${ledgerRowsHTML()}</div>`
    : `<div class="eq">${TARGETS.map((item) => {
        const s = targetState(item);
        return `<div class="eq-col ${item.locked ? 'off' : ''}"><i class="eq-fill" style="height:${s.pct}%"></i></div>`;
      }).join('')}</div>
      <div class="eq-labels">${TARGETS.map((i) => `<span>${esc(i.eq)}</span>`).join('')}</div>`;
  return `
    <div class="ledger">
      <div class="ledger-head">
        <button class="ledger-title" data-action="targets-toggle" aria-expanded="${open}">Targets<span class="caret ${open ? 'up' : ''}">${icon('down', 2.4)}</span></button>
        ${check}
      </div>
      ${body}
    </div>`;
}

/* ==================== progression (motion ledger) ====================
   The board answers "where am I" — this page answers "what's moving".
   One taxonomy, computed from the log alone: ready = last logged reps at
   the top of the slot's rep range (a load goes up next session); holding
   = HOLDING_AFTER sessions of that exercise without a weight, rep, or
   rung change; everything else is climbing. Arcs (rung slots) sort in
   with the lifts — the grouping is the reading. */

const HOLDING_AFTER = 3;
const LOAD_STEP = 5;               // mirrors the chip's ±5 steppers
const WEEK_MS = 7 * 24 * 3600 * 1000;

let progOpen = null;               // one open row; ephemeral like the rest hint

function sessionTs(sess) { return sess.endedAt || sess.startedAt || 0; }

// Top of the slot's rep range, parsed from its target ("3×6–8" → 8).
// Only reps-tracked slots have the rep dial; null = no range to top out.
function repRangeTop(slot) {
  if (!slot.reps) return null;
  const m = /(\d+)\s*[–—-]\s*(\d+)/.exec(slot.target || '');
  return m ? parseInt(m[2], 10) : null;
}

// Every appearance of an exercise in the log, oldest first.
function historyFor(exerciseId) {
  const out = [];
  for (const sess of state.sessions) {
    const e = (sess.entries || []).find((x) => x.exerciseId === exerciseId);
    if (!e) continue;
    out.push({
      t: sessionTs(sess),
      w: Number.isFinite(e.weight) ? e.weight : null,
      r: e.reps > 0 ? e.reps : null,
      rung: e.rung || null,
    });
  }
  return out;
}

// Step-after sparkline as a markup string, like every other view fragment.
// A working number holds until the session it changes — the plateau IS the
// double-progression stair; a smooth slope would be a lie.
function sparkSVG(ptsIn, o) {
  const pts = ptsIn.length === 1 ? [ptsIn[0], ptsIn[0]] : ptsIn;
  const padX = 4, padT = 5, padB = 4;
  let min = Math.min(...pts), max = Math.max(...pts);
  if (o.goal != null) max = Math.max(max, o.goal);
  const span = max - min || 1;
  const X = (i) => padX + i * (o.w - 2 * padX) / Math.max(1, pts.length - 1);
  const Y = (v) => o.h - padB - (v - min) * (o.h - padT - padB) / span;
  let d = `M ${X(0).toFixed(1)} ${Y(pts[0]).toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) d += ` H ${X(i).toFixed(1)} V ${Y(pts[i]).toFixed(1)}`;
  let inner = '';
  if (o.goal != null) {
    inner += `<line x1="${padX}" y1="${Y(o.goal).toFixed(1)}" x2="${o.w - padX - 26}" y2="${Y(o.goal).toFixed(1)}"
      stroke="var(--dim)" stroke-width="1.3" stroke-dasharray="3 4" opacity="0.6"/>
      <text x="${o.w - padX}" y="${(Y(o.goal) + 3.5).toFixed(1)}" text-anchor="end" fill="var(--dim)"
      font-size="10.5" font-family="var(--display)">${o.goal}</text>`;
  }
  inner += `<path d="${d}" fill="none" stroke="currentColor" stroke-width="${o.stroke}"
      stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${X(pts.length - 1).toFixed(1)}" cy="${Y(pts[pts.length - 1]).toFixed(1)}" r="${o.dot}" fill="currentColor"/>`;
  const size = o.cls === 'minispark' ? ` width="${o.w}" height="${o.h}"` : '';
  return `<svg class="${o.cls}" viewBox="0 0 ${o.w} ${o.h}"${size} aria-hidden="true">${inner}</svg>`;
}

function liftItem(slot, ex, all) {
  // A logged 0 is a mishap except on added-load slots, where +0 is bodyweight.
  const wOk = (h) => h.w != null && (h.w > 0 || slot.added);
  const hist = all.filter((h) => wOk(h) || (slot.reps && h.r != null));
  if (!hist.length) return null;
  const wHist = hist.filter(wOk);
  const rHist = hist.filter((h) => h.r != null);
  const cur = wHist.length ? wHist[wHist.length - 1].w : null;
  const first = wHist.length ? wHist[0].w : null;
  const curR = rHist.length ? rHist[rHist.length - 1].r : null;
  const firstR = rHist.length ? rHist[0].r : null;
  const top = repRangeTop(slot);
  const ready = top != null && curR != null && curR >= top;

  // Change streak: trailing sessions with the same working numbers.
  const key = (h) => `${wOk(h) ? h.w : ''}|${slot.reps ? (h.r == null ? '' : h.r) : ''}`;
  let streak = 1;
  for (let i = hist.length - 2; i >= 0 && key(hist[i]) === key(hist[hist.length - 1]); i--) streak++;
  const lastBumpT = streak < hist.length ? hist[hist.length - streak].t : hist[0].t;

  // Spark: weights when they've moved; else reps (the chin-up case).
  const wPts = wHist.map((h) => h.w);
  const rPts = rHist.map((h) => h.r);
  const wMoved = wPts.length >= 2 && Math.min(...wPts) !== Math.max(...wPts);
  const rMoved = rPts.length >= 2 && Math.min(...rPts) !== Math.max(...rPts);
  const mode = (!wMoved && rMoved) || !wPts.length ? 'r' : 'w';
  const pts = mode === 'r' ? rPts : wPts;

  const tgt = TARGETS.find((x) => x.ex === ex);
  const goal = tgt && mode === 'w' ? tgt.goal : null;
  const delta = cur != null && first != null ? cur - first : 0;
  const weeks = Math.max(1, Math.round((hist[hist.length - 1].t - hist[0].t) / WEEK_MS));
  const label = cur == null ? '' : (slot.added ? '+' : '') + cur;
  const next = (cur == null ? 0 : cur) + LOAD_STEP;
  const nextLabel = (slot.added ? '+' : '') + next;

  let bumps = 0;
  for (let i = 1; i < wHist.length; i++) if (wHist[i].w !== wHist[i - 1].w) bumps++;

  const motion = ready ? 'ready'
    : hist.length >= HOLDING_AFTER && streak >= HOLDING_AFTER ? 'holding' : 'climbing';

  // Collapsed phrase: a journey with a window, never a bare position.
  const reps = curR == null ? '' : ` ×${curR}`;
  let phrase;
  if (motion === 'ready') phrase = (label ? `<b>${label}</b>` : '') + reps.replace(' ', label ? ' ' : '');
  else if (motion === 'holding') phrase = `<b>${label || '×' + curR}</b>${label ? reps : ''} · ${streak} sessions`;
  else if (mode === 'w' && delta !== 0) phrase = `${first} → <b>${label}</b> · ${slot.reps && curR != null ? '×' + curR : weeks + ' wks'}`;
  else if (mode === 'r' && rMoved) phrase = `×${firstR} → <b>×${curR}</b> · ${weeks} wks`;
  else phrase = `<b>${label || '×' + curR}</b>${label ? reps : ''}`;

  return {
    kind: 'lift', ex, slot, motion, phrase, pts, goal, streak, lastBumpT,
    mode, cur, curR, first, firstR, top, delta, weeks, label, nextLabel, bumps,
    histLen: hist.length, tFirst: hist[0].t, tLast: hist[hist.length - 1].t,
  };
}

function arcItem(slot, ex, hist) {
  const ladder = slot.rungs;
  const curRung = hist[hist.length - 1].rung;
  const idx = ladder.indexOf(curRung);
  let streak = 1;
  for (let i = hist.length - 2; i >= 0 && hist[i].rung === curRung; i--) streak++;
  const lastBumpT = streak < hist.length ? hist[hist.length - streak].t : hist[0].t;
  const motion = hist.length >= HOLDING_AFTER && streak >= HOLDING_AFTER ? 'holding' : 'climbing';
  const pts = hist.map((h) => ladder.indexOf(h.rung)).filter((i) => i !== -1).map((i) => i + 1);

  // Last different rung before the current one, for the journey phrase.
  let prevIdx = -1;
  for (let i = hist.length - 1 - streak; i >= 0 && prevIdx === -1; i--) prevIdx = ladder.indexOf(hist[i].rung);

  let phrase;
  if (idx === -1) phrase = `<b>${esc(curRung)}</b>`;   // rung renamed since logging
  else if (motion === 'holding') phrase = `rung <b>${idx + 1}</b> / ${ladder.length} · ${streak} sessions`;
  else if (prevIdx !== -1 && prevIdx !== idx) phrase = `rung ${prevIdx + 1} → <b>${idx + 1}</b> / ${ladder.length}`;
  else phrase = `rung <b>${idx + 1}</b> / ${ladder.length}`;

  return { kind: 'arc', ex, slot, motion, phrase, pts, streak, lastBumpT, idx, ladder, hist, goal: null };
}

function progressionData() {
  const items = [];
  const seen = {};
  for (const day of state.program.days) {
    for (const slot of day.slots) {
      const ex = slug(slot.name);
      if (seen[ex]) continue;
      seen[ex] = true;
      if (Array.isArray(slot.rungs) && slot.rungs.length) {
        const hist = historyFor(ex).filter((h) => h.rung);
        if (hist.length) items.push(arcItem(slot, ex, hist));
      } else if (slot.track) {
        const it = liftItem(slot, ex, historyFor(ex));
        if (it) items.push(it);
      }
    }
  }
  return items;
}

function trainStats() {
  const n = state.sessions.length;
  if (!n) return { line: 'No sessions yet', perTxt: '' };
  const t0 = sessionTs(state.sessions[0]);
  const t1 = sessionTs(state.sessions[n - 1]);
  const span = `${fmtDate(t0)} → ${fmtDate(t1)}`;
  if (n < 4) return { line: `${span} · ${n} session${n === 1 ? '' : 's'}`, perTxt: '' };
  const wks = Math.max(1, (t1 - t0) / WEEK_MS);
  const per = Math.round((n / wks) * 2) / 2;
  const perTxt = per >= 1 ? `about ${per} a week` : 'under 1 a week';
  return { line: `${span} · ${n} sessions · ${perTxt}`, perTxt };
}

/* ============================ session core ============================ */

// A session begins lazily: the first weight tweak or note creates it, and only
// Finish → Save puts it in the log. Opening another day parks this draft
// instead of logging it; it comes back when that day is opened again.
function ensureActive(dayId) {
  if (state.active && state.active.dayId === dayId) return state.active;
  parkActive();
  state.active = takeDraft(dayId) || { dayId, startedAt: Date.now(), lastActivityAt: Date.now(), entries: {} };
  return state.active;
}

function parkActive() {
  if (!state.active) return;
  if (!state.drafts) state.drafts = {};
  state.drafts[state.active.dayId] = state.active;
  state.active = null;
}

function takeDraft(dayId) {
  const d = state.drafts && state.drafts[dayId];
  if (d) delete state.drafts[dayId];
  return d || null;
}

// Opening a day (or its finish screen) with a parked draft makes it the
// open session again, so its weights and rings show as they were left.
function resumeDraft(dayId) {
  if (state.active && state.active.dayId === dayId) return;
  if (!(state.drafts && state.drafts[dayId]) || !findDay(dayId)) return;
  parkActive();
  state.active = takeDraft(dayId);
  save();
}

function activeEntry(dayId, slotId) {
  const a = ensureActive(dayId);
  if (!a.entries[slotId]) a.entries[slotId] = { weight: null, note: '' };
  a.lastActivityAt = Date.now();
  return a.entries[slotId];
}

// Effective weight shown on a slot chip: session adjustment wins, else prefill.
function effectiveWeight(dayId, slot) {
  const a = state.active;
  const e = a && a.dayId === dayId ? a.entries[slot.id] : null;
  if (e && e.weight != null && e.weight !== '') return e.weight;
  if (e && e.weight === '') return '';
  return lastWeightFor(slug(slot.name));
}

// Build and push the session record for a day's active entries, then clear
// the active session. Navigation, rest, save, and toasts stay with callers.
function recordSession(dayId, note) {
  const day = findDay(dayId);
  if (!day) { state.active = null; return; }
  const a = state.active && state.active.dayId === dayId ? state.active : null;
  const entries = [];
  for (const slot of day.slots) {
    const e = a ? a.entries[slot.id] : null;
    const slotNote = e && e.note ? e.note.trim() : '';
    const rung = slot.rungs ? effectiveRung(dayId, slot) : '';
    // Counted sets ride along on the record (still no per-set numbers).
    const sets = e && e.sets ? Math.min(e.sets, setTarget(slot) || e.sets) : 0;
    if (slot.track) {
      const w = effectiveWeight(dayId, slot);
      const entry = { exerciseId: slug(slot.name), name: slot.name, weight: w === '' ? '' : parseFloat(w), note: slotNote };
      if (slot.reps) {
        const r = effectiveReps(dayId, slot);
        entry.reps = r === '' ? '' : parseInt(r, 10);
      }
      if (rung) entry.rung = rung;
      if (sets) entry.sets = sets;
      const ir = effectiveRir(dayId, slot);
      if (sets && ir !== '' && ir != null) entry.rir = parseInt(ir, 10);
      if (e && e.log && e.log.length) entry.setLog = e.log;
      entry.status = e && e.done ? 'done' : sets ? 'partial' : 'skipped';
      entries.push(entry);
    } else if (slotNote || rung || sets) {
      const entry = { exerciseId: slug(slot.name), name: slot.name, weight: '', note: slotNote };
      if (rung) entry.rung = rung;
      if (sets) entry.sets = sets;
      entries.push(entry);
    }
  }
  state.sessions.push({
    id: uid(), v: 2,
    dayId: day.id, dayName: `${day.name} — ${day.subtitle}`,
    startedAt: a ? a.startedAt : Date.now(),
    endedAt: Date.now(),
    note: (note || '').trim(),
    entries,
  });
  state.active = null;
}

// Effort: reps in reserve. Today's number wins; the target (2) otherwise.
function effectiveRir(dayId, slot) {
  const a = state.active;
  const e = a && a.dayId === dayId ? a.entries[slot.id] : null;
  if (e && e.rir != null && e.rir !== '') return e.rir;
  if (e && e.rir === '') return '';
  return 2;
}

// The sets already banked today, one quiet line under the steppers.
function setLogHTML(slotId, e) {
  const log = e && e.log ? e.log : [];
  const items = log.map((x, i) => {
    const load = x.w == null ? '' : `${x.w}`;
    const reps = x.r == null ? '—' : x.r;
    const rir = x.rir == null ? '' : `<em>RIR ${x.rir}</em>`;
    return `<span class="sl"><i>${i + 1}</i>${load ? esc(load) + '×' : ''}${esc(String(reps))}${rir}</span>`;
  }).join('');
  return `<div class="setlog ${log.length ? '' : 'hidden'}" data-setlog="${slotId}">${items}</div>`;
}

function effectiveReps(dayId, slot) {
  const a = state.active;
  const e = a && a.dayId === dayId ? a.entries[slot.id] : null;
  if (e && e.reps != null && e.reps !== '') return e.reps;
  if (e && e.reps === '') return '';
  return lastRepsFor(slug(slot.name));
}

// Effective rung mirrors effective weight: today's tap wins, else the last
// logged rung carries. An explicit '' means "cleared today" — show none.
function effectiveRung(dayId, slot) {
  const a = state.active;
  const e = a && a.dayId === dayId ? a.entries[slot.id] : null;
  if (e && e.rung != null && e.rung !== '') return e.rung;
  if (e && e.rung === '') return '';
  return lastRungFor(slug(slot.name));
}

function finishSession(dayId, note) {
  if (!findDay(dayId)) return;
  recordSession(dayId, note);
  restCancel();
  save();
  location.hash = '#/';
  toast('Session saved');
}

// Only Finish → Save logs a session. A draft left idle past 12h was never
// submitted, so it is cleared, never logged on anyone's behalf.
const STALE_AFTER_MS = 12 * 3600 * 1000;
function clearStaleDrafts() {
  const stale = (d) => !!d && Date.now() - (d.lastActivityAt || d.startedAt || 0) > STALE_AFTER_MS;
  let n = 0;
  if (stale(state.active)) { state.active = null; n++; }
  for (const id of Object.keys(state.drafts || {})) {
    if (stale(state.drafts[id])) { delete state.drafts[id]; n++; }
  }
  if (!n) return;
  save();
  render();
  toast(n === 1 ? 'Unfinished session cleared' : 'Unfinished sessions cleared');
}

// Earlier versions logged unfinished sessions automatically (left open 12h,
// or replaced by opening the other day). Those were never submitted, so they
// leave the log for `unsubmitted`: kept in exports, counted nowhere.
function quarantineAutoSessions() {
  const isAuto = (x) => x.auto === true || x.note === '(auto-saved — session left open)';
  const auto = state.sessions.filter(isAuto);
  if (!auto.length) return;
  state.unsubmitted = (state.unsubmitted || []).concat(auto);
  state.sessions = state.sessions.filter((x) => !isAuto(x));
  save();
}

// An installed PWA resumes for days without a fresh boot — run the stale
// check whenever the app comes back, not just at launch.
document.addEventListener('visibilitychange', () => { if (!document.hidden) clearStaleDrafts(); });
window.addEventListener('pageshow', (e) => { if (e.persisted) clearStaleDrafts(); });

/* ====================== rest engine (silent) ======================
   No audio: any media playback takes the iOS audio session and cuts off
   whatever he's listening to for the whole rest (the v2.0–2.4 baked-WAV
   chime is in git history if it's ever wanted back). End of rest =
   vibration where supported + the dock's visual done state. */

const rest = { running: false, endsAt: 0, total: 0, tier: null, done: false, label: null };
let restTick = null;

function buzz() {
  try { if (navigator.vibrate) navigator.vibrate([220, 120, 220, 120, 320]); } catch (e) {}
}

/* ---- screen wake lock (nice-to-have) ---- */
let wakeLock = null;
async function requestWakeLock() {
  try {
    if (!('wakeLock' in navigator)) return;
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (e) { wakeLock = null; }
}
function releaseWakeLock() {
  try { if (wakeLock) { wakeLock.release(); wakeLock = null; } } catch (e) {}
}

/* ---- rest control ---- */

function restStart(tier, label, forSlot) {
  const sec = tier === 'heavy' ? state.settings.restHeavy : normalRestSec(forSlot);
  rest.running = true;
  rest.done = false;
  rest.tier = tier;
  rest.label = label || null;
  rest.total = sec;
  rest.endsAt = Date.now() + sec * 1000;
  requestWakeLock();
  startRestTick();
  renderRestDock();
}

function restCancel() {
  rest.running = false;
  rest.done = false;
  releaseWakeLock();
  stopRestTick();
  renderRestDock();
}

function restFinish() {
  rest.running = false;
  rest.done = true;
  buzz();
  releaseWakeLock();
  stopRestTick();
  renderRestDock();
  setTimeout(() => { if (rest.done && !rest.running) { rest.done = false; renderRestDock(); } }, 4000);
}

function startRestTick() {
  stopRestTick();
  restTick = setInterval(() => {
    if (!rest.running) return;
    const left = (rest.endsAt - Date.now()) / 1000;
    if (left <= 0) { restFinish(); return; }
    updateRestTime(left);
  }, 250);
}
function stopRestTick() { clearInterval(restTick); restTick = null; }

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && rest.running && Date.now() >= rest.endsAt) restFinish();
});

/* ============================== views ============================== */

// The samara — a maple key, Damiano's one ornament. Tall and narrow so it
// hugs an edge. Parts keep the old class names so the launch draw and the
// save-screen grow carry over: stalk (stem), veins (awns), seed (kerns),
// wing (leaf).
const KERNELS = [[38, 104, 8.5, 11.5, -18], [40, 101, 4.2, 6, -18]];
function barleySVG(cls) {
  const kern = KERNELS.map(([cx, cy, rx, ry, r], i) =>
    `<g class="kern" style="--i:${i}"><ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" transform="rotate(${r} ${cx} ${cy})"/></g>`).join('');
  return `
    <svg class="${cls}" viewBox="0 0 90 132" aria-hidden="true">
      <g stroke-linecap="round">
        <path class="leaf" d="M33 98 C 27 70 33 36 51 12 C 57 4 69 3 72 11 C 75 21 66 48 54 72 C 48 84 46 94 45 103 Z" fill="currentColor" opacity="0.28"/>
        <path class="leaf r" d="M33 98 C 27 70 33 36 51 12 C 41 38 36 68 38 97 Z" fill="currentColor" opacity="0.32"/>
        <g class="awns" stroke="currentColor" stroke-width="1.1" opacity="0.5" fill="none">
          <path pathLength="1" d="M39 94 C 40 66 47 38 58 14"/><path pathLength="1" d="M41 95 C 44 70 52 46 64 22"/>
          <path pathLength="1" d="M42 96 C 47 76 55 58 68 32"/><path pathLength="1" d="M43 98 C 48 84 54 72 62 56"/>
          <path pathLength="1" d="M37 93 C 36 70 40 46 50 24"/>
        </g>
        <path class="stem" pathLength="1" d="M33 114 C 31 120 28 125 24 130" fill="none" stroke="currentColor" stroke-width="2"/>
        <g class="kerns" fill="currentColor" opacity="0.5">${kern}</g>
      </g>
    </svg>`;
}
function barleyHTML() { return barleySVG('barley'); }

// A small samara for "done" marks, drawn at icon size.
function earMini() {
  return `<svg class="ear-mini" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M5.6 12.6 C 4.6 8.6 5.6 4.2 8.6 1.6 C 9.8 .7 11.6 .8 11.9 2 C 12.2 3.6 10.6 7.2 8.6 10 C 7.8 11.2 7.4 12.2 7.3 13.2 Z" fill="currentColor" opacity="0.55"/>
    <ellipse cx="6.3" cy="13.3" rx="1.9" ry="2.4" transform="rotate(-18 6.3 13.3)" fill="currentColor"/></svg>`;
}

// One small stroke-icon set (24-grid, round caps) so every glyph in the
// app is drawn the same way instead of borrowed from whatever font is around.
const ICON_PATHS = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  chev: '<path d="M9 5l7 7-7 7"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  again: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v4h4"/>',
  note: '<path d="M14.5 5.5l4 4"/><path d="M4.5 19.5l1-4.5L16 4.5a1.4 1.4 0 0 1 2 0l1.5 1.5a1.4 1.4 0 0 1 0 2L9 18.5z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  dn: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  camera: '<path d="M3.5 8.5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2z"/><path d="M15.5 10.5l5-3v9l-5-3"/>',
  rec: '<circle cx="12" cy="12" r="6.5" fill="currentColor" stroke="none"/>',
};
function icon(name, sw) {
  return `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw || 2}"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`;
}

function topbar(backTo) {
  const left = backTo
    ? `<a class="backlink" href="${backTo}">${icon('back', 2.4)}Back</a>`
    : `<div class="wordmark">Damiano’s <span class="half">Practice</span></div>`;
  const right = backTo ? '' : `<a class="gear" href="#/settings" aria-label="Settings">${icon('gear', 1.8)}</a>`;
  return `<div class="topbar ${backTo ? '' : 'home'}">${left}${right}</div>`;
}

/* ---- home ----
   Up next: one decisive card for the day he's on, the other day as a row,
   the Progression strip (with the targets drawn small), and this week at
   the foot. Opens with the greeting, which first plays as its own brief
   screen at launch and then settles into place. Sized to fit one screen. */

function greetingHTML() {
  const now = new Date();
  const weekday = now.toLocaleDateString(undefined, { weekday: 'long' });
  return `
    <div class="greet">
      <h1 class="greet-hi">${esc(greeting())}, Damiano</h1>
      <div class="greet-date">${esc(weekday)} · ${esc(fmtDate(now.getTime()))}</div>
    </div>`;
}

// The day's letter as a stamped mark ("Day A" → A).
function dayLetter(day) {
  const name = String(day.name || '?').trim();
  const m = /(?:^|\s)([A-Z0-9])$/i.exec(name);   // "Day A" → A; "Upper" → U
  return (m ? m[1] : name.charAt(0)).toUpperCase();
}
function dayMarkHTML(day, cls) {
  return `<span class="daymark ${cls || ''}">${esc(dayLetter(day))}</span>`;
}

// The day he's on: an open session wins; otherwise the day trained least
// recently (never-trained first), so A and B alternate on their own.
function suggestedDay() {
  if (state.active && findDay(state.active.dayId)) return findDay(state.active.dayId);
  let best = null;
  let bestT = Infinity;
  for (const day of state.program.days) {
    const last = lastSessionFor(day.id);
    const t = last ? sessionTs(last) : -Infinity;
    if (t < bestT) { best = day; bestT = t; }
  }
  return best;
}

// A day's usual length from his last few finished sessions, to 5 minutes.
function typicalMinutes(dayId) {
  const mins = realSessions().filter((s) => s.dayId === dayId).slice(-6)
    .map((s) => (s.endedAt - s.startedAt) / 60000).filter((m) => m >= 10 && m <= 180);
  if (!mins.length) return null;
  return Math.round(mins.reduce((a, b) => a + b, 0) / mins.length / 5) * 5;
}

function dayStatusHTML(day) {
  if ((state.active && state.active.dayId === day.id) || (state.drafts && state.drafts[day.id])) return '<span class="daycard-live">In progress</span>';
  const last = lastSessionFor(day.id);
  if (last && startOfDay(sessionTs(last)) === startOfDay(Date.now())) {
    return `<span class="day-done">${earMini()}Done today</span>`;
  }
  return last ? `<span>${esc(cap(relPhrase(sessionTs(last))))}</span>` : '';
}

function viewHome() {
  const next = suggestedDay();
  const st = rhythmStats();
  // The week strip waits for a production-ready design.
  if (!next) return `${topbar()}${greetingHTML()}`;
  const live = !!(state.active && state.active.dayId === next.id);
  const mins = typicalMinutes(next.id);
  const last = lastSessionFor(next.id);
  const meta = [`${next.slots.length} exercises`];
  if (mins) meta.push(`about ${mins} min`);
  if (!live && last) meta.push(`last ${relPhrase(sessionTs(last))}`);
  const others = state.program.days.filter((d) => d.id !== next.id).map((d) => `
    <a class="dayrow" href="#/day/${d.id}">
      ${dayMarkHTML(d)}
      <span class="dr-body"><span class="dr-name">${esc(d.name)}</span><span class="dr-sub">${esc(d.subtitle)}</span></span>
      <span class="dr-when">${dayVideoDotHTML(d)}${dayStatusHTML(d)}</span>${icon('chev', 2.2)}
    </a>`).join('');
  return `
    ${topbar()}
    ${greetingHTML()}
    <a class="upnext" href="#/day/${next.id}">
      <span class="upnext-top">${dayMarkHTML(next, 'lg')}
        <span class="upnext-k ${live ? 'live' : ''}">${live ? 'In progress' : 'Up next'}</span></span>
      <span class="upnext-name">${esc(next.name)}</span>
      <span class="upnext-sub">${esc(next.subtitle)}</span>
      <span class="upnext-meta">${esc(meta.join(' · '))}</span>
      ${dayVideoTagHTML(next)}
      <span class="upnext-go">${live ? 'Pick up where you left off' : `Start ${esc(next.name)}`}${icon('chev', 2.4)}</span>
    </a>
    ${others ? `<div class="group dayrows">${others}</div>` : ''}`;
}

/* ---- this week ---- */

// Monday-first weeks: sessions per week and the two-a-week run.
function rhythmStats() {
  const real = state.sessions;
  if (!real.length) return null;
  const firstW = weekStart(sessionTs(real[0]));
  const nowW = weekStart(Date.now());
  const weeks = [];
  const d = new Date(nowW);
  while (weeks.length < 12 && d.getTime() >= firstW) {
    const ws = d.getTime();
    weeks.unshift({ start: ws, count: real.filter((s) => weekStart(sessionTs(s)) === ws).length });
    d.setDate(d.getDate() - 7);
  }
  let streak = 0;
  for (let i = weeks.length - 1; i >= 0; i--) {
    if (weeks[i].start === nowW) { if (weeks[i].count >= 2) streak++; continue; }
    if (weeks[i].count >= 2) streak++; else break;
  }
  const thisWeek = weeks.length && weeks[weeks.length - 1].start === nowW ? weeks[weeks.length - 1].count : 0;
  return { streak, thisWeek };
}

function weekLine(st) {
  if (!st) return 'A, B and C each week';
  const run = st.streak >= 2 ? ` · ${st.streak} weeks running` : '';
  if (st.thisWeek >= 3) return `${st.thisWeek === 3 ? 'All three' : st.thisWeek} this week${run}`;
  return `${st.thisWeek} of 3 this week${run}`;
}

function weekDays() {
  const ws = weekStart(Date.now());
  const today = startOfDay(Date.now());
  const real = state.sessions;
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(ws);
    d.setDate(d.getDate() + i);
    const t = startOfDay(d.getTime());
    out.push({
      num: d.getDate(),
      letter: d.toLocaleDateString(undefined, { weekday: 'narrow' }),
      days: real.filter((s) => startOfDay(sessionTs(s)) === t).map((s) => findDay(s.dayId)).filter(Boolean),
      today: t === today, future: t > today,
    });
  }
  return out;
}

// This week as seven days, each trained day stamped with that day's letter.
function weekStripHTML(st) {
  const days = weekDays().map((d) => {
    const mark = d.days.length
      ? `<span class="wk-mark">${esc(dayLetter(d.days[d.days.length - 1]))}</span>`
      : '<span class="wk-mark empty"></span>';
    return `<div class="wk-day ${d.today ? 'today' : ''} ${d.future ? 'future' : ''}">
      <span class="wk-l">${esc(d.letter)}</span><span class="wk-n">${d.num}</span>${mark}</div>`;
  }).join('');
  return `
    <div class="weekcard">
      <div class="wk-row">${days}</div>
      <div class="wk-line">${esc(weekLine(st))}</div>
    </div>`;
}

/* ---- greeting splash ----
   At launch the greeting gets the whole screen for a moment: the barley
   draws itself, the words rise, then they glide up into the home greeting
   and the page settles in under them. Tap to skip. Once per launch, from
   home only, never under reduced motion. */

let splashTimer = null;
function showSplash() {
  if (reducedMotion()) return;
  const target = $('.greet-hi');
  if (!target) return;
  const old = $('.splash');
  if (old) old.remove();
  const now = new Date();
  const weekday = now.toLocaleDateString(undefined, { weekday: 'long' });
  const el = document.createElement('div');
  el.className = 'splash';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `
    <div class="splash-inner">
      ${barleySVG('barley grow')}
      <div class="splash-hi">${esc(greeting())}, Damiano</div>
      <div class="splash-date">${esc(weekday)} · ${esc(fmtDate(now.getTime()))}</div>
    </div>`;
  document.body.appendChild(el);
  document.body.classList.add('splashing');
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    clearTimeout(splashTimer);
    const words = el.querySelector('.splash-hi');
    const to = $('.greet-hi');
    // A tap mid-rise would measure the words part-way up; finish the rise first.
    words.style.animation = 'none';
    words.style.opacity = '1';
    if (to) {
      const a = words.getBoundingClientRect();
      const b = to.getBoundingClientRect();
      words.style.transform = `translate(${(b.left - a.left).toFixed(1)}px, ${(b.top - a.top).toFixed(1)}px)`;
    }
    el.classList.add('settling');
    document.body.classList.remove('splashing');
    document.body.classList.add('settle-in');
    setTimeout(() => {
      el.remove();
      document.body.classList.remove('settle-in');
    }, 760);
  };
  el.addEventListener('click', settle);
  // Leaving home mid-splash (a tap can't, but a resume link could) settles too.
  window.addEventListener('hashchange', settle, { once: true });
  splashTimer = setTimeout(settle, 2100);
}

/* ---- progression: home entry row + the page ---- */

// The way into Progression: a tinted strip, not another card like the
// days. One headline (what's ready, else the biggest gain), the recal
// check under it, and the targets board drawn small on the right.
function progRowHTML() {
  const items = progressionData();
  const readyCt = items.filter((i) => i.motion === 'ready').length;
  let best = null;
  for (const it of items) {
    if (it.kind === 'lift' && it.mode === 'w' && it.delta > 0 && (!best || it.delta > best.delta)) best = it;
  }
  let main;
  if (readyCt) main = `${readyCt} lift${readyCt === 1 ? '' : 's'} ready to move up`;
  else if (best) main = `${best.slot.name.split(',')[0]} +${best.delta} ${state.settings.unit}`;
  else main = 'Fills in as sessions land';
  const ts = recalTs();
  const due = ts != null && Date.now() >= ts;
  const sub = ts == null ? '' : due ? 'Recalibration due — export first' : `Targets · recal ${fmtDate(ts)}`;
  const eq = TARGETS.map((item) => {
    const s = targetState(item);
    return `<span class="mini-col ${item.locked ? 'off' : ''}"><i style="height:${s.pct}%"></i></span>`;
  }).join('');
  return `
    <a class="prow" href="#/progression">
      <span class="prow-body">
        <span class="prow-k">Progression${icon('chev', 2.6)}</span>
        <span class="prow-main">${esc(main)}</span>
        ${sub ? `<span class="prow-s ${due ? 'due' : ''}">${esc(sub)}</span>` : ''}
      </span>
      <span class="mini-eq" aria-hidden="true">${eq}</span>
    </a>`;
}

// The open card's closing line — every open row ends in a verdict:
// the load, the pace, or a reset. Suggestions stay hairline, never brass.
function liftVerdictHTML(it) {
  if (it.motion === 'ready') {
    return `<div class="tnext ready">At ×${it.curR} — load ${esc(it.nextLabel)} next session</div>`;
  }
  if (it.motion === 'holding') {
    const reset = it.top != null && it.cur != null && it.cur - LOAD_STEP > 0
      ? `reset ${it.cur - LOAD_STEP} ×${it.top}, or hold` : 'nudge it, or hold';
    return `<div class="tnext flag">Flat ${it.streak} sessions — ${reset}</div>`;
  }
  if (it.mode === 'r') {
    const trigger = it.top != null ? ` · ×${it.top} triggers the load` : '';
    return `<div class="tnext">Building reps ×${it.firstR} → ×${it.curR}${trigger}</div>`;
  }
  if (it.delta > 0) {
    const cad = it.bumps ? Math.max(1, Math.round(it.histLen / it.bumps)) : 0;
    let line = `+${it.delta} in ${it.weeks} wks`;
    if (cad) line += cad === 1 ? ', bumps most sessions' : `, bumps every ~${cad} sessions`;
    if (it.goal != null && it.cur < it.goal) {
      // Straight-line guess in dim ink; recalibration corrects it.
      const rate = it.delta / Math.max(1, it.tLast - it.tFirst);
      const msLeft = (it.goal - it.cur) / rate;
      if (msLeft > 0 && msLeft < 400 * 24 * 3600 * 1000) {
        line += ` · at this pace ${it.goal} lands ~${new Date(it.tLast + msLeft).toLocaleDateString(undefined, { month: 'short' })}`;
      }
    } else if (it.goal != null && it.cur >= it.goal) {
      line += ` · goal ${it.goal} met`;
    }
    return `<div class="tnext">${line}</div>`;
  }
  return `<div class="tnext">Early days — ${it.histLen} session${it.histLen === 1 ? '' : 's'} logged</div>`;
}

function liftCardHTML(it) {
  const spark = it.pts.length
    ? sparkSVG(it.pts, { w: 330, h: 46, stroke: 2.5, dot: 4, goal: it.goal, cls: 'tspark' }) : '';
  const scheme = (it.slot.target || '').split('·')[0].trim();
  let tline;
  if (it.mode === 'w' && it.first !== it.cur) tline = `${it.first} → <b>${esc(it.label)} ${esc(state.settings.unit)}</b>`;
  else if (it.mode === 'r' && it.firstR !== it.curR) tline = `×${it.firstR} → <b>×${it.curR}</b>`;
  else tline = `<b>${it.label ? esc(it.label) + ' ' + esc(state.settings.unit) : '×' + it.curR}</b>`;
  if (scheme) tline += ` · ${esc(scheme)}`;
  if (it.goal != null) tline += ` · goal ${it.goal}`;
  return `<div class="tcard">${spark}<div class="tline">${tline}</div>${liftVerdictHTML(it)}</div>`;
}

// Expanded arc: the slot's rungs as a vertical rail, read top-down —
// the last rung is the gate, dates mark the rungs already earned.
function arcCardHTML(it) {
  const { ladder, idx, hist } = it;
  const firstAt = (name) => {
    for (const h of hist) if (h.rung === name) return h.t;
    return null;
  };
  const rows = [];
  for (let i = ladder.length - 1; i >= 0; i--) {
    const line = i === 0 ? '' : '<div class="lad-line"></div>';
    let cls = '', dot = '', meta = '';
    if (idx === -1 || i > idx) {
      cls = 'future';
      dot = i === ladder.length - 1 ? ' goal' : ' next';
      if (i === ladder.length - 1) meta = '<span class="lad-meta">goal</span>';
    } else if (i === idx) {
      dot = ' now';
      meta = `<span class="lad-meta live">now · since ${esc(fmtDate(it.lastBumpT))}</span>`;
    } else {
      const t = firstAt(ladder[i]);
      if (t) meta = `<span class="lad-meta">${esc(fmtDate(t))}</span>`;
    }
    rows.push(`
      <div class="lad-row ${cls}">
        <div class="lad-rail"><div class="lad-dot${dot}"></div>${line}</div>
        <div class="lad-body"><span class="lad-name">${esc(ladder[i])}</span>${meta}</div>
      </div>`);
  }
  const cap = it.motion === 'holding'
    ? `${it.streak} sessions on this rung. Rungs are program data — Settings → Program.`
    : 'Rungs are program data — rename, insert, reorder in Settings → Program.';
  return `<div class="lad">${rows.join('')}<div class="lad-cap">${cap}</div></div>`;
}

function progRowItemHTML(it) {
  const open = progOpen === it.ex;
  const spark = it.motion === 'ready' || !it.pts.length ? ''
    : sparkSVG(it.pts, { w: 64, h: 20, stroke: 1.8, dot: 2.5, cls: 'minispark' });
  const pill = it.motion === 'ready' ? `<span class="vpill">→ ${esc(it.nextLabel)}</span>` : '';
  const card = open ? (it.kind === 'arc' ? arcCardHTML(it) : liftCardHTML(it)) : '';
  return `
    <button class="mrow ${open ? 'open' : ''}" data-action="prog-toggle" data-key="${esc(it.ex)}">
      <span class="mname">${esc(it.slot.name)}</span>${spark}
      <span class="mnum">${it.phrase}</span>${pill}<span class="mchev">${icon('chev', 2.4)}</span>
    </button>${card}`;
}

function viewProgression() {
  const items = progressionData();
  const ready = items.filter((i) => i.motion === 'ready');
  const climbing = items.filter((i) => i.motion === 'climbing').sort((a, b) => b.lastBumpT - a.lastBumpT);
  const holding = items.filter((i) => i.motion === 'holding').sort((a, b) => b.streak - a.streak);
  const section = (word, why, list) => (list.length ? `
    <div class="peyebrow"><span class="peyebrow-word">${word}</span><span class="peyebrow-why">${why}</span></div>
    <div class="mlist">${list.map(progRowItemHTML).join('')}</div>` : '');
  const empty = items.length ? ''
    : '<p class="finish-hint">The page fills in as sessions land — log a session and come back.</p>';
  // Targets answer "where am I" at the top; the motion sections below
  // answer "what's moving".
  return `
    ${topbar('#/')}
    <div class="dayhead-name">Progression</div>
    <div class="dayhead-sub">${esc(trainStats().line)}</div>
    ${ledgerHTML()}
    ${empty}
    ${section('Next session', 'at the top of their range', ready)}
    ${section('Climbing', 'last bump first', climbing)}
    ${section('Holding', HOLDING_AFTER + '+ sessions without a change', holding)}
    <div class="fieldmark">${barleyHTML()}</div>`;
}

// Chip face, rebuilt from effective values on every change — a fresh slot
// invites ("add weight") instead of showing the broken-looking "— lb ×—".
function chipInnerHTML(dayId, slot) {
  const w = effectiveWeight(dayId, slot);
  const r = slot.reps ? effectiveReps(dayId, slot) : null;
  const reps = r === '' || r == null ? '' : `<span class="chip-reps">×${esc(String(r))}</span>`;
  if (slot.bw) return reps ? `<span class="chip-num">${esc(String(r))}</span><span class="chip-unit">reps</span>` : '<span class="chip-add">Reps</span>';
  if ((w === '' || w == null || w === 0) && slot.added) return `<span class="chip-num">BW</span>${reps || '<span class="chip-reps">×—</span>'}`;
  if (w === '' || w == null) return `<span class="chip-add">Add</span>${reps}`;
  const label = (slot.added ? '+' : '') + w;
  return `<span class="chip-num">${esc(String(label))}</span><span class="chip-unit">${esc(state.settings.unit)}</span>${slot.reps ? (reps || '<span class="chip-reps">×—</span>') : ''}`;
}

function refreshChip(dayId, slot) {
  const btn = $(`[data-slotcard="${slot.id}"] .chip`);
  if (btn) btn.innerHTML = valInnerHTML(dayId, slot);
}

// The trail: one pip per slot, filled as rings are tapped — where the
// session is at a glance. Rings are optional; an untouched trail stays quiet.
function trailHTML(day) {
  const a = state.active && state.active.dayId === day.id ? state.active : null;
  let done = 0;
  const pips = day.slots.map((s) => {
    const on = !!(a && a.entries[s.id] && a.entries[s.id].done);
    if (on) done++;
    return `<span class="trail-pip ${on ? 'on' : ''}"></span>`;
  }).join('');
  const all = done > 0 && done === day.slots.length;
  return `<div class="trail ${all ? 'all' : ''}" data-trail><div class="trail-bar">${pips}</div><span class="trail-count">${done} of ${day.slots.length}</span></div>`;
}

// The last ring of the session sends a ripple down the trail and turns
// Finish solid; unchecking one quietly undoes both.
function updateTrail(dayId) {
  const el = $('[data-trail]');
  const day = findDay(dayId);
  if (!el || !day) return;
  const wasAll = el.classList.contains('all');
  el.outerHTML = trailHTML(day);
  const now = $('[data-trail]');
  const all = now.classList.contains('all');
  if (all && !wasAll) now.classList.add('ripple');
  const fin = $('.finishbtn[data-action="finish"]');
  if (fin) {
    fin.classList.toggle('ready', all);
    fin.classList.toggle('just', all && !wasAll);
  }
}

/* ---- pairs ---- */

// Slots sharing a pair key are done together, alternating sets — the
// normal rest between moves is the point, and the UI says who's paired.
function pairPartners(day, slot) {
  if (!day || !slot || !slot.pair) return [];
  return day.slots.filter((s) => s.pair === slot.pair && s.id !== slot.id);
}

function shortName(slot) {
  return slot.short || String(slot.name).split(/[(—,/]/)[0].trim();
}

function pairNames(day, slot) {
  return pairPartners(day, slot).map(shortName).join(' + ');
}

// A group can carry its own rest (pairRest, seconds). While he's inside
// such a group the normal tier takes that time — dock and mat agree.
function pairRestSec(day, slot) {
  if (day && slot && slot.pair) {
    const g = day.slots.find((s) => s.pair === slot.pair && s.pairRest > 0);
    if (g) return g.pairRest;
  }
  if (slot && slot.restSec > 0) return slot.restSec;
  return state.settings.restNormal;
}

// forSlot: the exercise whose set just banked (counting ring) — its group's
// rest wins even when he works out of order. Dock taps pass nothing and
// anchor on the touched slot, same as the dock's tier hint.
function normalRestSec(forSlot) {
  const day = findDay(currentDayId());
  const slot = forSlot || (day && currentSlotId ? findSlot(day, currentSlotId) : null);
  return pairRestSec(day, slot);
}

/* ---- counting ring ---- */

// Sets-per-exercise reads straight off the target string — "4×5" → 4, and
// "2–3 easy sets" → 3 (a range counts to its top; the ring may sit under-
// filled on an easy day — the count is a nudge, not a ledger). No match
// (prep, jumps, the ladders' ranged "N–M×") → the plain one-tap ring.
function setTarget(slot) {
  const t = String(slot.target || '').trim();
  const m = /^(\d+)\s*[×x]/.exec(t) || /^(?:\d+\s*[–-]\s*)?(\d+)\s+(?:\w+\s+)?sets?\b/.exec(t);
  const n = m ? parseInt(m[1], 10) : 0;
  return n >= 2 && n <= 12 ? n : 0;
}

const NUMWORD = ['zero', 'one', 'two', 'three', 'four', 'five', 'six',
  'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

// The rest label coaches the count, tersely. The last set's rest is just
// rest — the checked card already says what happened.
function restLabelFor(n, total) {
  return `Set ${n} of ${total}`;
}

const RING_CIRC = 2 * Math.PI * 12;

function ringHTML(slot, e) {
  const done = !!(e && e.done);
  const total = setTarget(slot);
  if (!total) {
    return `<button class="ring ${done ? 'on' : ''}" data-action="ring" data-slot="${slot.id}"
      aria-label="${done ? 'Done — tap to reopen' : 'Mark done'}"></button>`;
  }
  const n = done ? total : Math.min((e && e.sets) || 0, total - 1);
  const off = RING_CIRC * (1 - n / total);
  return `
    <button class="ring counting ${done ? 'on' : ''}" data-action="ring" data-slot="${slot.id}"
      aria-label="${done ? 'Reset sets' : 'Count one set'}">
      <svg viewBox="0 0 28 28" aria-hidden="true">
        <circle class="ring-track" cx="14" cy="14" r="12"></circle>
        <circle class="ring-arc" cx="14" cy="14" r="12"
          style="stroke-dasharray:${RING_CIRC.toFixed(2)};stroke-dashoffset:${off.toFixed(2)}"></circle>
      </svg>
      <span class="ring-count">${done ? icon('check', 3.2) : (n || '')}</span>
    </button>`;
}

// One line per exercise: ring · name over target · today's number. Tapping
// the row opens a drawer with everything adjustable (steppers, ladder,
// options, note), so the list keeps one quiet rhythm the whole way down.
function slotCardHTML(day, slot, onMat) {
  const a = state.active && state.active.dayId === day.id ? state.active.entries[slot.id] : null;
  const note = a && a.note ? a.note : '';
  const done = !!(a && a.done);
  // On a mat the tag above already says who's paired; the per-card note
  // is only for pair members that sit apart in the list.
  const partners = onMat ? [] : pairPartners(day, slot);
  const pairNote = partners.length
    ? `<div class="pair-note">Pair with ${esc(pairNames(day, slot))} — ${partners.length > 1 ? 'cycle through' : 'alternate sets'}</div>`
    : '';
  const hasMenu = slot.menu && slot.menu.length;
  const menu = hasMenu
    ? `<ul class="menu">${slot.menu.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : '';
  const hasRungs = Array.isArray(slot.rungs) && slot.rungs.length;
  const effRung = hasRungs ? effectiveRung(day.id, slot) : '';
  const rungs = hasRungs
    ? `<div class="rungs">${slot.rungs.map((rn) =>
        `<button class="rung ${rn === effRung ? 'now' : ''}" data-action="rung" data-slot="${slot.id}" data-rung="${esc(rn)}">${esc(rn)}</button>`).join('')}</div>` : '';
  const warmup = slot.warmup
    ? `<div class="warmup"><span class="warmup-tag">Warm-up</span> ${esc(slot.warmup)}</div>` : '';
  let steppers = '';
  if (slot.track) {
    const w = effectiveWeight(day.id, slot);
    const r = slot.reps ? effectiveReps(day.id, slot) : null;
    const weightRow = `
        <button class="step" data-action="step" data-slot="${slot.id}" data-d="-5">−5</button>
        <input class="chip-input" type="number" inputmode="decimal" step="any"
               data-action="weight" data-slot="${slot.id}" value="${w === '' || w == null ? '' : esc(String(w))}">
        <button class="step" data-action="step" data-slot="${slot.id}" data-d="5">+5</button>`;
    const ir = effectiveRir(day.id, slot);
    const rirRow = `<div class="edit-row"><span class="edit-tag">RIR</span>
          <button class="step" data-action="irstep" data-slot="${slot.id}" data-d="-1">−1</button>
          <input class="chip-input" type="number" inputmode="numeric"
                 data-action="rir" data-slot="${slot.id}" value="${ir === '' || ir == null ? '' : esc(String(ir))}">
          <button class="step" data-action="irstep" data-slot="${slot.id}" data-d="1">+1</button>
        </div>`;
    steppers = `
      <div class="chip-edit stacked" data-edit="${slot.id}">
        ${slot.bw ? '' : `<div class="edit-row"><span class="edit-tag">${slot.added ? '+' + esc(state.settings.unit) : esc(state.settings.unit)}</span>${weightRow}</div>`}
        ${slot.reps ? `<div class="edit-row"><span class="edit-tag">reps</span>
          <button class="step" data-action="rstep" data-slot="${slot.id}" data-d="-1">−1</button>
          <input class="chip-input" type="number" inputmode="numeric"
                 data-action="reps" data-slot="${slot.id}" value="${r === '' || r == null ? '' : esc(String(r))}">
          <button class="step" data-action="rstep" data-slot="${slot.id}" data-d="1">+1</button>
        </div>` : ''}
        ${rirRow}
        ${setLogHTML(slot.id, a)}
      </div>`;
  }
  const sub = [esc(slot.target || '')];
  if (hasMenu) sub.push(`${slot.menu.length} options`);
  if (slot.cut) sub.push(slot.cut === 1 ? 'cut first' : 'cut next');
  const val = slot.track || hasRungs
    ? `<button class="chip" data-action="expand" data-slot="${slot.id}" aria-label="Adjust">${valInnerHTML(day.id, slot)}</button>` : '';
  return `
    <div class="slot ${done ? 'done' : ''} ${note.trim() ? 'has-note' : ''}" data-slotcard="${slot.id}">
      <div class="slot-row">
        ${ringHTML(slot, a)}
        <button class="slot-main" data-action="expand" data-slot="${slot.id}" aria-expanded="false">
          <span class="slot-name">${esc(slot.name)}<i class="note-dot" aria-label="has a note"></i></span>
          <span class="slot-sub">${sub.filter(Boolean).join(' · ')}</span>
        </button>
        ${videoChipHTML(day, slot)}
        ${val}
      </div>
      ${pairNote}
      ${slot.cue ? `<div class="slot-cue">${esc(slot.cue)}</div>` : ''}
      <div class="slot-drawer hidden" data-drawer="${slot.id}">
        ${warmup}${rungs}${menu}${steppers}
        <div class="note-edit" data-noteedit="${slot.id}">
          <textarea rows="2" data-action="notetext" data-slot="${slot.id}"
            placeholder="Note for today">${esc(note)}</textarea>
        </div>
      </div>
    </div>`;
}

// The row's number: weight (and reps), or today's rung on a ladder.
function valInnerHTML(dayId, slot) {
  if (slot.track) return chipInnerHTML(dayId, slot);
  const r = effectiveRung(dayId, slot);
  return r ? `<span class="chip-rung">${esc(r)}</span>` : '<span class="chip-add">Pick rung</span>';
}

/* The dock's suggestion: every slot already declares its rest tier — once a
   slot is touched (chip, weight, note, rung) the brass follows its tier and
   names the lift. Ephemeral by design: resets on every route render, and
   with no touch yet the dock keeps its old neutral look. */
let currentSlotId = null;

function touchSlot(slotId) {
  if (slotId === currentSlotId) return;
  currentSlotId = slotId;
  if (!rest.running && !rest.done) renderRestDock();
}

function restHint() {
  const dayId = currentDayId();
  if (!dayId || !currentSlotId) return null;
  const slot = findSlot(findDay(dayId), currentSlotId);
  if (!slot) return null;
  return { tier: slot.rest === 'heavy' ? 'heavy' : 'normal', name: slot.name };
}

function restDockHTML() {
  const h = state.settings.restHeavy;
  if (rest.running) {
    const left = (rest.endsAt - Date.now()) / 1000;
    const pct = Math.max(0, Math.min(100, (1 - left / rest.total) * 100));
    return `
      <div class="rest-running">
        <div class="rest-fill" data-rest-fill style="width:${pct}%"></div>
        <div class="rest-row">
          <div class="rest-time" data-rest-time>${fmtMMSS(left)}</div>
          <span class="rest-label">${esc(rest.label || 'Rest')}</span>
          <button class="rest-mini" data-action="rest-restart" aria-label="Restart rest">${icon('again', 2.2)}</button>
          <button class="rest-mini" data-action="rest-cancel" aria-label="Stop rest">${icon('close', 2.2)}</button>
        </div>
      </div>`;
  }
  if (rest.done) {
    return `<button class="rest-done" data-action="rest-ack">Rest done</button>`;
  }
  // Inside a pair the suggested normal button says who's paired, and a
  // group with its own rest (pairRest) lends the button that duration.
  const hint = restHint();
  const day = findDay(currentDayId());
  const hintSlot = hint && day ? findSlot(day, currentSlotId) : null;
  const pairFor = hintSlot ? pairNames(day, hintSlot) : '';
  const btn = (tier, sec) => {
    const suggested = hint && hint.tier === tier;
    const cls = 'restbtn' + (hint ? (suggested ? '' : ' quiet') : (tier === 'heavy' ? ' heavy' : ''));
    const tag = '';   // the brass alone says which tier fits; no caption
    return `<button class="${cls}" data-action="rest" data-tier="${tier}"><span class="restbtn-k">Rest</span><span class="restbtn-t">${fmtMMSS(sec)}</span>${tag}</button>`;
  };
  return `<div class="rest-idle">${btn('normal', normalRestSec())}${btn('heavy', h)}</div>`;
}

function renderRestDock() {
  const dock = $('#restdock');
  if (dock) dock.innerHTML = restDockHTML();
}
function updateRestTime(left) {
  const t = $('[data-rest-time]');
  const f = $('[data-rest-fill]');
  if (t) t.textContent = fmtMMSS(left);
  if (f) f.style.width = Math.max(0, Math.min(100, (1 - left / rest.total) * 100)) + '%';
}

// Consecutive slots sharing a pair key sit together on one washed mat,
// one tag saying the deal; scattered pair members keep their per-card
// note instead. The tag goes quiet once every member is done.
function slotsHTML(day) {
  const a = state.active && state.active.dayId === day.id ? state.active : null;
  const groups = [];
  for (const slot of day.slots) {
    const last = groups[groups.length - 1];
    if (last && last.pair && last.pair === slot.pair) last.slots.push(slot);
    else groups.push({ pair: slot.pair || null, slots: [slot] });
  }
  // Unpaired neighbours share one card too, so the page reads as a few
  // blocks instead of a stack of separate boxes.
  const merged = [];
  for (const g of groups) {
    const solo = g.slots.length < 2;
    const prev = merged[merged.length - 1];
    if (solo && prev && prev.solo) prev.slots.push(...g.slots);
    else merged.push({ solo, pair: g.pair, slots: g.slots.slice() });
  }
  return merged.map((g) => {
    if (g.solo) return `<div class="slotgroup">${g.slots.map((s) => slotCardHTML(day, s)).join('')}</div>`;
    const allDone = g.slots.every((s) => a && a.entries[s.id] && a.entries[s.id].done);
    const trio = g.slots.length > 2;
    const word = trio ? 'Trio · cycle through' : 'Pair · alternate sets';
    return `
      <div class="pairmat ${allDone ? 'done' : ''}">
        <div class="pairtag">
          <span class="pt-live">${tieSVG()}<span>${word}</span><span class="pairtag-rest">${fmtMMSS(pairRestSec(day, g.slots[0]))} rest</span></span>
          <span class="pt-done">${earMini()}${trio ? 'Trio done' : 'Pair done'}</span>
        </div>
        ${g.slots.map((s) => slotCardHTML(day, s, true)).join('')}
      </div>`;
  }).join('');
}

function tieSVG() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 8h13m0 0-3-3m3 3-3 3M17 16H4m0 0 3-3m-3 3 3 3"/></svg>`;
}

function viewDay(dayId) {
  const day = findDay(dayId);
  if (!day) { location.hash = '#/'; return ''; }
  const a = state.active && state.active.dayId === dayId ? state.active : null;
  const allDone = !!a && day.slots.every((s) => a.entries[s.id] && a.entries[s.id].done);
  return `
    ${topbar('#/')}
    <div class="dayhead">
      <div class="dayhead-name">${esc(day.name)}</div>
      <div class="dayhead-sub">${esc(day.subtitle)}</div>
    </div>
    <div class="dock">
      ${trailHTML(day)}
      <div id="restdock" class="restdock">${restDockHTML()}</div>
    </div>
    <div class="slots">${slotsHTML(day)}</div>
    <button class="finishbtn ${allDone ? 'ready' : ''}" data-action="finish" data-day="${day.id}">Finish session</button>`;
}

// A few brass kernels scatter off a ring the moment its exercise is done.
function kernelBurst(ringEl) {
  if (!ringEl || reducedMotion()) return;
  const row = ringEl.closest('.slot-row');
  if (!row) return;
  const b = document.createElement('span');
  b.className = 'burst';
  b.style.left = (ringEl.offsetLeft + ringEl.offsetWidth / 2) + 'px';
  b.style.top = (ringEl.offsetTop + ringEl.offsetHeight / 2) + 'px';
  b.innerHTML = [0, 1, 2, 3, 4, 5].map((i) => `<i style="--a:${i * 60 + 12}deg;--d:${i * 18}ms"></i>`).join('');
  row.appendChild(b);
  setTimeout(() => b.remove(), 1000);
}

// Confirm + recap in one card: the promise ("saves every tracked lift at the
// weight on its chip") stops being a sentence and becomes readable rows, so
// a stale prefill jumps out here — before it's in the log.
function viewFinish(dayId) {
  const day = findDay(dayId);
  if (!day) { location.hash = '#/'; return ''; }
  const a = state.active && state.active.dayId === dayId ? state.active : null;
  const mins = a ? Math.max(1, Math.round((Date.now() - a.startedAt) / 60000)) : 0;
  // Ring count joins the headline only once rings were used — an ignored
  // trail must never read "0 of 9" at the finish.
  let doneCt = 0;
  if (a) for (const slot of day.slots) {
    if (a.entries[slot.id] && a.entries[slot.id].done) doneCt++;
  }
  const rows = [];
  const extras = [];
  for (const slot of day.slots) {
    const e = a ? a.entries[slot.id] : null;
    const noted = !!(e && e.note && e.note.trim());
    const rung = slot.rungs ? effectiveRung(dayId, slot) : '';
    if (rung) extras.push(`${slot.name} — ${rung}${noted ? ' · note' : ''}`);
    if (slot.track) {
      const w = effectiveWeight(dayId, slot);
      const r = slot.reps ? effectiveReps(dayId, slot) : '';
      const rTxt = r === '' || r == null ? '—' : esc(String(r));
      const total = setTarget(slot);
      const banked = e && e.sets ? Math.min(e.sets, total || e.sets) : 0;
      let num;
      if (!banked && !(e && e.done)) num = '<span class="rrow-skip">Skipped</span>';
      else {
        if (slot.bw) num = `<b>${rTxt}</b> reps`;
        else if ((w === '' || w == null || w === 0) && slot.added) num = `<b>BW</b> ×${rTxt}`;
        else {
          const wTxt = w === '' || w == null ? '—' : (slot.added ? '+' : '') + w;
          num = `<b>${esc(String(wTxt))}</b> ${esc(state.settings.unit)}${slot.reps ? ` ×${rTxt}` : ''}`;
        }
        if (total && banked < total) num = `<span class="rrow-part">${banked} of ${total} sets</span> ${num}`;
      }
      rows.push(`<div class="rrow">
        <span class="rrow-name">${esc(slot.name)}${noted ? ` <i class="rrow-note" aria-label="has a note">${icon('note', 2)}</i>` : ''}</span>
        <span class="rrow-num">${num}</span></div>`);
    } else if (noted && !rung) {
      extras.push(`${slot.name} · note`);
    }
  }
  const meta = [day.name];
  if (doneCt) meta.push(`${doneCt} of ${day.slots.length} done`);
  if (mins) meta.push(`${mins} min`);
  // The ear grows on the way in: stem, kernels bottom to top, awns last,
  // then a few loose kernels fall.
  return `
    ${topbar('#/day/' + dayId)}
    <div class="finish-wrap">
      <div class="finish-hero">
        <div class="earwrap">${barleySVG('barley grow ripen')}<span class="fall" aria-hidden="true"><i></i><i></i><i></i></span></div>
        <div class="finish-line">Good work, Damiano</div>
        <div class="finish-meta">${esc(meta.join(' · '))}</div>
      </div>
      <div class="recap">
        <div class="recap-head">Will save</div>
        ${rows.join('')}
        ${extras.length ? `<div class="recap-extra">${esc(extras.join(' · '))}</div>` : ''}
      </div>
      <textarea id="finishnote" rows="3" placeholder="Session note (optional)"></textarea>
      <button class="finishbtn solid" data-action="finish-save" data-day="${day.id}">Save session</button>
    </div>`;
}

function viewSettings() {
  const s = state.settings;
  const seg = (name, val, opts) => opts.map(([v, label]) =>
    `<button class="seg ${val === v ? 'on' : ''}" data-action="${name}" data-v="${v}">${label}</button>`
  ).join('');
  return `
    ${topbar('#/')}
    <div class="dayhead-name">Settings</div>
    <div class="settings">
      <div class="group-head">Display</div>
      <div class="group">
        <div class="setrow">
          <div class="setlabel">Theme</div>
          <div class="segwrap">${seg('theme', s.theme, [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']])}</div>
        </div>
        <div class="setrow">
          <div class="setlabel">Unit</div>
          <div class="segwrap">${seg('unit', s.unit, [['lb', 'lb'], ['kg', 'kg']])}</div>
        </div>
      </div>
      <div class="group-head">Rest</div>
      <div class="group">
        <div class="setrow">
          <div class="setlabel">Normal</div>
          <label class="numfield"><input class="setnum" type="number" inputmode="numeric" data-action="rest-normal" value="${s.restNormal}">s</label>
        </div>
        <div class="setrow">
          <div class="setlabel">Heavy</div>
          <label class="numfield"><input class="setnum" type="number" inputmode="numeric" data-action="rest-heavy" value="${s.restHeavy}">s</label>
        </div>
      </div>
      <div class="group-head">Data</div>
      <div class="group">
        <div class="setrow">
          <div class="setlabel">Backup</div>
          <div class="btnrow">
            <button class="setbtn" data-action="export">Export</button>
            <button class="setbtn" data-action="copy-json">Copy JSON</button>
          </div>
        </div>
        <a class="grow-link" href="#/import"><span class="setlabel">Import</span>${icon('chev', 2.2)}</a>
        <div class="setrow">
          <div class="setlabel">Erase everything</div>
          <button class="setbtn danger" data-action="erase">Erase all data</button>
        </div>
      </div>
      <div class="version">v${APP_VERSION} · ${state.sessions.length} sessions logged</div>
    </div>`;
}

function viewImport() {
  return `
    ${topbar('#/settings')}
    <div class="settings">
      <div class="dayhead-name">Import</div>
      <p class="finish-hint">Paste a Damiano JSON export. Replaces everything.</p>
      <textarea id="importbox" rows="8" placeholder="{ … }"></textarea>
      <button class="finishbtn solid" data-action="import-load">Load</button>
    </div>`;
}

function viewProgram() {
  const days = state.program.days.map((day) => `
    <div class="group-head">${esc(day.name)} — ${esc(day.subtitle)}</div>
    <div class="group proglist">
      ${day.slots.map((s) => `
        <a class="progrow" href="#/program/${day.id}/${s.id}">
          <span class="progrow-name">${esc(s.name)}</span>
          <span class="progrow-target">${esc(s.target || '')}</span>${icon('chev', 2.2)}
        </a>`).join('')}
      <button class="grow-link add" data-action="add-slot" data-day="${day.id}">${icon('plus', 2.4)}Add exercise</button>
    </div>`).join('');
  return `${topbar('#/settings')}<div class="dayhead-name">Program</div><div class="settings">${days}</div>`;
}

function viewSlotEdit(dayId, slotId) {
  const day = findDay(dayId);
  const slot = findSlot(day, slotId);
  if (!slot) { location.hash = '#/program'; return ''; }
  const field = (label, action, value, ph) => `
    <label class="editfield"><span>${label}</span>
      <input type="text" data-action="${action}" value="${esc(value || '')}" placeholder="${ph || ''}"></label>`;
  const sw = (label, action, on, sub) => `
      <div class="setrow">
        <div class="setlabel">${label}${sub ? `<span class="setsub">${sub}</span>` : ''}</div>
        <button class="switch ${on ? 'on' : ''}" role="switch" aria-checked="${on ? 'true' : 'false'}"
          aria-label="${label}" data-action="${action}"></button>
      </div>`;
  return `
    ${topbar('#/program')}
    <div class="settings" data-editing-day="${dayId}" data-editing-slot="${slotId}">
      ${field('Name', 'edit-name', slot.name)}
      ${field('Target', 'edit-target', slot.target, 'e.g. 3×6–8 · RIR 2–3')}
      ${field('Cue', 'edit-cue', slot.cue)}
      ${field('Warm-up', 'edit-warmup', slot.warmup)}
      <label class="editfield"><span>Menu (one per line)</span>
        <textarea rows="4" data-action="edit-menu">${esc((slot.menu || []).join('\n'))}</textarea></label>
      <label class="editfield"><span>Rungs (ordered, one per line)</span>
        <textarea rows="3" data-action="edit-rungs">${esc((slot.rungs || []).join('\n'))}</textarea></label>
      ${field('Pair (same letter = done together)', 'edit-pair', slot.pair, 'e.g. a')}
      ${field('Pair rest (seconds — blank = normal tier)', 'edit-pairrest', slot.pairRest, 'e.g. 60')}
      <div class="group">
        ${sw('Track weight', 'edit-track', slot.track)}
        ${sw('Added load (+)', 'edit-added', slot.added)}
        ${sw('Track reps', 'edit-reps', slot.reps)}
        <div class="setrow">
          <div class="setlabel">Rest tier</div>
          <div class="segwrap">
            <button class="seg ${slot.rest !== 'heavy' ? 'on' : ''}" data-action="edit-rest" data-v="normal">Normal</button>
            <button class="seg ${slot.rest === 'heavy' ? 'on' : ''}" data-action="edit-rest" data-v="heavy">Heavy</button>
          </div>
        </div>
      </div>
      <div class="btnrow edit-actions">
        <button class="setbtn" data-action="edit-up">${icon('up', 2.2)}Move up</button>
        <button class="setbtn" data-action="edit-down">${icon('dn', 2.2)}Move down</button>
        <button class="setbtn danger" data-action="edit-delete">Delete</button>
      </div>
    </div>`;
}

/* ============================== router ============================== */

function render() {
  currentSlotId = null;
  const hash = location.hash || '#/';
  const parts = hash.replace(/^#\//, '').split('/');
  if ((parts[0] === 'day' || parts[0] === 'finish') && parts[1]) resumeDraft(parts[1]);
  let html = '';
  if (parts[0] === 'day' && parts[1]) html = viewDay(parts[1]);
  else if (parts[0] === 'finish' && parts[1]) html = viewFinish(parts[1]);
  else if (parts[0] === 'video' && parts[1]) html = viewVideo(parts[1], parts[2]);
  else if (parts[0] === 'settings') html = viewSettings();
  else if (parts[0] === 'import') html = viewImport();
  else html = viewHome();
  const app = $('#app');
  app.setAttribute('data-view', parts[0] || 'home');
  app.innerHTML = html;
  window.scrollTo(0, 0);
  if (parts[0] === 'video') wireVideoView();
}

window.addEventListener('hashchange', render);

/* ============================== actions ============================== */

let pendingErase = false;

function currentDayId() {
  const m = (location.hash || '').match(/^#\/day\/([^/]+)/);
  return m ? m[1] : null;
}

function editedSlot() {
  const wrap = $('[data-editing-slot]');
  if (!wrap) return {};
  const dayId = wrap.getAttribute('data-editing-day');
  const slotId = wrap.getAttribute('data-editing-slot');
  const day = findDay(dayId);
  return { day, slot: findSlot(day, slotId) };
}

document.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-action]');
  if (!t) return;
  const action = t.getAttribute('data-action');
  const dayId = currentDayId();

  if (action === 'rest') { restStart(t.getAttribute('data-tier'), null); return; }
  if (action === 'rest-restart') { restStart(rest.tier || 'normal', rest.label); return; }
  if (action === 'rest-cancel') { restCancel(); return; }
  if (action === 'rest-ack') { rest.done = false; renderRestDock(); return; }

  if (action === 'prog-toggle') {
    const k = t.getAttribute('data-key');
    progOpen = progOpen === k ? null : k;
    // re-render in place: render() homes the scroll, so put it back
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
    return;
  }
  if (action === 'targets-toggle') {
    state.settings.targetsOpen = !state.settings.targetsOpen;
    save();
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
    return;
  }
  if (action === 'expand') {
    // One drawer open at a time keeps the list calm.
    const id = t.getAttribute('data-slot');
    const box = $(`[data-drawer="${id}"]`);
    if (!box) return;
    const opening = box.classList.contains('hidden');
    document.querySelectorAll('[data-drawer]').forEach((d) => {
      d.classList.add('hidden');
      const c = d.closest('.slot');
      if (c) { c.classList.remove('open'); const m = c.querySelector('.slot-main'); if (m) m.setAttribute('aria-expanded', 'false'); }
    });
    if (opening) {
      box.classList.remove('hidden');
      const card = box.closest('.slot');
      card.classList.add('open');
      card.querySelector('.slot-main').setAttribute('aria-expanded', 'true');
    }
    touchSlot(id);
    return;
  }
  if (action === 'step') {
    const slotId = t.getAttribute('data-slot');
    const d = parseFloat(t.getAttribute('data-d'));
    const day = findDay(dayId);
    const slot = findSlot(day, slotId);
    if (!slot) return;
    const cur = parseFloat(effectiveWeight(dayId, slot));
    const next = (Number.isFinite(cur) ? cur : 0) + d;
    const e = activeEntry(dayId, slotId);
    e.weight = Math.max(0, next);
    save();
    const input = $(`[data-edit="${slotId}"] .chip-input`);
    if (input) input.value = e.weight;
    refreshChip(dayId, slot);
    touchSlot(slotId);
    return;
  }
  if (action === 'irstep') {
    const slotId = t.getAttribute('data-slot');
    const d = parseInt(t.getAttribute('data-d'), 10);
    const slot = findSlot(findDay(dayId), slotId);
    if (!slot) return;
    const cur = parseInt(effectiveRir(dayId, slot), 10);
    const e = activeEntry(dayId, slotId);
    e.rir = Math.max(0, Math.min(10, (Number.isFinite(cur) ? cur : 2) + d));
    save();
    const input = $(`[data-edit="${slotId}"] input[data-action="rir"]`);
    if (input) input.value = e.rir;
    touchSlot(slotId);
    return;
  }
  if (action === 'rstep') {
    const slotId = t.getAttribute('data-slot');
    const d = parseInt(t.getAttribute('data-d'), 10);
    const day = findDay(dayId);
    const slot = findSlot(day, slotId);
    if (!slot) return;
    const cur = parseInt(effectiveReps(dayId, slot), 10);
    const next = (Number.isFinite(cur) ? cur : 0) + d;
    const e = activeEntry(dayId, slotId);
    e.reps = Math.max(0, next);
    save();
    const input = $(`[data-edit="${slotId}"] input[data-action="reps"]`);
    if (input) input.value = e.reps;
    refreshChip(dayId, slot);
    touchSlot(slotId);
    return;
  }
  if (action === 'ring') {
    const slotId = t.getAttribute('data-slot');
    const day = findDay(dayId);
    const slot = findSlot(day, slotId);
    if (!slot) return;
    const e = activeEntry(dayId, slotId);
    // Done state is ephemeral by design: lives in the active session, never
    // in the log — Finish works fine if rings go untouched. Delete on clear
    // so exports don't carry done:false keys around.
    const total = setTarget(slot);
    if (total) {
      // Counting ring: each tap banks one set and starts that exercise's
      // rest; the tap that fills the ring is the old check. Tapping the
      // check clears the exercise back to untouched — one press recovers
      // accidental over-taps — and never starts a timer.
      if (e.done) {
        delete e.done;
        delete e.sets;
        delete e.log;
        const lg = $(`[data-setlog="${slotId}"]`);
        if (lg) lg.outerHTML = setLogHTML(slotId, e);
      } else {
        e.sets = Math.min((e.sets || 0) + 1, total);
        if (slot.track) {
          const w = effectiveWeight(dayId, slot);
          const r = slot.reps ? effectiveReps(dayId, slot) : '';
          const ir = effectiveRir(dayId, slot);
          e.log = (e.log || []).slice(0, e.sets - 1);
          e.log.push({ w: slot.bw || w === '' || w == null ? null : parseFloat(w), r: r === '' || r == null ? null : parseInt(r, 10), rir: ir === '' || ir == null ? null : parseInt(ir, 10), at: Date.now() });
          const lg = $(`[data-setlog="${slotId}"]`);
          if (lg) lg.outerHTML = setLogHTML(slotId, e);
        }
        if (e.sets >= total) e.done = true;
        // The banked slot rides along so its group's own rest (the trio's
        // 1:00) wins even when he works out of order.
        restStart(slot.rest === 'heavy' ? 'heavy' : 'normal', restLabelFor(e.sets, total), slot);
      }
    } else if (e.done) { delete e.done; } else { e.done = true; }
    save();
    const card = $(`[data-slotcard="${slotId}"]`);
    if (card) card.classList.toggle('done', !!e.done);
    const mat = card && card.closest('.pairmat');
    if (mat) {
      const cards = [...mat.querySelectorAll('[data-slotcard]')];
      const all = cards.every((c) => c.classList.contains('done'));
      mat.classList.toggle('just', all && !mat.classList.contains('done'));
      mat.classList.toggle('done', all);
    }
    t.outerHTML = ringHTML(slot, e);
    const fresh = $(`.ring[data-slot="${slotId}"]`);
    if (fresh) {
      fresh.classList.add('pop');
      if (e.done) kernelBurst(fresh);
    }
    updateTrail(dayId);
    touchSlot(slotId);
    return;
  }
  if (action === 'rung') {
    const slotId = t.getAttribute('data-slot');
    const day = findDay(dayId);
    const slot = findSlot(day, slotId);
    if (!slot) return;
    const name = t.getAttribute('data-rung');
    const e = activeEntry(dayId, slotId);
    // Tap selects today's rung; tapping the highlighted one clears it.
    e.rung = effectiveRung(dayId, slot) === name ? '' : name;
    save();
    const eff = effectiveRung(dayId, slot);
    document.querySelectorAll(`[data-slotcard="${slotId}"] .rung`).forEach((el) => {
      el.classList.toggle('now', eff !== '' && el.getAttribute('data-rung') === eff);
    });
    refreshChip(dayId, slot);
    touchSlot(slotId);
    return;
  }
  if (action === 'finish') { location.hash = '#/finish/' + t.getAttribute('data-day'); return; }
  if (action === 'finish-save') {
    finishSession(t.getAttribute('data-day'), ($('#finishnote') || {}).value || '');
    return;
  }

  if (action === 'theme') { state.settings.theme = t.getAttribute('data-v'); applyTheme(); save(); render(); return; }
  if (action === 'unit') { state.settings.unit = t.getAttribute('data-v'); save(); render(); return; }
  if (action === 'export') { exportJSON(); return; }
  if (action === 'copy-json') {
    navigator.clipboard.writeText(JSON.stringify(state, null, 1))
      .then(() => toast('Copied'))
      .catch(() => toast('Copy failed'));
    return;
  }
  if (action === 'erase') {
    if (!pendingErase) {
      pendingErase = true;
      t.textContent = 'Tap again to erase';
      setTimeout(() => { pendingErase = false; if (document.body.contains(t)) t.textContent = 'Erase all data'; }, 3500);
      return;
    }
    localStorage.removeItem(STORE_KEY);
    state = defaultState();
    save();
    pendingErase = false;
    location.hash = '#/';
    render();
    toast('Erased');
    return;
  }
  if (action === 'import-load') {
    try {
      const parsed = JSON.parse(($('#importbox') || {}).value || '');
      if (validState(parsed)) { state = parsed; }
      else if (parsed && parsed.version === 1) {
        state = defaultState();
        state.sessions = migrateV1Sessions(parsed);
        if (parsed.settings && parsed.settings.theme) state.settings.theme = parsed.settings.theme;
      } else { toast('Not a Strength Rebuild export'); return; }
      patchProgram();
      save();
      applyTheme();
      location.hash = '#/';
      toast('Imported');
    } catch (e) { toast('Could not parse JSON'); }
    return;
  }

  if (action === 'add-slot') {
    const day = findDay(t.getAttribute('data-day'));
    if (!day) return;
    const id = 's' + uid();
    day.slots.push({ id, name: 'New exercise', target: '', track: true, rest: 'normal', cue: '' });
    save();
    location.hash = `#/program/${day.id}/${id}`;
    return;
  }
  if (action === 'edit-track' || action === 'edit-added' || action === 'edit-reps') {
    const { slot } = editedSlot();
    if (!slot) return;
    const key = action === 'edit-track' ? 'track' : action === 'edit-added' ? 'added' : 'reps';
    slot[key] = !slot[key];
    save(); render();
    return;
  }
  if (action === 'edit-rest') {
    const { slot } = editedSlot();
    if (!slot) return;
    slot.rest = t.getAttribute('data-v');
    save(); render();
    return;
  }
  if (action === 'edit-up' || action === 'edit-down') {
    const { day, slot } = editedSlot();
    if (!day || !slot) return;
    const i = day.slots.indexOf(slot);
    const j = action === 'edit-up' ? i - 1 : i + 1;
    if (j < 0 || j >= day.slots.length) return;
    day.slots.splice(i, 1);
    day.slots.splice(j, 0, slot);
    save();
    toast(action === 'edit-up' ? 'Moved up' : 'Moved down');
    return;
  }
  if (action === 'edit-delete') {
    const { day, slot } = editedSlot();
    if (!day || !slot) return;
    day.slots.splice(day.slots.indexOf(slot), 1);
    save();
    location.hash = '#/program';
    return;
  }
});

document.addEventListener('input', (ev) => {
  const t = ev.target.closest('[data-action]');
  if (!t) return;
  const action = t.getAttribute('data-action');
  const dayId = currentDayId();

  if (action === 'weight') {
    const slotId = t.getAttribute('data-slot');
    const e = activeEntry(dayId, slotId);
    e.weight = t.value === '' ? '' : parseFloat(t.value);
    if (!Number.isFinite(e.weight)) e.weight = '';
    const day = findDay(dayId);
    const slot = findSlot(day, slotId);
    if (slot) refreshChip(dayId, slot);
    touchSlot(slotId);
    saveSoon();
    return;
  }
  if (action === 'reps') {
    const slotId = t.getAttribute('data-slot');
    const e = activeEntry(dayId, slotId);
    e.reps = t.value === '' ? '' : parseInt(t.value, 10);
    if (!Number.isFinite(e.reps)) e.reps = '';
    const day = findDay(dayId);
    const slot = findSlot(day, slotId);
    if (slot) refreshChip(dayId, slot);
    touchSlot(slotId);
    saveSoon();
    return;
  }
  if (action === 'rir') {
    const slotId = t.getAttribute('data-slot');
    const e = activeEntry(dayId, slotId);
    e.rir = t.value === '' ? '' : parseInt(t.value, 10);
    if (!Number.isFinite(e.rir)) e.rir = '';
    touchSlot(slotId);
    saveSoon();
    return;
  }
  if (action === 'notetext') {
    const e = activeEntry(dayId, t.getAttribute('data-slot'));
    e.note = t.value;
    const card = $(`[data-slotcard="${t.getAttribute('data-slot')}"]`);
    if (card) card.classList.toggle('has-note', !!t.value.trim());
    touchSlot(t.getAttribute('data-slot'));
    saveSoon();
    return;
  }
  if (action === 'recal-date') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(t.value)) {
      state.settings.recalDate = t.value;
      saveSoon();
    }
    return;
  }
  if (action === 'rest-normal' || action === 'rest-heavy') {
    const n = parseInt(t.value, 10);
    if (Number.isFinite(n) && n >= 10 && n <= 900) {
      state.settings[action === 'rest-normal' ? 'restNormal' : 'restHeavy'] = n;
      saveSoon();
    }
    return;
  }

  const editable = { 'edit-name': 'name', 'edit-target': 'target', 'edit-cue': 'cue', 'edit-warmup': 'warmup' };
  if (editable[action]) {
    const { slot } = editedSlot();
    if (!slot) return;
    slot[editable[action]] = t.value;
    saveSoon();
    return;
  }
  if (action === 'edit-menu' || action === 'edit-rungs') {
    const { slot } = editedSlot();
    if (!slot) return;
    const key = action === 'edit-menu' ? 'menu' : 'rungs';
    const lines = t.value.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length) slot[key] = lines; else delete slot[key];
    saveSoon();
    return;
  }
  if (action === 'edit-pair') {
    const { slot } = editedSlot();
    if (!slot) return;
    const v = t.value.trim();
    if (v) slot.pair = v; else delete slot.pair;
    saveSoon();
    return;
  }
  if (action === 'edit-pairrest') {
    const { slot } = editedSlot();
    if (!slot) return;
    const v = parseInt(t.value, 10);
    if (v > 0) slot.pairRest = v; else delete slot.pairRest;
    saveSoon();
    return;
  }
});

/* ============================== export ============================== */

function exportJSON() {
  const json = JSON.stringify(state, null, 1);
  const stamp = new Date().toISOString().slice(0, 10);
  const name = `strength-rebuild-${stamp}.json`;
  const blob = new Blob([json], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: name }).then(() => {
      state.settings.lastExport = Date.now();
      save();
    }).catch(() => {});
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  state.settings.lastExport = Date.now();
  save();
}

/* ============================ update flow ============================
   Installed iOS PWAs cling to old versions: they resume without a fresh
   boot (no update check) and a single failed request used to sink the
   whole SW install. Check for an update on every resume, and when a new
   version takes control, reload into it — unless a rest is running. */

// Reload when a new worker takes over a page that already had one (an
// update, never the first install). The launch itself often triggers the
// update check before checkForUpdate runs, so this can't wait for that call.
const hadController = 'serviceWorker' in navigator && !!navigator.serviceWorker.controller;
let reloaded = false;
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloaded) return;
    reloaded = true;
    // Never pull the page out from under him: a running rest, the save
    // screen (its note isn't stored until Save), or a field being typed in.
    const typing = document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (rest.running || /^#\/finish\//.test(location.hash) || typing) {
      toast('Update ready — lands on next open');
      return;
    }
    flushSave();
    location.reload();
  });
}
function checkForUpdate() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.getRegistration()
    .then((reg) => { if (reg) reg.update(); })
    .catch(() => {});
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdate(); });
window.addEventListener('load', () => setTimeout(checkForUpdate, 3000));

/* ============================== boot ============================== */

load();
patchProgram();
quarantineAutoSessions();
applyTheme();
clearStaleDrafts();
render();
// The greeting plays as its own screen once per launch, from home only.
// sessionStorage survives the self-reload into an update, not a relaunch.
let greeted = false;
try { greeted = sessionStorage.getItem('sr-greeted') === '1'; sessionStorage.setItem('sr-greeted', '1'); } catch (e) {}
if (!greeted && (location.hash || '#/') === '#/') showSplash();
