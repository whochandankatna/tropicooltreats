/**
 * Shared online/offline state (Priority 11). A thin wrapper over
 * navigator.onLine + the online/offline browser events, so every module
 * that needs to know connectivity (the sync pill in app.js, the
 * offline-queue decision in stocktake.js) reads the same source of truth
 * instead of each attaching its own event listener.
 *
 * navigator.onLine only reflects whether the device has *a* network
 * connection, not whether this app's backend is reachable — accurate
 * enough for a mock with no real backend, and matches what a real
 * deployment would layer a proper reachability check on top of later.
 */
let online = typeof navigator !== 'undefined' ? navigator.onLine : true;
let listeners = [];

function setOnline(next) {
  if (next === online) return;
  online = next;
  listeners.forEach((fn) => fn(online));
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => setOnline(true));
  window.addEventListener('offline', () => setOnline(false));
}

export function isOnline() { return online; }
export function onConnectivityChange(fn) {
  listeners.push(fn);
  return () => { listeners = listeners.filter((f) => f !== fn); };
}
