# Upload tests

Runs the real app in headless Chromium against `mock_google.py`, a stand-in for Apps Script and Drive's resumable upload endpoint (three separate origins, CORS as Google does it, 256 KiB chunk rules, `308` + `Range`, `bytes */N` status checks).

```
python3 -m http.server 8080                 # from the repo root
python3 tests/mock_google.py /tmp/mockdrive # second terminal
# test clips: clip.webm (small), clip20.mov (20 MB), clip150.mov (150 MB) in one folder
python3 tests/upload_test.py /path/to/clips [test names…]
```

Covers: small and 150 MB clips, a connection cut mid-chunk, repeated 503s, Drive keeping only part of a chunk, an expired session, an unreadable `Range` header (with and without a dropped connection), the app reopened mid-upload, offline then online, the script briefly down, a wrong key then *Try again*, clips saved before uploads were set up, and an upload finishing mid-session. Every case checks the file in the mock Drive is byte-identical to the original.
