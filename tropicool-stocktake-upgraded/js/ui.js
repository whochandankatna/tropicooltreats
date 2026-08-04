/**
 * Shared render/DOM helpers: escaping, toasts (aria-live), an accessible
 * modal with focus trapping and focus return, and small SVG icons. No
 * framework — this is the "modular vanilla JS" approach the brief allows.
 */

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastEl = null;
let toastTimer = null;
/**
 * `opts.action` optionally renders a button inside the toast (e.g. "Undo")
 * — `{ label, onClick }`. The toast still auto-dismisses on its own timer;
 * the action is a bonus, not the only way to proceed.
 */
export function toast(msg, opts = {}) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'tt-toast';
    toastEl.setAttribute('role', 'status');
    toastEl.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastEl);
  }
  toastEl.innerHTML = '';
  toastEl.appendChild(document.createTextNode(msg));
  if (opts.action) {
    const btn = document.createElement('button');
    btn.className = 'tt-toast-action';
    btn.textContent = opts.action.label;
    btn.addEventListener('click', () => { toastEl.classList.remove('show'); opts.action.onClick(); });
    toastEl.appendChild(btn);
  }
  toastEl.classList.toggle('error', !!opts.error);
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), opts.duration || 3200);
}

// ---- Accessible modal: focus trap + focus return + Escape to close --------------
let lastFocusedEl = null;
let modalRoot = null;
let modalKeydownHandler = null;

function ensureModalRoot() {
  if (modalRoot) return modalRoot;
  modalRoot = document.createElement('div');
  modalRoot.className = 'tt-modal-overlay';
  modalRoot.innerHTML = `<div class="tt-modal" role="dialog" aria-modal="true"></div>`;
  document.body.appendChild(modalRoot);
  modalRoot.addEventListener('click', (e) => { if (e.target === modalRoot) closeModal(); });
  return modalRoot;
}

export function openModal(html, { labelledBy, onClose } = {}) {
  const root = ensureModalRoot();
  lastFocusedEl = document.activeElement;
  const dialog = root.querySelector('.tt-modal');
  dialog.innerHTML = html;
  if (labelledBy) dialog.setAttribute('aria-labelledby', labelledBy);
  root.classList.add('show');
  root._onClose = onClose;

  const focusable = () => Array.from(dialog.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  )).filter((el) => !el.disabled && el.offsetParent !== null);

  const first = focusable()[0];
  (first || dialog).focus({ preventScroll: true });

  modalKeydownHandler = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeModal(); return; }
    if (e.key !== 'Tab') return;
    const items = focusable();
    if (!items.length) return;
    const firstEl = items[0], lastEl = items[items.length - 1];
    if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
    else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
  };
  document.addEventListener('keydown', modalKeydownHandler);
  return dialog;
}

export function closeModal() {
  if (!modalRoot) return;
  modalRoot.classList.remove('show');
  document.removeEventListener('keydown', modalKeydownHandler);
  const onClose = modalRoot._onClose;
  modalRoot._onClose = null;
  if (lastFocusedEl && lastFocusedEl.focus) lastFocusedEl.focus({ preventScroll: true });
  if (onClose) onClose();
}

// ---- Confirm dialog (replaces window.confirm with something accessible/testable) ---
export function confirmDialog({ title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const dialog = openModal(`
      <h2 id="tt-confirm-title" class="tt-modal-title">${esc(title)}</h2>
      <p class="tt-modal-body">${body}</p>
      <div class="tt-modal-actions">
        <button class="tt-btn ghost" data-action="cancel">${esc(cancelLabel)}</button>
        <button class="tt-btn ${danger ? 'danger' : ''}" data-action="confirm">${esc(confirmLabel)}</button>
      </div>
    `, { labelledBy: 'tt-confirm-title', onClose: () => resolve(false) });
    dialog.querySelector('[data-action="cancel"]').addEventListener('click', () => closeModal());
    dialog.querySelector('[data-action="confirm"]').addEventListener('click', () => { modalRoot._onClose = null; closeModal(); resolve(true); });
  });
}

/**
 * Accessible in-modal replacement for window.prompt() — used anywhere a
 * short required reason needs capturing (recount reasons, waste reasons,
 * archive reasons). Resolves the trimmed text, or null if cancelled.
 */
export function promptText({ title, body, label, placeholder = '', confirmLabel = 'Save', required = true }) {
  return new Promise((resolve) => {
    const dialog = openModal(`
      <h2 id="tt-prompt-title" class="tt-modal-title">${esc(title)}</h2>
      ${body ? `<p class="tt-modal-body">${body}</p>` : ''}
      <div class="tt-field"><label for="ttPromptInput" class="tt-sr-only">${esc(label || title)}</label>
        <textarea class="tt-input" id="ttPromptInput" rows="2" placeholder="${escAttr(placeholder)}"></textarea></div>
      <div class="tt-pin-error" id="ttPromptError" role="alert" aria-live="assertive"></div>
      <div class="tt-modal-actions">
        <button class="tt-btn ghost" data-action="cancel">Cancel</button>
        <button class="tt-btn" data-action="confirm">${esc(confirmLabel)}</button>
      </div>
    `, { labelledBy: 'tt-prompt-title', onClose: () => resolve(null) });
    dialog.querySelector('[data-action="cancel"]').addEventListener('click', () => closeModal());
    dialog.querySelector('[data-action="confirm"]').addEventListener('click', () => {
      const val = dialog.querySelector('#ttPromptInput').value.trim();
      if (required && !val) { dialog.querySelector('#ttPromptError').textContent = 'This is required.'; return; }
      modalRoot._onClose = null;
      closeModal();
      resolve(val);
    });
  });
}

function escAttr(s) { return esc(s); }

// ---- Icons (inline SVG, currentColor so they follow theme) ------------------------
const ICONS = {
  home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
  count: '<rect x="5" y="4" width="14" height="17" rx="2"/><line x1="9" y1="9" x2="15" y2="9"/><line x1="9" y1="13" x2="13" y2="13"/>',
  orders: '<rect x="4" y="3" width="16" height="18" rx="2"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="16" x2="12" y2="16"/>',
  reports: '<line x1="5" y1="20" x2="5" y2="12"/><line x1="12" y1="20" x2="12" y2="6"/><line x1="19" y1="20" x2="19" y2="15"/>',
  more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  minus: '<line x1="5" y1="12" x2="19" y2="12"/>',
  search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/>',
  chevronLeft: '<polyline points="15 18 9 12 15 6"/>',
  chevronRight: '<polyline points="9 18 15 12 9 6"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  alert: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="13"/><circle cx="12" cy="16.3" r="0.6" fill="currentColor" stroke="none"/>',
  clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 15"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="19" x2="12" y2="22"/>',
  wifi: '<path d="M2 8.5a16 16 0 0 1 20 0"/><path d="M5 12a11 11 0 0 1 14 0"/><path d="M8.5 15.5a6 6 0 0 1 7 0"/><circle cx="12" cy="19" r="1" fill="currentColor" stroke="none"/>',
  wifiOff: '<path d="M2 8.5a16 16 0 0 1 5.5-3.6"/><path d="M16.5 4.9A16 16 0 0 1 22 8.5"/><path d="M5 12a11 11 0 0 1 4.5-2.5"/><path d="M14.5 9.5A11 11 0 0 1 19 12"/><path d="M8.5 15.5a6 6 0 0 1 4-1.5"/><circle cx="12" cy="19" r="1" fill="currentColor" stroke="none"/><line x1="2" y1="2" x2="22" y2="22"/>',
};
export function icon(name, size = 18) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="${size}" height="${size}" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

export function fmtQty(n, decimals = 0) {
  const num = Number(n) || 0;
  return decimals > 0 ? num.toFixed(decimals) : String(Math.round(num));
}

export function timeAgo(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

// ---- Report exports (Priority 8) --------------------------------------------------
// CSV/JSON are real client-side file downloads via a Blob + temporary <a>,
// no server round-trip. "Print" (reports.js) uses the browser's own
// print-to-PDF, not a generated PDF file — see README's Phase 8 notes for
// why that's the honest way to describe it rather than claiming a PDF
// export this app doesn't actually build.
export function downloadFile(filename, mimeType, content) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** headers: string[]; rows: array of arrays in the same column order. */
export function toCSV(headers, rows) {
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
}
