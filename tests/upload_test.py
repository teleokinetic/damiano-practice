"""End-to-end upload tests: the real app in Chromium against the Google stand-in."""
import hashlib, json, sys, time, urllib.request
from playwright.sync_api import sync_playwright

SP = sys.argv[1]
ONLY = sys.argv[2:] or None
APP = 'http://localhost:8080/'
MOCK = 'http://127.0.0.1:9090'
MiB = 1024 * 1024


def ctl(**kw):
    q = '&'.join(f'{k}={v}' for k, v in kw.items())
    urllib.request.urlopen(f'{MOCK}/control?{q}').read()


def mstate():
    return json.loads(urllib.request.urlopen(f'{MOCK}/state').read())


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


def drive_cfg(chunk=MiB, key='testkey', backoff=(0.3, 0.6, 1)):
    return ("window.DAMIANO_TEST_DRIVE = " + json.dumps(
        {'endpoint': f'{MOCK}/exec', 'key': key, 'chunk': chunk, 'backoff': list(backoff)}) + ';')


results = []


def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('PASS ' if cond else 'FAIL ') + name + (f'  [{detail}]' if detail else ''), flush=True)


def req_status(pg, key='bench'):
    return pg.evaluate(f"(JSON.parse(localStorage.getItem('damiano-state-v1'))||{{}}).videoReqs?.{key}?.status")


def send_clip(pg, path, key='bench', day='dayA', meta=None):
    pg.goto(f'{APP}#/video/{key}/{day}')
    pg.wait_for_selector('#vidpick', state='attached')
    pg.set_input_files('#vidpick', path)
    pg.wait_for_selector('[data-action="vid-send"]')
    for k, v in (meta or {}).items():
        pg.fill(f'[data-vidmeta="{k}"]', v)
    pg.click('[data-action="vid-send"]')


def wait_received(pg, key='bench', timeout=60000):
    pg.wait_for_function(
        f"(JSON.parse(localStorage.getItem('damiano-state-v1'))||{{}}).videoReqs?.{key}?.status === 'received'",
        timeout=timeout)


def verify_file(name, path, starts=1):
    st = mstate()
    done = [e for e in st['log'] if e['kind'] == 'done']
    comp = [e for e in st['log'] if e['kind'] == 'complete']
    n_starts = len([e for e in st['log'] if e['kind'] == 'start'])
    f = st['files'].get(done[-1]['fileId']) if done else None
    check(f'{name}: script confirmed the file', bool(done))
    check(f'{name}: bytes identical', f and f['sha256'] == sha(path), f and f"{f['size']} bytes")
    check(f'{name}: sessions started == {starts}', n_starts == starts, str(n_starts))
    check(f'{name}: exactly one completed file', len(comp) == 1, str(len(comp)))
    return st, f


def run(name, fn, b):
    if ONLY and name not in ONLY:
        return
    ctl(reset=1)
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
    pg = ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    try:
        fn(ctx, pg)
    except Exception as e:
        check(f'{name}: ran without exceptions', False, repr(e)[:300])
    check(f'{name}: no page errors', not errs, '; '.join(errs)[:300])
    ctx.close()


# ---------------------------------------------------------------- tests

def t_small(ctx, pg):
    ctx.add_init_script(drive_cfg())
    send_clip(pg, f'{SP}/clip.webm', meta={'w': '115', 'r': '8', 'rest': '2:00', 'rir': '2'})
    wait_received(pg)
    st, f = verify_file('small', f'{SP}/clip.webm')
    check('small: file name carries date, lift, load and reps', f and 'Bench press — 115 lb × 8.webm' in f['name'], f and f['name'])
    check('small: description carries the set details', f and 'Rest before: 2:00' in (f['description'] or '') and 'Reps left: 2' in f['description'])
    pg.wait_for_selector('text=Tanner has it', timeout=5000)
    check('small: screen says Tanner has it', True)
    blob_left = pg.evaluate("""new Promise(r => { const q = indexedDB.open('damiano-clips',1); q.onsuccess = () => {
        const g = q.result.transaction('clips').objectStore('clips').getAll(); g.onsuccess = () => r(g.result.map(x => [x.state, !!x.blob])); }; })""")
    check('small: phone copy freed after confirmation', blob_left == [['uploaded', False]], str(blob_left))
    pg.goto(f'{APP}#/day/dayA')
    pg.wait_for_selector('[data-slotcard="a1"]')
    check('small: bench chip gone from session', pg.query_selector('.vidchip[href*="/video/bench/"]') is None)
    pg.goto(APP)
    pg.wait_for_timeout(2600)
    tag = pg.inner_text('.upnext-vid') if pg.query_selector('.upnext-vid') else ''
    check('small: home tag no longer lists bench', 'bench' not in tag, tag)


def t_chunks(ctx, pg):
    ctx.add_init_script(drive_cfg())
    send_clip(pg, f'{SP}/clip20.mov')
    seen = []
    t0 = time.time()
    while time.time() - t0 < 60:
        pct = pg.evaluate("(window.uploadLive && uploadLive.bench) ? uploadLive.bench.sent : -1") if False else \
            pg.evaluate("typeof uploadLive !== 'undefined' && uploadLive.bench ? uploadLive.bench.sent : -1")
        seen.append(pct)
        if req_status(pg) == 'received':
            break
        pg.wait_for_timeout(40)
    verify_file('20 MB / 1 MiB chunks', f'{SP}/clip20.mov')
    mono = all(b >= a for a, b in zip(seen, seen[1:]) if a >= 0 and b >= 0)
    check('20 MB: progress only moves forward', mono)
    chunks = [e for e in mstate()['log'] if e['kind'] == 'chunk']
    check('20 MB: 20 chunks, each 1 MiB', len(chunks) == 20 and all(c['n'] == MiB for c in chunks), str(len(chunks)))


def t_drop(ctx, pg):
    ctx.add_init_script(drive_cfg())
    ctl(drop_at_put=4)
    send_clip(pg, f'{SP}/clip20.mov')
    wait_received(pg)
    verify_file('dropped connection mid-chunk', f'{SP}/clip20.mov')
    kinds = [e['kind'] for e in mstate()['log']]
    check('drop: asked Drive where it stopped before resuming', 'status' in kinds[kinds.index('dropped'):])
    # Chromium itself may resend a PUT cut on a reused connection; Drive then
    # disagrees about the offset. What matters is the app asks and recovers.
    if 'offset-mismatch' in kinds:
        i = kinds.index('offset-mismatch')
        check('drop: after an offset disagreement, asked Drive and recovered', 'status' in kinds[i:i + 3])


def t_503(ctx, pg):
    ctx.add_init_script(drive_cfg())
    ctl(fail503_puts=3)
    send_clip(pg, f'{SP}/clip20.mov')
    wait_received(pg)
    verify_file('three 503s', f'{SP}/clip20.mov')


def t_partial(ctx, pg):
    ctx.add_init_script(drive_cfg())
    ctl(partial_at_put=3)
    send_clip(pg, f'{SP}/clip20.mov')
    wait_received(pg)
    verify_file('Drive keeps only part of a chunk', f'{SP}/clip20.mov')
    kinds = [e['kind'] for e in mstate()['log']]
    check('partial: followed Drive\'s Range, no mismatches', 'offset-mismatch' not in kinds)


def t_expire(ctx, pg):
    ctx.add_init_script(drive_cfg())
    ctl(expire_at_put=5)
    send_clip(pg, f'{SP}/clip20.mov')
    wait_received(pg)
    verify_file('session expires mid-upload', f'{SP}/clip20.mov', starts=2)


def t_hidden_range(ctx, pg):
    ctx.add_init_script(drive_cfg())
    ctl(hide_range=1)
    send_clip(pg, f'{SP}/clip20.mov')
    wait_received(pg)
    verify_file('Range header not readable', f'{SP}/clip20.mov')


def t_hidden_range_drop(ctx, pg):
    ctx.add_init_script(drive_cfg())
    ctl(hide_range=1, drop_at_put=4)
    send_clip(pg, f'{SP}/clip20.mov')
    wait_received(pg)
    verify_file('Range unreadable + dropped connection (falls back to a fresh session)', f'{SP}/clip20.mov', starts=2)


def t_reload(ctx, pg):
    ctx.add_init_script(drive_cfg(backoff=(3, 3, 3)))
    send_clip(pg, f'{SP}/clip20.mov')
    pg.wait_for_function("typeof uploadLive !== 'undefined' && uploadLive.bench && uploadLive.bench.sent > 8*1024*1024", timeout=30000)
    pg.reload()                       # app closed and reopened mid-upload
    pg.wait_for_selector('[data-upstatus="bench"]', timeout=10000)
    wait_received(pg)
    st, f = verify_file('app reopened mid-upload', f'{SP}/clip20.mov')
    chunks = [e for e in st['log'] if e['kind'] == 'chunk']
    check('reload: resumed, did not resend from zero', sum(c['n'] for c in chunks) < 20 * MiB + 2 * MiB,
          f"{sum(c['n'] for c in chunks) / MiB:.1f} MiB sent")


def t_offline(ctx, pg):
    ctx.add_init_script(drive_cfg(backoff=(0.5, 0.5, 0.5)))
    pg.goto(APP)
    ctx.set_offline(True)
    send_clip(pg, f'{SP}/clip.webm')
    pg.wait_for_timeout(1500)
    txt = pg.inner_text('[data-upstatus="bench"]')
    check('offline: says it is waiting for a connection', 'Waiting for a connection' in txt, txt.replace('\n', ' | '))
    check('offline: still sending, not received', req_status(pg) == 'sending')
    ctx.set_offline(False)
    pg.evaluate("window.dispatchEvent(new Event('online'))")
    wait_received(pg)
    verify_file('offline then back online', f'{SP}/clip.webm')


def t_script_down(ctx, pg):
    ctx.add_init_script(drive_cfg(backoff=(0.5, 0.5, 0.5)))
    ctl(script_down=1)
    send_clip(pg, f'{SP}/clip.webm')
    pg.wait_for_timeout(1500)
    check('script down: waiting, not failed', 'Waiting' in pg.inner_text('[data-upstatus="bench"]'))
    ctl(script_down='')
    wait_received(pg)
    verify_file('script briefly down', f'{SP}/clip.webm')


def t_bad_key(ctx, pg):
    ctx.add_init_script(drive_cfg(key='wrong'))
    send_clip(pg, f'{SP}/clip.webm')
    pg.wait_for_selector('text=This one didn’t go through', timeout=10000)
    check('bad key: shows it did not go through, with Try again', pg.query_selector('[data-action="up-retry"]') is not None)
    kept = pg.evaluate("""new Promise(r => { const q = indexedDB.open('damiano-clips',1); q.onsuccess = () => {
        const g = q.result.transaction('clips').objectStore('clips').getAll(); g.onsuccess = () => r(g.result.map(x => [x.state, !!x.blob])); }; })""")
    check('bad key: video kept on the phone', kept == [['failed', True]], str(kept))
    pg.evaluate("window.DAMIANO_TEST_DRIVE.key = 'testkey'")
    pg.click('[data-action="up-retry"]')
    wait_received(pg)
    verify_file('bad key, fixed, Try again', f'{SP}/clip.webm')


def t_unconfigured(ctx, pg):
    send_clip(pg, f'{SP}/clip.webm')   # no endpoint: the shipping config before setup
    pg.wait_for_timeout(800)
    txt = pg.inner_text('[data-upstatus="bench"]')
    check('not set up: says saved on this phone', 'Saved on this phone' in txt, txt.replace('\n', ' | '))
    check('not set up: nothing reached the mock', not [e for e in mstate()['log'] if e['kind'] == 'start'])
    # Turning uploads on later sends it without him doing anything.
    ctx.add_init_script(drive_cfg(backoff=(0.3,)))
    pg.reload()
    wait_received(pg)
    verify_file('saved before setup, sent after', f'{SP}/clip.webm')


def t_in_session(ctx, pg):
    """Upload finishes while he's mid-session with a drawer open: nothing jumps."""
    ctx.add_init_script(drive_cfg(chunk=MiB))
    send_clip(pg, f'{SP}/clip20.mov', key='splitsquat')
    pg.goto(f'{APP}#/day/dayA')
    pg.click('.slot-main[data-slot="a4"]')
    pg.evaluate("window.scrollTo(0, 400)")
    y0 = pg.evaluate("scrollY")
    wait_received(pg, key='splitsquat')
    pg.wait_for_timeout(300)
    check('in session: scroll position kept', pg.evaluate("scrollY") == y0, f"{y0} → {pg.evaluate('scrollY')}")
    check('in session: drawer still open', pg.eval_on_selector('[data-drawer="a4"]', 'e => !e.classList.contains("hidden")'))
    check('in session: split-squat chip removed in place', pg.query_selector('.vidchip[href*="/video/splitsquat/"]') is None)
    check('in session: bench chip still there', pg.query_selector('.vidchip[href*="/video/bench/"]') is not None)
    verify_file('upload during a session', f'{SP}/clip20.mov')


def t_big(ctx, pg):
    ctx.add_init_script(drive_cfg(chunk=8 * MiB))
    t0 = time.time()
    send_clip(pg, f'{SP}/clip150.mov')
    wait_received(pg, timeout=240000)
    st, f = verify_file('150 MB in real 8 MiB chunks', f'{SP}/clip150.mov')
    chunks = [e for e in st['log'] if e['kind'] == 'chunk']
    check('150 MB: 19 chunks of 8 MiB (last smaller)', len(chunks) == 19 and all(c['n'] == 8 * MiB for c in chunks[:-1]),
          f'{len(chunks)} chunks in {time.time() - t0:.0f}s')


TESTS = [('small', t_small), ('chunks', t_chunks), ('drop', t_drop), ('503', t_503), ('partial', t_partial),
         ('expire', t_expire), ('hidden_range', t_hidden_range), ('hidden_range_drop', t_hidden_range_drop),
         ('reload', t_reload), ('offline', t_offline), ('script_down', t_script_down), ('bad_key', t_bad_key),
         ('unconfigured', t_unconfigured), ('in_session', t_in_session), ('big', t_big)]

with sync_playwright() as p:
    b = p.chromium.launch()
    for name, fn in TESTS:
        print(f'--- {name}', flush=True)
        run(name, fn, b)
    b.close()

fails = [r for r in results if not r[1]]
print(f'\n{len(results) - len(fails)} passed, {len(fails)} failed')
for f in fails:
    print('  FAIL', f[0], f[2])
