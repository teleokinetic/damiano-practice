/* Damiano — filming requests.
   A request belongs to the lift, not the session: it shows beside that lift
   wherever it comes up next, and leaves once the clip is in. Recording uses
   the phone's own camera (most reliable on iPhone); playback, trim marks and
   the set details happen here. Until sync lands, a sent clip is kept on this
   phone (IndexedDB) and marked "saved", never "received". */

// Framing references: camera setup only, not technique demos.
const VIDEO_LIFTS = {
  pullup: {
    name: 'Pull-up', short: 'pull-up',
    img: 'https://i0.wp.com/www.strengthlog.com/wp-content/uploads/2019/06/johanna-chins-stilstudie.jpg?resize=700%2C600&ssl=1',
    credit: 'StrengthLog', creditUrl: 'https://www.strengthlog.com/pull-up/',
    lines: [
      'Behind and to one side, a little more to the side than this.',
      'Hands, bar, head and feet in frame the whole set.',
    ],
  },
  rdl: {
    name: 'Romanian deadlift', short: 'RDL',
    img: 'https://3tblogg.wordpress.com/wp-content/uploads/2014/09/ovelse1-martelise.jpg',
    credit: '3T', creditUrl: 'https://3tblogg.no/2014/09/19/tre-gode-ovelser-for-rumpa/',
    lines: [
      'Direct side view, like this.',
      'Head, hips, knees, feet and weights in frame, standing and hinged.',
    ],
  },
  splitsquat: {
    name: 'Bulgarian split squat', short: 'split squat',
    img: 'https://i0.wp.com/www.strengthlog.com/wp-content/uploads/2023/04/bulgarian-split-squat-dumbbells-start.png?resize=700%2C752&ssl=1',
    credit: 'StrengthLog', creditUrl: 'https://www.strengthlog.com/bulgarian-split-squat/',
    lines: [
      'Slightly angled side view.',
      'Whole body, front foot and rear-foot support. Leave room for the bottom.',
      'Both legs, one after the other, same framing.',
    ],
  },
  bench: {
    name: 'Bench press', short: 'bench',
    img: 'https://i0.wp.com/www.strengthlog.com/wp-content/uploads/2021/09/bench-press.gif?resize=600%2C600&ssl=1',
    credit: 'StrengthLog', creditUrl: 'https://www.strengthlog.com/bench-press/',
    lines: [
      'Angled side view, more to the side than this.',
      'Feet, bench, rack, hands and bar in frame, from setup to reracking.',
      'Phone outside the rack, clear of spotters and walkways.',
    ],
  },
};
const VIDEO_ORDER = ['pullup', 'rdl', 'splitsquat', 'bench'];
const VIDEO_GENERAL = 'After warming up, film one normal working set. Phone still, whole body in frame, setup to finish.';

function defaultVideoReqs() {
  const out = {};
  for (const k of VIDEO_ORDER) out[k] = { status: 'open', at: Date.now() };
  return out;
}

function videoReq(key) { return state && state.videoReqs ? state.videoReqs[key] : null; }
function videoIsOpen(key) { const r = videoReq(key); return !!(r && r.status === 'open'); }
// 'saved' is the demo build's word for a clip kept on the phone; it uploads like 'sending'.
function videoIsSending(key) { const r = videoReq(key); return !!(r && (r.status === 'sending' || r.status === 'saved')); }

function dayVideoKeys(day) {
  const keys = [];
  for (const s of day.slots) if (s.video && videoIsOpen(s.video) && !keys.includes(s.video)) keys.push(s.video);
  return keys;
}

// Up next: one quiet line naming what Tanner asked to see in this session.
function dayVideoTagHTML(day) {
  const keys = dayVideoKeys(day);
  if (!keys.length) return '';
  const names = keys.map((k) => VIDEO_LIFTS[k].short);
  return `<span class="upnext-vid">${icon('camera', 2)}Film ${esc(names.join(', '))}</span>`;
}
function dayVideoDotHTML(day) {
  return dayVideoKeys(day).length
    ? `<span class="vid-dot" aria-label="Video requested">${icon('camera', 2)}</span>` : '';
}

// The chip on the lift's own row, outside the logging drawer.
function videoChipHTML(day, slot) {
  if (!slot.video || !VIDEO_LIFTS[slot.video]) return '';
  const r = videoReq(slot.video);
  if (!r || r.status === 'received') return '';
  const sent = videoIsSending(slot.video);
  return `<a class="vidchip ${sent ? 'sent' : ''}" href="#/video/${slot.video}/${day.id}"
    aria-label="${sent ? 'Video sending' : 'Tanner asked for a video'}">${icon('camera', 2)}${sent ? '<i class="vid-ok"></i>' : ''}</a>`;
}

/* ---- draft (in memory: survives moving around the app) ---- */

let vidDraft = null;   // { key, dayId, file, url, dur, a, b, meta }
let vidMsg = '';

function draftMeta(key, dayId) {
  const day = findDay(dayId);
  const slot = day ? day.slots.find((s) => s.video === key) : null;
  if (!slot) return { w: '', r: '', rest: '', rir: '' };
  const w = effectiveWeight(dayId, slot);
  const r = slot.reps ? effectiveReps(dayId, slot) : '';
  const rir = effectiveRir(dayId, slot);
  return { w: w == null ? '' : String(w), r: r == null ? '' : String(r), rest: '', rir: rir == null ? '' : String(rir) };
}

function fmtClock(sec) {
  if (!Number.isFinite(sec)) return '0:00';
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function captureInputsHTML(key, dayId) {
  return `
    <input id="vidcap" type="file" accept="video/*" capture="environment" class="hidden" data-vidinput="${key}" data-vidday="${esc(dayId || '')}">
    <input id="vidpick" type="file" accept="video/*" class="hidden" data-vidinput="${key}" data-vidday="${esc(dayId || '')}">`;
}

function viewVideo(key, dayId) {
  const lift = VIDEO_LIFTS[key];
  if (!lift) { location.hash = '#/'; return ''; }
  const back = dayId ? '#/day/' + dayId : '#/';
  const r = videoReq(key) || { status: 'open' };
  const draft = vidDraft && vidDraft.key === key ? vidDraft : null;

  if (draft) return `
    ${topbar(back)}
    <div class="vid">
      <div class="vid-k">Video for Tanner</div>
      <div class="dayhead-name">${esc(lift.name)}</div>
      <div class="vid-player">
        <video data-vidplay src="${draft.url}" playsinline controls preload="metadata"></video>
      </div>
      <div class="trim" data-trim>
        <div class="trim-sel" data-trimsel></div>
        <button class="trim-h" data-h="a" aria-label="Start"></button>
        <button class="trim-h" data-h="b" aria-label="End"></button>
      </div>
      <div class="trim-times"><span data-trimta>${fmtClock(draft.a)}</span><span class="trim-hint">Drag to trim</span><span data-trimtb>${fmtClock(draft.b == null ? draft.dur : draft.b)}</span></div>
      <div class="vid-meta">
        ${metaField('w', `Load ${esc(state.settings.unit)}`, draft.meta.w, 'decimal')}
        ${metaField('r', 'Reps', draft.meta.r, 'numeric')}
        ${metaField('rest', 'Rest before', draft.meta.rest, 'text', 'e.g. 2:00')}
        ${metaField('rir', 'Reps left', draft.meta.rir, 'numeric')}
      </div>
      ${captureInputsHTML(key, dayId)}
      <div class="vid-actions">
        <label for="vidcap" class="vidbtn">Retake</label>
        <button class="finishbtn solid ready" data-action="vid-send" data-key="${key}">Send to Tanner</button>
      </div>
      ${vidMsg ? `<div class="vid-msg">${esc(vidMsg)}</div>` : ''}
    </div>`;

  if (videoIsSending(key) || r.status === 'received') {
    // While it's going up there is no way off this screen: one clear wait,
    // then one clear "Sent". Only a lost connection or a failure lets him
    // leave early, and the screen says it will finish on its own.
    const phase = sendPhase(key);
    const busy = phase === 'uploading' || phase === 'confirming';
    const leave = phase === 'received'
      ? `<a class="finishbtn solid ready" href="${back}">Back to ${dayId ? 'session' : 'home'}</a>`
      : busy ? '' : `<a class="vidbtn vid-leave" href="${back}">Leave it for now</a>`;
    return `
    ${busy ? '<div class="topbar"></div>' : topbar(back)}
    <div class="vid ${busy ? 'vid-busy' : ''}">
      <div class="vid-k">Video for Tanner</div>
      <div class="dayhead-name">${esc(lift.name)}</div>
      <div class="vid-done" data-upstatus="${key}">${uploadStatusHTML(key)}</div>
      ${leave}
    </div>`;
  }

  return `
    ${topbar(back)}
    <div class="vid">
      <div class="vid-k">Video for Tanner</div>
      <div class="dayhead-name">${esc(lift.name)}</div>
      <figure class="frame">
        <img src="${esc(lift.img)}" alt="Camera framing for the ${esc(lift.short)}" loading="eager" referrerpolicy="no-referrer">
        <figcaption><a href="${esc(lift.creditUrl)}" target="_blank" rel="noopener">Frame: ${esc(lift.credit)}</a></figcaption>
      </figure>
      <ul class="vid-lines">
        ${lift.lines.map((l) => `<li>${esc(l)}</li>`).join('')}
        <li class="gen">${esc(VIDEO_GENERAL)}</li>
      </ul>
      ${captureInputsHTML(key, dayId)}
      <div class="vid-actions">
        <label for="vidpick" class="vidbtn">Choose video</label>
        <label for="vidcap" class="finishbtn solid ready rec">${icon('rec')}Record</label>
      </div>
    </div>`;
}

function metaField(k, label, val, mode, ph) {
  return `<label class="mf"><span>${label}</span>
    <input type="text" inputmode="${mode}" data-vidmeta="${k}" value="${esc(val || '')}" placeholder="${esc(ph || '—')}"></label>`;
}

/* ---- trim: two handles over the clip; marks only, no re-encode ---- */

function trimLayout() {
  const d = vidDraft;
  const bar = $('[data-trim]');
  if (!d || !bar || !(d.dur > 0)) return;
  const a = d.a / d.dur, b = (d.b == null ? d.dur : d.b) / d.dur;
  bar.querySelector('[data-h="a"]').style.left = (a * 100) + '%';
  bar.querySelector('[data-h="b"]').style.left = (b * 100) + '%';
  const sel = bar.querySelector('[data-trimsel]');
  sel.style.left = (a * 100) + '%';
  sel.style.width = ((b - a) * 100) + '%';
  const ta = $('[data-trimta]'), tb = $('[data-trimtb]');
  if (ta) ta.textContent = fmtClock(d.a);
  if (tb) tb.textContent = fmtClock(d.b == null ? d.dur : d.b);
}

function wireVideoView() {
  const v = $('[data-vidplay]');
  if (!v || !vidDraft) return;
  const d = vidDraft;
  const onMeta = () => {
    if (Number.isFinite(v.duration) && v.duration > 0) {
      d.dur = v.duration;
      if (d.b == null || d.b > d.dur) d.b = d.dur;
      trimLayout();
    }
  };
  v.addEventListener('loadedmetadata', onMeta);
  v.addEventListener('durationchange', onMeta);
  onMeta();
  v.addEventListener('play', () => {
    if (v.currentTime < d.a || (d.b != null && v.currentTime >= d.b - 0.05)) v.currentTime = d.a;
  });
  v.addEventListener('timeupdate', () => {
    if (d.b != null && v.currentTime >= d.b) { v.pause(); v.currentTime = d.b; }
  });
  const bar = $('[data-trim]');
  let drag = null;
  const move = (ev) => {
    if (!drag || !(d.dur > 0)) return;
    const rect = bar.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
    const t = f * d.dur;
    const gap = Math.min(1, d.dur / 10);
    if (drag === 'a') d.a = Math.min(t, (d.b == null ? d.dur : d.b) - gap);
    else d.b = Math.max(t, d.a + gap);
    d.a = Math.max(0, d.a);
    trimLayout();
    try { v.currentTime = drag === 'a' ? d.a : d.b; } catch (e) {}
  };
  bar.querySelectorAll('.trim-h').forEach((h) => {
    h.addEventListener('pointerdown', (ev) => {
      drag = h.getAttribute('data-h');
      h.setPointerCapture(ev.pointerId);
      v.pause();
      ev.preventDefault();
    });
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', () => { drag = null; });
    h.addEventListener('pointercancel', () => { drag = null; });
  });
}

/* ---- picking a clip: a new file replaces the draft; cancel keeps it ---- */

document.addEventListener('change', (ev) => {
  const inp = ev.target.closest && ev.target.closest('[data-vidinput]');
  if (!inp) return;
  const file = inp.files && inp.files[0];
  if (!file) return;   // cancelled: whatever draft exists stays as it was
  const key = inp.getAttribute('data-vidinput');
  const dayId = inp.getAttribute('data-vidday') || '';
  const keepMeta = vidDraft && vidDraft.key === key ? vidDraft.meta : draftMeta(key, dayId);
  if (vidDraft && vidDraft.url) URL.revokeObjectURL(vidDraft.url);
  vidDraft = { key, dayId, file, url: URL.createObjectURL(file), dur: 0, a: 0, b: null, meta: keepMeta };
  vidMsg = '';
  render();
});

document.addEventListener('input', (ev) => {
  const k = ev.target.getAttribute && ev.target.getAttribute('data-vidmeta');
  if (k && vidDraft) vidDraft.meta[k] = ev.target.value;
});

/* ---- saving the clip on the phone (IndexedDB) until sync uploads it ---- */

function clipDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open('damiano-clips', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('clips', { keyPath: 'id' });
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
async function putClip(rec) {
  const db = await clipDB();
  await new Promise((res, rej) => {
    const tx = db.transaction('clips', 'readwrite');
    tx.objectStore('clips').put(rec);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  });
  db.close();
}

async function sendVideo(key) {
  const d = vidDraft;
  if (!d || d.key !== key) return;
  const btn = $('[data-action="vid-send"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  const meta = Object.assign({}, d.meta);
  const trim = { start: +d.a.toFixed(2), end: d.b == null ? null : +d.b.toFixed(2) };
  const id = key + '-' + Date.now();
  try {
    // A replacement retires the earlier clip for this lift, sent or not.
    const prev = videoReq(key);
    if (prev && prev.clipId) { try { await patchClip(prev.clipId, { state: 'replaced', blob: null }); } catch (e) {} }
    await putClip({
      id, key, at: Date.now(), dayId: d.dayId, state: 'pending', offset: 0, uploadUrl: null,
      trim, meta, type: d.file.type || 'video/quicktime', size: d.file.size, name: d.file.name, blob: d.file,
    });
    state.videoReqs[key] = { status: 'sending', at: Date.now(), trim, meta, clipId: id };
    save();
    URL.revokeObjectURL(d.url);
    vidDraft = null;
    vidMsg = '';
    uploadLive[key] = { phase: uploadsReady() ? 'uploading' : 'held', sent: 0, total: d.file.size };
    render();
    processUploads();
  } catch (e) {
    vidMsg = "Couldn't save the clip on this phone. Your draft is still here. Try again.";
    render();
  }
}

document.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-action="vid-send"]');
  if (t) sendVideo(t.getAttribute('data-key'));
});
