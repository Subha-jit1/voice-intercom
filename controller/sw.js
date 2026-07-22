/**
 * Service worker.
 *
 * Caches the app shell so the controller opens instantly and survives a brief
 * network drop. It never caches /api or /ws - stale diagnostics would be worse
 * than no diagnostics, and a cached auth response would be a security bug.
 */

// Bump on any change to SHELL. The activate handler deletes every other cache,
// so an installed app picks up the new shell rather than serving a stale one.
const CACHE = 'voice-intercom-v2';

const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'connection.js',
  'mic.js',
  'receivers.js',
  'ptt-processor.js',
  'manifest.webmanifest',
  'icon.svg',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // addAll is all-or-nothing: one missing file aborts the install and the
      // app silently loses offline support. Cache entries individually so a
      // single absent icon cannot take the whole shell down with it.
      .then((cache) =>
        Promise.all(
          SHELL.map((path) =>
            cache.add(path).catch((err) => {
              console.warn(`[sw] could not cache ${path}:`, err.message);
            })
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.pathname.startsWith('/api') || url.pathname === '/ws') return;
  if (url.origin !== self.location.origin) return;

  // Network first, falling back to cache. The receiver is normally a few
  // milliseconds away over Tailscale, so freshness costs nothing, and the
  // cache is there purely for the moments it is unreachable.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then((hit) => hit ?? caches.match('index.html')))
  );
});
