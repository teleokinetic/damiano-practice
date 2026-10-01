/* Damiano — offline shell.
   Bump CACHE when shipping changes so clients pick up the new version. */

const CACHE = 'damiano-v1.2.0';
// Critical shell is all-or-nothing; fonts/icons are best-effort so one
// flaky request on gym wifi can't silently sink the whole update.
const CRITICAL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'seed.js',
  'config.js',
  'video.js',
  'upload.js',
  'report.js',
  'manifest.webmanifest',
];
const EXTRAS = [
  'fonts/barlow-condensed-500.woff2',
  'fonts/barlow-condensed-600.woff2',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

// cache: 'reload' skips the browser's HTTP cache. GitHub Pages serves
// max-age=600, so without it an update opened within ten minutes of a push
// could store the OLD app.js under the NEW cache name and stay stuck on it.
const fresh = (u) => new Request(u, { cache: 'reload' });

// Caches are shared across every app on this origin (all of
// teleokinetic.github.io), so this one only ever clears its own.
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then(async (c) => {
        await c.addAll(CRITICAL.map(fresh));
        await Promise.allSettled(EXTRAS.map((u) => c.add(fresh(u))));
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('damiano-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first for navigations (so updates land), cache-first for assets.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // Other sites pass straight through (uploads, the Drive script, bug notes);
  // only their images (the framing references) are kept for offline.
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin && e.request.destination !== 'image') return;
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html')))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }))
  );
});
