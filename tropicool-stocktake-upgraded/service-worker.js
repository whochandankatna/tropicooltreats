/**
 * App-shell service worker (Priority 11). The app shell (HTML/CSS/JS)
 * precaches on install so the app still LAUNCHES and is fully usable
 * offline — that holds regardless of which data backend is active
 * (config.js's SUPABASE_URL). What differs is what "usable" means once
 * launched: in mock mode (SUPABASE_URL blank) all data is in-memory, so a
 * fully offline session works end to end; once pointed at a real Supabase
 * project, data reads/writes need network same as any real backend, and
 * Phase 11's draft/queue/conflict handling in stocktake.js is what carries
 * counting specifically through a real connectivity drop — this service
 * worker only ever covers the shell loading, never the data behind it.
 *
 * js/vendor/supabase-js.esm.js is precached for the same reason as every
 * other same-origin JS file here — see supabase-client.js's top comment
 * for why it's vendored locally rather than imported from a CDN.
 *
 * Bump CACHE_VERSION whenever a precached file changes — the activate
 * handler deletes any cache from a previous version, so a stale service
 * worker never keeps serving old code to a returning visitor.
 */
const CACHE_VERSION = 'tt-shell-v2';

const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon.svg',
  './css/app.css',
  './js/announcements.js',
  './js/app.js',
  './js/auth.js',
  './js/cash.js',
  './js/config.js',
  './js/connectivity.js',
  './js/database.js',
  './js/database.mock.js',
  './js/database.supabase.js',
  './js/date.js',
  './js/home.js',
  './js/items.js',
  './js/mock-data.js',
  './js/more.js',
  './js/nav.js',
  './js/orders.js',
  './js/pin-hash.js',
  './js/pwa.js',
  './js/reports.js',
  './js/roster.js',
  './js/staff.js',
  './js/stocktake.js',
  './js/supabase-client.js',
  './js/ui.js',
  './js/vendor/supabase-js.esm.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_VERSION).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Only handle same-origin GET requests for the precached app shell.
  // Everything else (Google Fonts, any future real API calls once a
  // backend exists) passes straight through to the network untouched —
  // this service worker never becomes a second source of truth for data
  // it has no business caching.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, copy));
        }
        return response;
      }).catch(() => {
        // Offline and not precached (e.g. a path that doesn't exist) —
        // fall back to the shell itself for navigations so the app still
        // loads rather than showing the browser's own offline error page.
        if (event.request.mode === 'navigate') return caches.match('./index.html');
        throw new Error('Offline and not cached: ' + event.request.url);
      });
    }),
  );
});
