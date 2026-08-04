/**
 * Session state + PIN entry UI. In a real deployment, `verifyStaffPin` in
 * database.js calls the verify-staff-pin Edge Function and this module
 * stores the returned session JWT (see AUTH_MODEL.md "Client wiring") —
 * today it stores the mock `{ok, staff}` result from the in-memory layer.
 * Either way, the session shape held here (staff id/name/role/store) and
 * sessionStorage-based persistence (clears on tab close, deliberately —
 * see AUTH_MODEL.md "Session storage choice") don't change.
 */
import { verifyStaffPin } from './database.js';
import { SESSION_STORAGE_KEY, STORES } from './config.js';
import { icon } from './ui.js';

let session = null; // { staffId, name, role, storeId }
let listeners = [];

export function getSession() { return session; }
export function isManager() { return session?.role === 'manager'; }
export function onSessionChange(fn) { listeners.push(fn); return () => { listeners = listeners.filter((f) => f !== fn); }; }
function notify() { listeners.forEach((fn) => fn(session)); }

export function restoreSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (raw) session = JSON.parse(raw);
  } catch { /* ignore */ }
  return session;
}

export function signOut() {
  session = null;
  try { sessionStorage.removeItem(SESSION_STORAGE_KEY); } catch { /* ignore */ }
  notify();
}

function persist() {
  try { sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session)); } catch { /* ignore */ }
}

/**
 * Renders a PIN keypad into `container` for the given store and resolves
 * once a correct PIN is entered (or never, if the user abandons it — the
 * caller just leaves the lock screen up).
 */
export function renderPinLock(container, storeId) {
  const store = STORES.find((s) => s.id === storeId);
  let entered = '';

  function draw(errorMsg) {
    container.innerHTML = `
      <div class="tt-pinlock">
        <div class="tt-pinlock-logo">TT</div>
        <div class="tt-pinlock-store">${store ? store.name : ''}</div>
        <div class="tt-pinlock-title">Enter your PIN</div>
        <div class="tt-pin-dots" aria-hidden="true">${[0, 1, 2, 3].map((i) => `<span class="${i < entered.length ? 'filled' : ''}"></span>`).join('')}</div>
        <div class="tt-pin-error" role="alert" aria-live="assertive">${errorMsg ? errorMsg : ''}</div>
        <div class="tt-pin-keypad">
          ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button class="tt-pin-key" data-num="${n}" aria-label="${n}">${n}</button>`).join('')}
          <div></div>
          <button class="tt-pin-key" data-num="0" aria-label="0">0</button>
          <button class="tt-pin-key" data-action="back" aria-label="Backspace">&#9003;</button>
        </div>
      </div>`;
    container.querySelectorAll('[data-num]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (entered.length >= 4) return;
        entered += btn.dataset.num;
        if (entered.length < 4) { draw(); return; }
        const result = await verifyStaffPin(storeId, entered);
        entered = '';
        if (!result.ok) { draw(result.error || 'Incorrect PIN'); return; }
        session = { staffId: result.staff.id, name: result.staff.name, role: result.staff.role, storeId: result.staff.storeId };
        persist();
        notify();
      });
    });
    const back = container.querySelector('[data-action="back"]');
    if (back) back.addEventListener('click', () => { entered = entered.slice(0, -1); draw(); });
  }
  draw();
}

export function signOutButtonHtml() {
  return `<button class="tt-icon-btn" id="ttSignOutBtn" aria-label="Sign out" title="Sign out">${icon('chevronLeft', 16)}<span class="tt-sr-only">Sign out</span></button>`;
}
