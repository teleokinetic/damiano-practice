"""Stand-in for Google, faithful to the parts the app depends on.

Three origins, all different from the app's (so every call is truly cross-origin):
  :9090  script.google.com/macros/s/.../exec   POST → 302 to :9091 (CORS on the 302 too)
  :9091  script.googleusercontent.com          GET  → the JSON the script produced
  :9092  www.googleapis.com/upload/drive/v3     resumable session: PUT chunks, 308 + Range,
                                                bytes */N status checks, CORS bound to the
                                                Origin given when the session was created

Faults are switched on per test through GET :9090/control?...
"""
import hashlib, json, os, socket, sys, threading, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

KEY = 'testkey'
ALLOWED = {'http://localhost:8080'}
Q = 256 * 1024
STORE = sys.argv[1] if len(sys.argv) > 1 else '/tmp/mockdrive'
os.makedirs(STORE, exist_ok=True)

lock = threading.Lock()
replies = {}        # reply id → json
sessions = {}       # upload id → dict
files = {}          # file id → dict
log = []            # every interesting event, for assertions
faults = {}         # name → value


def ev(kind, **kw):
    with lock:
        log.append(dict(kind=kind, **kw))


class Base(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def send(self, code, body=b'', headers=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        self.send_response(code)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def body(self):
        n = int(self.headers.get('Content-Length') or 0)
        return self.rfile.read(n) if n else b''


class Script(BaseHTTPRequestHandler):
    """:9090 — the Apps Script web app."""
    protocol_version = 'HTTP/1.1'
    log_message = Base.log_message
    send = Base.send
    body = Base.body

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == '/control':
            q = {k: v[0] for k, v in parse_qs(u.query, keep_blank_values=True).items()}
            with lock:
                if q.get('reset'):
                    faults.clear(); log.clear()
                for k, v in q.items():
                    if k != 'reset':
                        faults[k] = v
            return self.send(200, {'ok': True, 'faults': faults})
        if u.path == '/state':
            with lock:
                out = {
                    'log': log,
                    'files': {k: {kk: vv for kk, vv in f.items() if kk != 'path'} for k, f in files.items()},
                    'sessions': {k: {kk: vv for kk, vv in s.items() if kk not in ('fh',)} for k, s in sessions.items()},
                }
            return self.send(200, out)
        return self.send(404)

    def do_POST(self):
        raw = self.body()
        # Apps Script answers every POST with a 302 that carries ACAO:*
        if self.headers.get('Content-Type', '').split(';')[0].strip() not in ('text/plain',):
            ev('script-bad-content-type', ct=self.headers.get('Content-Type'))
        with lock:
            down = faults.get('script_down')
        if down:
            return self.send(500, b'<html>Service unavailable</html>', {'Access-Control-Allow-Origin': '*'})
        try:
            req = json.loads(raw or b'{}')
        except Exception:
            req = {}
        out = handle_script(req)
        rid = uuid.uuid4().hex
        with lock:
            replies[rid] = out
        self.send(302, b'', {'Location': f'http://127.0.0.1:9091/echo?r={rid}', 'Access-Control-Allow-Origin': '*'})


def handle_script(req):
    if req.get('key') != KEY:
        ev('script', action=req.get('action'), result='not-authorized')
        return {'ok': False, 'error': 'not-authorized'}
    a = req.get('action')
    if a == 'start':
        origin = req.get('origin')
        if origin not in ALLOWED:
            return {'ok': False, 'error': 'origin-not-allowed'}
        size = int(req.get('size') or 0)
        if size <= 0:
            return {'ok': False, 'error': 'bad-size'}
        if not str(req.get('mimeType', '')).startswith('video/'):
            return {'ok': False, 'error': 'not-a-video'}
        sid = uuid.uuid4().hex
        path = os.path.join(STORE, sid)
        with lock:
            sessions[sid] = {'origin': origin, 'size': size, 'received': 0, 'path': path, 'name': req.get('name'),
                             'description': req.get('description'), 'mime': req.get('mimeType'), 'done': None,
                             'puts': 0}
        open(path, 'wb').close()
        ev('start', sid=sid, size=size, name=req.get('name'))
        return {'ok': True, 'uploadUrl': f'http://127.0.0.1:9092/upload/drive/v3/files?uploadType=resumable&upload_id={sid}'}
    if a == 'done':
        fid = req.get('fileId')
        with lock:
            f = files.get(fid)
        if not f:
            return {'ok': False, 'error': 'no-file'}
        if req.get('expectedSize') and int(req['expectedSize']) != f['size']:
            return {'ok': False, 'error': 'size-mismatch'}
        ev('done', fileId=fid, lift=req.get('lift'), summary=req.get('summary'))
        with lock:
            f['confirmed'] = True
        return {'ok': True, 'url': f'https://drive.google.com/file/d/{fid}/view', 'size': f['size']}
    if a == 'ping':
        return {'ok': True}
    return {'ok': False, 'error': 'unknown-action'}


class Echo(BaseHTTPRequestHandler):
    """:9091 — where Apps Script's redirect lands."""
    protocol_version = 'HTTP/1.1'
    log_message = Base.log_message
    send = Base.send

    def do_GET(self):
        rid = parse_qs(urlparse(self.path).query).get('r', [''])[0]
        with lock:
            out = replies.pop(rid, None)
        if out is None:
            return self.send(404, b'gone', {'Access-Control-Allow-Origin': '*'})
        self.send(200, out, {'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json'})


class Upload(BaseHTTPRequestHandler):
    """:9092 — Drive's resumable upload endpoint."""
    protocol_version = 'HTTP/1.1'
    log_message = Base.log_message
    send = Base.send

    def sess(self):
        sid = parse_qs(urlparse(self.path).query).get('upload_id', [''])[0]
        with lock:
            return sid, sessions.get(sid)

    def cors(self, s):
        o = self.headers.get('Origin')
        h = {}
        if s and o == s['origin']:
            h['Access-Control-Allow-Origin'] = o
            with lock:
                hide = faults.get('hide_range')
            if not hide:
                h['Access-Control-Expose-Headers'] = 'Range, X-GUploader-UploadID'
        return h

    def do_OPTIONS(self):
        sid, s = self.sess()
        h = self.cors(s)
        if h:
            h.update({'Access-Control-Allow-Methods': 'PUT, POST, GET, OPTIONS',
                      'Access-Control-Allow-Headers': 'content-range, content-type, x-upload-content-type',
                      'Access-Control-Max-Age': '600'})
        ev('preflight', sid=sid, ok=bool(h))
        self.send(200, b'', h)

    def range_hdr(self, s):
        return {'Range': f"bytes=0-{s['received'] - 1}"} if s['received'] > 0 else {}

    def do_PUT(self):
        sid, s = self.sess()
        h = self.cors(s)
        n = int(self.headers.get('Content-Length') or 0)
        cr = self.headers.get('Content-Range', '')
        if not s:
            self.rfile.read(n)
            return self.send(404, b'Not Found', h)
        with lock:
            s['puts'] += 1
            expire = faults.get('expire_at_put') and int(faults['expire_at_put']) == s['puts']
            f503 = faults.get('fail503_puts')
            drop = faults.get('drop_at_put') and int(faults['drop_at_put']) == s['puts']
            partial = faults.get('partial_at_put') and int(faults['partial_at_put']) == s['puts']
            for k, hit in (('expire_at_put', expire), ('drop_at_put', drop), ('partial_at_put', partial)):
                if hit:
                    faults.pop(k, None)   # each fault fires once
        if expire:
            self.rfile.read(n)
            with lock:
                sessions.pop(sid, None)
            ev('expired', sid=sid)
            return self.send(404, b'Not Found', h)
        if f503 and int(f503) > 0:
            self.rfile.read(n)
            with lock:
                faults['fail503_puts'] = str(int(f503) - 1)
            ev('503', sid=sid)
            return self.send(503, b'Service Unavailable', h)

        # Status check: bytes */total
        if cr.startswith('bytes */'):
            self.rfile.read(n)
            ev('status', sid=sid, received=s['received'])
            if s['done']:
                return self.send(200, files[s['done']] | {}, h | {'Content-Type': 'application/json'}) if False else \
                    self.send(200, json.dumps({k: v for k, v in files[s['done']].items() if k in ('id', 'name', 'size')}).encode(), h | {'Content-Type': 'application/json'})
            return self.send(308, b'', h | self.range_hdr(s))

        try:
            span, total = cr.replace('bytes ', '').split('/')
            start, end = (int(x) for x in span.split('-'))
            total = int(total)
        except Exception:
            self.rfile.read(n)
            return self.send(400, b'Bad Content-Range', h)
        if total != s['size'] or end - start + 1 != n:
            self.rfile.read(n)
            ev('bad-range', sid=sid, cr=cr, n=n)
            return self.send(400, b'Bad Content-Range', h)
        if start != s['received']:
            self.rfile.read(n)
            ev('offset-mismatch', sid=sid, start=start, have=s['received'])
            return self.send(400, b'Offset mismatch', h)
        final = end == total - 1
        if not final and n % Q:
            self.rfile.read(n)
            ev('not-256k', sid=sid, n=n)
            return self.send(400, b'Chunk not a multiple of 256 KiB', h)

        if drop:
            # Take part of the body, keep whole 256 KiB pieces of it, then cut the line.
            got = self.rfile.read(max(Q, n // 2))
            keep = (len(got) // Q) * Q
            with open(s['path'], 'ab') as fh:
                fh.write(got[:keep])
            with lock:
                s['received'] += keep
            ev('dropped', sid=sid, kept=keep)
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except Exception:
                pass
            self.close_connection = True
            return

        try:
            data = self.rfile.read(n)
        except Exception:
            data = b''
        if len(data) < n:
            # The client went away mid-chunk: like Drive, keep only whole 256 KiB pieces.
            keep = (len(data) // Q) * Q
            with open(s['path'], 'ab') as fh:
                fh.write(data[:keep])
            with lock:
                s['received'] += keep
            ev('client-cut', sid=sid, kept=keep, of=n)
            self.close_connection = True
            return
        if partial and not final:
            keep = max(Q, ((len(data) // 2) // Q) * Q)
            data = data[:keep]
            ev('partial', sid=sid, kept=keep)
        with open(s['path'], 'ab') as fh:
            fh.write(data)
        with lock:
            s['received'] += len(data)
        ev('chunk', sid=sid, start=start, n=len(data))
        if s['received'] < s['size']:
            return self.send(308, b'', h | self.range_hdr(s))
        fid = 'f' + uuid.uuid4().hex[:12]
        sha = hashlib.sha256(open(s['path'], 'rb').read()).hexdigest()
        with lock:
            files[fid] = {'id': fid, 'name': s['name'], 'size': s['received'], 'sha256': sha,
                          'description': s['description'], 'mime': s['mime'], 'path': s['path']}
            s['done'] = fid
        ev('complete', sid=sid, fileId=fid, size=s['received'])
        body = json.dumps({'id': fid, 'name': s['name'], 'size': str(s['received'])}).encode()
        return self.send(200, body, h | {'Content-Type': 'application/json'})


def serve(port, cls):
    srv = ThreadingHTTPServer(('127.0.0.1', port), cls)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()


if __name__ == '__main__':
    serve(9090, Script)
    serve(9091, Echo)
    serve(9092, Upload)
    print('mock google up', flush=True)
    threading.Event().wait()
