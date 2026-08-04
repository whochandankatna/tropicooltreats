/**
 * Service worker registration (Priority 11). Kept separate from app.js so
 * a registration failure (unsupported browser, running from a context the
 * service worker API refuses) can never break app boot — it's isolated
 * and never awaited by the caller.
 */
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const register = () => navigator.serviceWorker.register('service-worker.js').catch((err) => {
    console.warn('Service worker registration failed (app still works online):', err);
  });
  // `<script type="module">` runs after the DOM is parsed, so the page's
  // own 'load' event may well have already fired by the time this runs --
  // waiting for it unconditionally would mean the listener never fires.
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register);
}
