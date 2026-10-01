/* Damiano's Practice — "Something off?" button.
   One small button stays in the corner on every screen. It opens a short
   note that goes to Tanner's inbox (the same FormSubmit box as Joe's app),
   with where he was and what the app was doing attached automatically.
   Offline, the note waits on the phone and sends itself later. */

const REPORT_ENDPOINT = 'https://formsubmit.co/ajax/e5140376f99018c5113aaaa81b550434';
const REPORT_QUEUE_KEY = 'damiano-reports-v1';

// The last few script errors, so a report carries them without him knowing.
const recentErrors = [];
window.addEventListener('error', (e) => {
  recentErrors.push(`${new Date().toISOString()} ${e.message} @ ${(e.filename || '').split('/').pop()}:${e.lineno}`);
  if (recentErrors.length > 5) recentErrors.shift();
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  recentErrors.push(`${new Date().toISOString()} ${r && r.message ? r.message : String(r)}`);
  if (recentErrors.length > 5) recentErrors.shift();
});

// Where he is, in the words he'd use: "Strength A · Bench press".
function reportWhere() {
  const parts = (location.hash || '#/').replace(/^#\//, '').split('/');
  let where = 'Home';
  try {
    if (parts[0] === 'day') {
      const day = findDay(parts[1]);
      where = day ? day.name : 'Session';
      const slot = day && currentSlotId ? findSlot(day, currentSlotId) : null;
      if (slot) where += ' · ' + slot.name;
    } else if (parts[0] === 'finish') {
      const day = findDay(parts[1]);
      where = (day ? day.name : 'Session') + ' · finish';
    } else if (parts[0] === 'video') {
      const lift = VIDEO_LIFTS[parts[1]];
      where = 'Video · ' + (lift ? lift.name : parts[1]);
    } else if (parts[0] === 'settings' || parts[0] === 'import') {
      where = 'Settings';
    }
  } catch (e) { /* the label is a nicety; never block a report on it */ }
  return where;
}

// What the app was doing: the open session in plain lines.
function reportSessionLines() {
  const a = state && state.active;
  if (!a) return 'No session open';
  const day = findDay(a.dayId);
  if (!day) return 'Open session for an unknown day';
  const mins = Math.round((Date.now() - a.startedAt) / 60000);
  const lines = [`${day.name}, open ${mins} min`];
  for (const slot of day.slots) {
    const e = a.entries[slot.id];
    if (!e) continue;
    const bits = [];
    if (e.sets) bits.push(`${e.sets} set${e.sets > 1 ? 's' : ''}`);
    if (e.done) bits.push('done');
    if (e.log && e.log.length) bits.push(e.log.map((x) => `${x.w == null ? '' : x.w + '×'}${x.r == null ? '—' : x.r}`).join(', '));
    if (e.note) bits.push(`note: ${e.note}`);
    if (bits.length) lines.push(`  ${slot.name}: ${bits.join(' · ')}`);
  }
  return lines.join('\n');
}

function reportQueue() {
  try { return JSON.parse(localStorage.getItem(REPORT_QUEUE_KEY) || '[]') || []; } catch (e) { return []; }
}
function setReportQueue(q) {
  try { localStorage.setItem(REPORT_QUEUE_KEY, JSON.stringify(q)); } catch (e) {}
}

async function postReport(r) {
  const body = {
    _subject: `Damiano's Practice — ${r.where}`,
    _template: 'box',
    client: 'Damiano',
    problem: r.text,
    where: r.where,
    when: new Date(r.at).toLocaleString(),
    session: r.session,
    errors: r.errors || 'none',
    app: `v${r.version}`,
    device: r.device,
  };
  const res = await fetch(REPORT_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json().catch(() => ({}));
  if (j && (j.success === false || j.success === 'false')) throw new Error(j.message || 'not accepted');
}

let flushing = false;
async function flushReports() {
  if (flushing) return;
  const q = reportQueue();
  if (!q.length) return;
  flushing = true;
  const left = [];
  for (const r of q) {
    try { await postReport(r); } catch (e) { left.push(r); }
  }
  setReportQueue(left);
  flushing = false;
}
window.addEventListener('online', () => { flushReports(); });

/* ---- the button and the sheet (outside #app, so renders never touch them) ---- */

function mountReport() {
  if (document.getElementById('rp-fab')) return;
  const fab = document.createElement('button');
  fab.id = 'rp-fab';
  fab.className = 'rp-fab';
  fab.setAttribute('aria-label', 'Report a bug');
  fab.setAttribute('aria-haspopup', 'dialog');
  fab.innerHTML = `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 17h-8l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5z"/>
    <path d="M12 8.6v3.6"/><path d="M12 14.6v.1" stroke-width="2.6"/></svg>`;

  const scrim = document.createElement('div');
  scrim.className = 'rp-scrim hidden';
  const sheet = document.createElement('div');
  sheet.className = 'rp-sheet hidden';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-labelledby', 'rp-title');
  sheet.innerHTML = `
    <div class="rp-head">
      <div id="rp-title" class="rp-title">Did you find a bug?</div>
      <div class="rp-where" data-rpwhere></div>
    </div>
    <textarea id="rp-text" rows="4" placeholder="Tell me about it and I’ll get it fixed ASAP."></textarea>
    <div class="rp-status" data-rpstatus aria-live="polite"></div>
    <div class="rp-actions">
      <button class="rp-btn" data-rp="cancel">Cancel</button>
      <button class="rp-btn solid" data-rp="send">Send to Tanner</button>
    </div>`;
  document.body.appendChild(fab);
  document.body.appendChild(scrim);
  document.body.appendChild(sheet);

  const ta = sheet.querySelector('#rp-text');
  const status = sheet.querySelector('[data-rpstatus]');
  let where = '';
  const open = (on) => {
    sheet.classList.toggle('hidden', !on);
    scrim.classList.toggle('hidden', !on);
    fab.setAttribute('aria-expanded', on ? 'true' : 'false');
    if (on) {
      where = reportWhere();
      sheet.querySelector('[data-rpwhere]').textContent = where;
      status.textContent = '';
      setTimeout(() => ta.focus(), 30);
    }
  };
  fab.addEventListener('click', () => open(sheet.classList.contains('hidden')));
  scrim.addEventListener('click', () => open(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.classList.contains('hidden')) open(false); });
  sheet.querySelector('[data-rp="cancel"]').addEventListener('click', () => open(false));
  sheet.querySelector('[data-rp="send"]').addEventListener('click', async (ev) => {
    const text = ta.value.trim();
    if (!text) { status.textContent = 'Add a few words first.'; ta.focus(); return; }
    const btn = ev.currentTarget;
    const r = {
      text, where, at: Date.now(), version: APP_VERSION,
      session: reportSessionLines(), errors: recentErrors.join('\n'), device: navigator.userAgent,
    };
    btn.disabled = true;
    status.textContent = 'Sending…';
    try {
      await postReport(r);
      ta.value = '';
      open(false);
      toast('Sent to Tanner');
    } catch (e) {
      const q = reportQueue(); q.push(r); setReportQueue(q);
      ta.value = '';
      open(false);
      toast(navigator.onLine === false ? 'Saved. It sends when you’re back online.' : 'Saved. It sends on the next try.');
    }
    btn.disabled = false;
  });
}

mountReport();
setTimeout(flushReports, 1500);
