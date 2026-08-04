/**
 * App-shell service worker (Priority 11). This app has no real backend yet
 * (SUPABASE_URL is blank — see config.js/database.js) so there is no live
 * data to sync from a service worker; what "offline" means today is
 * narrower and more honest than a full offline-first data sync: the app
 * shell (HTML/CSS/JS) precaches on install so the app still LAUNCHES and
 * is fully usable offline, and the mock data layer + Phase 11's
 * draft/queue/conflict handling in stocktake.js take it from there.
 *
 * Bump CACHE_VERSION whenever a precached file changes — the activate
 * handler deletes any cache from a previous version, so a stale service
 * worker never keeps serving old code to a returning visitor.
 */
const CACHE_VERSION = 'tt-shell-v1';

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
  './js/ui.js',
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
