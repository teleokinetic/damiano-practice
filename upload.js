/* Damiano's Practice — sending filmed sets to Tanner's Google Drive.

   1. The app asks Tanner's Apps Script for an upload session (a small JSON
      POST; the script creates a resumable Drive upload bound to this origin).
   2. The phone sends the clip straight to Drive in 8 MB chunks. Each chunk
      that lands moves a saved offset forward, so a dropped connection, a
      locked phone or a closed app picks up where it stopped.
   3. When Drive confirms the whole file, the app tells the script (which
      checks the size and emails Tanner a link) and only then marks the
      request received and frees the copy on the phone.

   Clips wait in IndexedDB ('damiano-clips') until step 3. Nothing here is
   needed for logging workouts; it only runs when there's a clip to send. */

const UPLOAD_CHUNK = 8 * 1024 * 1024;              // multiple of 256 KiB, as Drive requires
const UPLOAD_BACKOFF = [2, 5, 15, 30, 60, 120];      // seconds between automatic retries
const FATAL_ERRORS = ['not-authorized', 'origin-not-allowed', 'bad-size', 'not-a-video', 'wrong-folder', 'size-mismatch'];

function driveCfg() {
  const t = window.DAMIANO_TEST_DRIVE;
  const c = t || (typeof DRIVE_CONFIG !== 'undefined' ? DRIVE_CONFIG : {});
  return {
    endpoint: c.endpoint || '',
    key: c.key || '',
    chunk: (t && t.chunk) || UPLOAD_CHUNK,
    backoff: (t && t.backoff) || UPLOAD_BACKOFF,
  };
}
function uploadsReady() { return !!driveCfg().endpoint; }

// Live progress per request key, for the screens; persisted state lives in the clip record.
const uploadLive = {};   // key → { phase, sent, total, error }
function setLive(key, patch) {
  uploadLive[key] = Object.assign(uploadLive[key] || {}, patch);
  paintUploadStatus(key);
}

/* ---- clip store ---- */

async function clipTx(mode, fn) {
  const db = await clipDB();
  try {
    return await new Promise((res, rej) => {
      const tx = db.transaction('clips', mode);
      const store = tx.objectStore('clips');
      let out;
      Promise.resolve(fn(store)).then((v) => { out = v; });
      tx.oncomplete = () => res(out);
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
  } finally { db.close(); }
}
function reqP(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function allClips() { return clipTx('readonly', (s) => reqP(s.getAll())); }
async function getClip(id) { return clipTx('readonly', (s) => reqP(s.get(id))); }
async function patchClip(id, patch) {
  return clipTx('readwrite', async (s) => {
    const cur = await reqP(s.get(id));
    if (!cur) return null;
    const next = Object.assign(cur, patch);
    s.put(next);
    return next;
  });
}

/* ---- talking to the script ---- */

async function callScript(body) {
  const cfg = driveCfg();
  let res;
  try {
    // text/plain keeps this a "simple" request: no preflight, which Apps Script can't answer.
    res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ key: cfg.key }, body)),
      redirect: 'follow',
    });
  } catch (e) {
    const err = new Error('offline'); err.retry = true; throw err;
  }
  if (!res.ok) { const err = new Error('script-' + res.status); err.retry = true; throw err; }
  let j;
  try { j = await res.json(); } catch (e) { const err = new Error('script-bad-reply'); err.retry = true; throw err; }
  if (!j || !j.ok) {
    const err = new Error((j && j.error) || 'script-failed');
    err.fatal = FATAL_ERRORS.includes(err.message);
    err.retry = !err.fatal;
    throw err;
  }
  return j;
}

/* ---- one PUT to the upload session ---- */

function putRange(url, blob, start, total, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    if (blob) xhr.setRequestHeader('Content-Range', `bytes ${start}-${start + blob.size - 1}/${total}`);
    else xhr.setRequestHeader('Content-Range', `bytes */${total}`);
    xhr.timeout = 180000;
    if (blob && onProgress) xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) onProgress(ev.loaded); };
    xhr.onload = () => resolve({ status: xhr.status, range: xhr.getResponseHeader('Range'), text: xhr.responseText });
    xhr.onerror = () => { const e = new Error('network'); e.retry = true; reject(e); };
    xhr.ontimeout = () => { const e = new Error('timeout'); e.retry = true; reject(e); };
    xhr.onabort = () => { const e = new Error('aborted'); e.retry = true; reject(e); };
    xhr.send(blob || null);
  });
}

// "bytes=0-1048575" → 1048576 (the next byte Drive wants).
function nextFromRange(range) {
  const m = /bytes=(\d+)-(\d+)/.exec(range || '');
  return m ? parseInt(m[2], 10) + 1 : null;
}

function parseDone(text) {
  try { const j = JSON.parse(text); return j && j.id ? j : null; } catch (e) { return null; }
}

// Ask Drive how much it has. Returns { offset } or { done }.
async function querySession(rec) {
  const r = await putRange(rec.uploadUrl, null, 0, rec.size);
  if (r.status === 200 || r.status === 201) return { done: parseDone(r.text) };
  if (r.status === 308) {
    const n = nextFromRange(r.range);
    // No Range header means Drive has nothing yet; trust our own saved
    // offset only if the header could not be read at all.
    const blind = n == null && rec.offset > 0;
    return { offset: n != null ? n : blind ? rec.offset : 0, blind };
  }
  if (r.status === 404 || r.status === 410) return { expired: true };
  const e = new Error('status-' + r.status); e.retry = true; throw e;
}

/* ---- naming the file ---- */

function clipFileName(rec) {
  const lift = VIDEO_LIFTS[rec.key] ? VIDEO_LIFTS[rec.key].name : rec.key;
  const d = new Date(rec.at);
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const m = rec.meta || {};
  const unit = (state && state.settings && state.settings.unit) || 'lb';
  const set = [m.w ? `${m.w} ${unit}` : '', m.r ? `× ${m.r}` : ''].filter(Boolean).join(' ');
  const ext = (/\.([a-z0-9]{2,4})$/i.exec(rec.name || '') || [])[1] || (/mp4/.test(rec.type) ? 'mp4' : /webm/.test(rec.type) ? 'webm' : 'mov');
  return `${ymd} ${lift}${set ? ' — ' + set : ''}.${ext.toLowerCase()}`;
}

function clipSummary(rec) {
  const m = rec.meta || {};
  const unit = (state && state.settings && state.settings.unit) || 'lb';
  const lines = [];
  if (m.w) lines.push(`Load: ${m.w} ${unit}`);
  if (m.r) lines.push(`Reps: ${m.r}`);
  if (m.rest) lines.push(`Rest before: ${m.rest}`);
  if (m.rir) lines.push(`Reps left: ${m.rir}`);
  if (rec.trim && (rec.trim.start > 0 || rec.trim.end != null)) {
    lines.push(`Trim: ${fmtClock(rec.trim.start || 0)}–${rec.trim.end == null ? 'end' : fmtClock(rec.trim.end)}`);
  }
  const day = rec.dayId && findDay(rec.dayId);
  if (day) lines.push(`Session: ${day.name}`);
  lines.push(`Filmed: ${new Date(rec.at).toLocaleString()}`);
  return lines.join('\n');
}

/* ---- the upload itself ---- */

async function uploadOne(rec) {
  const cfg = driveCfg();
  const key = rec.key;
  if (!rec.blob) throw Object.assign(new Error('clip-missing'), { fatal: true });
  setLive(key, { phase: 'uploading', sent: rec.offset || 0, total: rec.size, error: '' });

  let restarts = 0;
  for (;;) {
    if (!rec.uploadUrl) {
      const j = await callScript({
        action: 'start', origin: location.origin, size: rec.size,
        mimeType: rec.type || 'video/quicktime', name: clipFileName(rec), description: clipSummary(rec),
      });
      rec = await patchClip(rec.id, { uploadUrl: j.uploadUrl, offset: 0, sessionAt: Date.now() });
    } else if (rec.offset > 0 || rec.state === 'waiting') {
      const q = await querySession(rec);
      if (q.expired) {
        if (++restarts > 2) throw Object.assign(new Error('session-expired'), { retry: true });
        rec = await patchClip(rec.id, { uploadUrl: null, offset: 0 });
        continue;
      }
      if (q.done) { rec = await patchClip(rec.id, { fileId: q.done.id, offset: rec.size }); break; }
      if (q.offset !== rec.offset) rec = await patchClip(rec.id, { offset: q.offset });
    }

    let mismatch = 0;
    let done = null;
    let expired = false;
    while (rec.offset < rec.size) {
      const start = rec.offset;
      const slice = rec.blob.slice(start, Math.min(start + cfg.chunk, rec.size));
      const r = await putRange(rec.uploadUrl, slice, start, rec.size,
        (loaded) => setLive(key, { phase: 'uploading', sent: start + loaded, total: rec.size }));
      if (r.status === 308) {
        const n = nextFromRange(r.range);
        rec = await patchClip(rec.id, { offset: n != null ? n : start + slice.size, state: 'uploading' });
        setLive(key, { sent: rec.offset });
        mismatch = 0;
        continue;
      }
      if (r.status === 200 || r.status === 201) {
        done = parseDone(r.text);
        if (!done) throw Object.assign(new Error('drive-bad-reply'), { retry: true });
        rec = await patchClip(rec.id, { fileId: done.id, offset: rec.size });
        break;
      }
      if (r.status === 404 || r.status === 410) { expired = true; break; }
      if (r.status >= 500 || r.status === 429 || r.status === 0) {
        throw Object.assign(new Error('drive-' + r.status), { retry: true, needsStatus: true });
      }
      // Any other 4xx: we and Drive disagree about the offset. Ask, then carry on.
      if (++mismatch > 3) throw Object.assign(new Error('drive-' + r.status), { retry: true, needsStatus: true });
      const q = await querySession(rec);
      if (q.expired) { expired = true; break; }
      if (q.done) { rec = await patchClip(rec.id, { fileId: q.done.id, offset: rec.size }); break; }
      // Drive won't say where it is and won't take our guess: start a fresh
      // session rather than stall. Costs a resend, never a broken file.
      if (q.blind && mismatch >= 2) { expired = true; break; }
      rec = await patchClip(rec.id, { offset: q.offset });
    }
    if (expired) {
      if (++restarts > 2) throw Object.assign(new Error('session-expired'), { retry: true });
      rec = await patchClip(rec.id, { uploadUrl: null, offset: 0 });
      continue;
    }
    break;
  }

  // Drive has every byte. Confirm with the script before calling it received.
  setLive(key, { phase: 'confirming', sent: rec.size, total: rec.size });
  const lift = VIDEO_LIFTS[key] ? VIDEO_LIFTS[key].name : key;
  const conf = await callScript({ action: 'done', fileId: rec.fileId, expectedSize: rec.size, lift, summary: clipSummary(rec) });
  await patchClip(rec.id, { state: 'uploaded', blob: null, doneAt: Date.now(), driveUrl: conf.url || '' });
  if (state.videoReqs[key] && state.videoReqs[key].clipId === rec.id) {
    state.videoReqs[key] = Object.assign({}, state.videoReqs[key], { status: 'received', receivedAt: Date.now() });
    save();
  }
  setLive(key, { phase: 'received', error: '' });
  refreshVideoMarks(key);
}

/* ---- the queue ---- */

let uploadRunning = false;
let uploadTimer = null;
let uploadAttempt = 0;

async function processUploads() {
  if (uploadRunning || !uploadsReady()) return;
  if (typeof indexedDB === 'undefined') return;
  uploadRunning = true;
  clearTimeout(uploadTimer);
  let retryLater = false;
  try {
    const recs = (await allClips())
      .filter((r) => r.state !== 'uploaded' && r.state !== 'failed' && r.state !== 'replaced')
      .sort((a, b) => a.at - b.at);
    if (recs.length) requestWakeLock();
    for (const rec of recs) {
      try {
        await uploadOne(rec);
        uploadAttempt = 0;
      } catch (e) {
        if (e.fatal) {
          await patchClip(rec.id, { state: 'failed', error: e.message });
          setLive(rec.key, { phase: 'failed', error: e.message });
        } else {
          await patchClip(rec.id, { state: 'waiting', error: e.message });
          setLive(rec.key, { phase: 'waiting', error: e.message });
          retryLater = true;
          break;   // keep order: retry this one before the next
        }
      }
    }
  } catch (e) {
    retryLater = true;
  } finally {
    uploadRunning = false;
    if (!rest.running) releaseWakeLock();
  }
  if (retryLater) {
    const cfg = driveCfg();
    const wait = cfg.backoff[Math.min(uploadAttempt, cfg.backoff.length - 1)];
    uploadAttempt++;
    uploadTimer = setTimeout(processUploads, wait * 1000);
  }
}

// Wake the queue whenever there's a reason to think it can move.
window.addEventListener('online', () => { uploadAttempt = 0; processUploads(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) processUploads(); });

// Restore the live view of anything still waiting from an earlier visit.
async function restoreUploadStatus() {
  if (typeof indexedDB === 'undefined') return;
  try {
    for (const r of await allClips()) {
      if (r.state === 'uploaded' || r.state === 'replaced') continue;
      const req = state.videoReqs && state.videoReqs[r.key];
      if (!req || req.clipId !== r.id) continue;
      uploadLive[r.key] = {
        phase: r.state === 'failed' ? 'failed' : uploadsReady() ? 'waiting' : 'held',
        sent: r.offset || 0, total: r.size, error: r.error || '',
      };
    }
  } catch (e) { /* the view falls back to its own wording */ }
}

/* ---- what the screens show ---- */

function fmtMB(n) { return (n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0); }

function uploadStatusHTML(key) {
  const req = videoReq(key) || {};
  const live = uploadLive[key] || {};
  if (req.status === 'received' || live.phase === 'received') {
    return `<div class="up up-done">
      <span class="vid-done-mark">${earMini()}</span>
      <div class="vid-done-line">Tanner has it</div>
      <div class="vid-done-sub">Saved to his Google Drive.</div></div>`;
  }
  if (!uploadsReady() || live.phase === 'held') {
    return `<div class="up">
      <div class="vid-done-line">Saved on this phone</div>
      <div class="vid-done-sub">It goes to Tanner as soon as uploads are switched on.</div></div>`;
  }
  if (live.phase === 'failed') {
    return `<div class="up">
      <div class="vid-done-line">This one didn’t go through</div>
      <div class="vid-done-sub">The video is still on your phone. Try again, or send Tanner a bug note.</div>
      <button class="vidbtn up-retry" data-action="up-retry" data-key="${key}">Try again</button></div>`;
  }
  const total = live.total || 0;
  const sent = Math.min(live.sent || 0, total);
  const pct = total ? Math.floor((sent / total) * 100) : 0;
  const waiting = live.phase === 'waiting';
  const confirming = live.phase === 'confirming';
  return `<div class="up">
    <div class="vid-done-line">${waiting ? 'Waiting for a connection' : confirming ? 'Almost there' : 'Sending to Tanner'}</div>
    <div class="up-bar"><i style="width:${confirming ? 100 : pct}%"></i></div>
    <div class="up-meta"><span>${confirming ? 'Checking it arrived' : `${pct}%`}</span><span>${total ? `${fmtMB(sent)} of ${fmtMB(total)} MB` : ''}</span></div>
    <div class="vid-done-sub">${waiting ? 'It picks up where it stopped on its own.' : 'Keep the app open until it finishes.'}</div></div>`;
}

function paintUploadStatus(key) {
  const el = document.querySelector(`[data-upstatus="${key}"]`);
  if (el) el.innerHTML = uploadStatusHTML(key);
}

// Repaint only what shows this request, in place: a full render would throw
// him back to the top of his session and close the drawer he's in.
function refreshVideoMarks(key) {
  const received = videoReq(key) && videoReq(key).status === 'received';
  if (received) document.querySelectorAll(`.vidchip[href*="/video/${key}/"]`).forEach((el) => el.remove());
  const parts = (location.hash || '').replace(/^#\//, '').split('/');
  if (parts[0] === 'video' && parts[1] === key) {
    if (received) render(); else paintUploadStatus(key);
  }
}

document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-action="up-retry"]');
  if (!t) return;
  const key = t.getAttribute('data-key');
  const req = videoReq(key);
  if (!req || !req.clipId) return;
  await patchClip(req.clipId, { state: 'waiting', error: '' });
  setLive(key, { phase: 'waiting', error: '' });
  uploadAttempt = 0;
  processUploads();
});

// Loaded before app.js (its screens call in here); start once the app is up.
document.addEventListener('DOMContentLoaded', () => {
  restoreUploadStatus().then(() => {
    const parts = (location.hash || '').replace(/^#\//, '').split('/');
    if (parts[0] === 'video') paintUploadStatus(parts[1]);
    processUploads();
  });
});
