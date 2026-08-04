/**
 * Count tab — the mobile counting workflow (Priority 4). Compact cards with
 * unit-aware steppers, search, previous/next, local draft autosave that
 * survives a refresh, section progress, jump-to-incomplete, and a
 * review-before-submit step that flags unusual counts.
 */
import * as db from './database.js';
import { getSession } from './auth.js';
import { esc, icon, fmtQty, openModal, closeModal, toast, confirmDialog } from './ui.js';
import { MAIN_CATEGORIES, CATEGORIES, stepForUnit, decimalsForUnit, hasInvalidDecimals, getAnomalyReasons, ANOMALY_VARIANCE_PCT, DRAFT_STORAGE_PREFIX } from './config.js';

let mainKey = null;
let categoryKey = null;
let searchQuery = '';
let sessionCache = null;
let inventoryCache = [];
let countLinesCache = [];
let focusIndex = -1; // for Previous/Next stepping through the current filtered list

function draftKey(sessionId) { return `${DRAFT_STORAGE_PREFIX}${sessionId}`; }

function readDraft(sessionId) {
  try { return JSON.parse(localStorage.getItem(draftKey(sessionId)) || '{}'); } catch { return {}; }
}
function writeDraft(sessionId, draft) {
  try {
    if (Object.keys(draft).length === 0) localStorage.removeItem(draftKey(sessionId));
    else localStorage.setItem(draftKey(sessionId), JSON.stringify(draft));
  } catch { /* storage unavailable — draft safety net just won't apply this session */ }
}

async function loadData(storeId) {
  const sess = getSession();
  sessionCache = await db.getOrStartSession(storeId, sess.staffId);
  inventoryCache = await db.getStoreInventory(storeId);
  countLinesCache = await db.getCountLines(sessionCache.id);
  return sessionCache;
}

function currentLineFor(storeInventoryId) {
  return countLinesCache.find((cl) => cl.storeInventoryId === storeInventoryId);
}

function isCounted(inv) { return !!currentLineFor(inv.id); }

function filteredList() {
  let list = inventoryCache;
  if (searchQuery.trim()) {
    const q = searchQuery.trim().toLowerCase();
    return list.filter((i) => i.item.name.toLowerCase().includes(q));
  }
  if (mainKey && !categoryKey) return [];
  if (categoryKey) return list.filter((i) => i.item.categoryKey === categoryKey);
  return list;
}

export async function renderCount(root) {
  const sess = getSession();
  await loadData(sess.storeId);

  if (searchQuery.trim()) return renderItemList(root, filteredList(), `"${searchQuery.trim()}"`, () => { searchQuery = ''; renderCount(root); }, true);

  if (!mainKey) return renderSectionPicker(root);
  if (!categoryKey) return renderCategoryPicker(root);
  return renderItemList(root, filteredList(), CATEGORIES[categoryKey].label, () => { categoryKey = null; renderCount(root); });
}

function searchBarHtml() {
  return `<div class="tt-search-bar">
    ${icon('search', 16)}
    <label class="tt-sr-only" for="ttCountSearch">Search items</label>
    <input class="tt-input" id="ttCountSearch" placeholder="Search any item to count it..." value="${esc(searchQuery)}">
  </div>`;
}
function bindSearchBar(root) {
  const input = root.querySelector('#ttCountSearch');
  if (!input) return;
  input.addEventListener('input', () => { searchQuery = input.value; renderCount(root); queueMicrotask(() => { const el = document.getElementById('ttCountSearch'); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }); });
}

function progressForList(list) {
  const counted = list.filter(isCounted).length;
  return { counted, total: list.length, pct: list.length ? Math.round((counted / list.length) * 100) : 0 };
}

function renderSectionPicker(root) {
  const tiles = Object.entries(MAIN_CATEGORIES).map(([key, def]) => {
    const items = inventoryCache.filter((i) => i.storageArea === key);
    const p = progressForList(items);
    return `<button class="tt-section-tile" data-main="${key}">
      <div class="tt-section-tile-label">${esc(def.label)}</div>
      <div class="tt-section-tile-sub">${p.counted}/${p.total} counted</div>
      <div class="tt-progress-track mini"><div class="tt-progress-fill" style="width:${p.pct}%"></div></div>
    </button>`;
  }).join('');
  root.innerHTML = `${searchBarHtml()}<div class="tt-review-row"><button class="tt-btn ghost" id="ttReviewBtn">${icon('check', 15)} Review &amp; submit</button></div><div class="tt-section-grid">${tiles}</div>`;
  bindSearchBar(root);
  root.querySelectorAll('[data-main]').forEach((el) => el.addEventListener('click', () => { mainKey = el.dataset.main; renderCount(root); }));
  root.querySelector('#ttReviewBtn').addEventListener('click', () => openReview(root));
}

function renderCategoryPicker(root) {
  const keys = Object.entries(CATEGORIES).filter(([, def]) => def.main === mainKey);
  const tiles = keys.map(([key, def]) => {
    const items = inventoryCache.filter((i) => i.item.categoryKey === key);
    const p = progressForList(items);
    return `<button class="tt-section-tile" data-cat="${key}">
      <div class="tt-section-tile-label">${esc(def.label)}</div>
      <div class="tt-section-tile-sub">${p.counted}/${p.total} counted</div>
      <div class="tt-progress-track mini"><div class="tt-progress-fill" style="width:${p.pct}%"></div></div>
    </button>`;
  }).join('');
  root.innerHTML = `${searchBarHtml()}
    <button class="tt-back" id="ttBackMain">${icon('chevronLeft', 14)} Sections</button>
    <div class="tt-section-grid">${tiles || '<div class="tt-empty">No categories here yet.</div>'}</div>`;
  bindSearchBar(root);
  root.querySelector('#ttBackMain').addEventListener('click', () => { mainKey = null; renderCount(root); });
  root.querySelectorAll('[data-cat]').forEach((el) => el.addEventListener('click', () => { categoryKey = el.dataset.cat; renderCount(root); }));
}

function renderItemList(root, list, title, onBack, isSearch = false) {
  const p = progressForList(list);
  const firstIncompleteIdx = list.findIndex((i) => !isCounted(i));

  root.innerHTML = `${searchBarHtml()}
    <button class="tt-back" id="ttBack">${icon('chevronLeft', 14)} ${isSearch ? 'Clear search' : 'Back'}</button>
    <div class="tt-list-header">
      <div class="tt-list-title">${esc(title)} · ${p.counted}/${p.total}</div>
      ${firstIncompleteIdx >= 0 ? `<button class="tt-link-btn" id="ttJumpIncomplete">Jump to incomplete</button>` : ''}
    </div>
    <div class="tt-progress-track mini"><div class="tt-progress-fill" style="width:${p.pct}%"></div></div>
    <div class="tt-count-cards" id="ttCountCards">
      ${list.map((inv, idx) => cardHtml(inv, idx)).join('') || '<div class="tt-empty">No items here.</div>'}
    </div>
    ${list.length ? `<div class="tt-prevnext" role="group" aria-label="Move between items">
      <button class="tt-btn ghost" id="ttPrevItem" aria-label="Previous item">${icon('chevronLeft', 16)} Prev</button>
      <button class="tt-btn ghost" id="ttNextItem" aria-label="Next item">Next ${icon('chevronRight', 16)}</button>
    </div>` : ''}
    <div class="tt-review-row"><button class="tt-btn tt-btn-sticky" id="ttReviewBtn2">${icon('check', 15)} Review &amp; submit</button></div>
  `;
  bindSearchBar(root);
  root.querySelector('#ttBack').addEventListener('click', onBack);
  root.querySelector('#ttReviewBtn2').addEventListener('click', () => openReview(root));
  const jumpBtn = root.querySelector('#ttJumpIncomplete');
  if (jumpBtn) jumpBtn.addEventListener('click', () => focusCard(root, firstIncompleteIdx));

  list.forEach((inv, idx) => bindCard(root, inv, idx, list));

  root.querySelector('#ttPrevItem')?.addEventListener('click', () => { focusIndex = Math.max(0, focusIndex - 1); focusCard(root, focusIndex); });
  root.querySelector('#ttNextItem')?.addEventListener('click', () => { focusIndex = Math.min(list.length - 1, focusIndex + 1); focusCard(root, focusIndex); });

  if (focusIndex >= 0 && focusIndex < list.length) focusCard(root, focusIndex, true);
}

function focusCard(root, idx, silent = false) {
  focusIndex = idx;
  const card = root.querySelector(`.tt-count-card[data-idx="${idx}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: silent ? 'auto' : 'smooth', block: 'center' });
  card.querySelector('.tt-qty-input')?.focus({ preventScroll: true });
  card.classList.add('tt-focused');
  setTimeout(() => card.classList.remove('tt-focused'), 1200);
}

function variancePct(inv, countedQty) {
  const system = Number(inv.currentStock) || 0;
  if (system === 0) return countedQty > 0 ? Infinity : 0;
  return Math.abs(countedQty - system) / system;
}

function cardHtml(inv, idx) {
  const line = currentLineFor(inv.id);
  const draft = readDraft(sessionCache.id);
  const draftVal = draft[inv.id];
  const counted = draftVal !== undefined ? draftVal : line?.countedQty;
  const decimals = decimalsForUnit(inv.unit);
  const unusual = counted !== undefined && variancePct(inv, Number(counted)) > ANOMALY_VARIANCE_PCT;
  const state = counted === undefined ? 'incomplete' : (draftVal !== undefined && !line) ? 'unsynced' : 'counted';

  return `<div class="tt-count-card ${state}" data-idx="${idx}" data-id="${inv.id}">
    <div class="tt-count-card-top">
      <div>
        <div class="tt-count-card-name">${esc(inv.item.name)}${inv.important ? ' <span class="tt-star" title="Important">&#9733;</span>' : ''}</div>
        <div class="tt-count-card-sub">${inv.storageLocation ? esc(inv.storageLocation) + ' · ' : ''}${esc(inv.unit)}${line ? ` · system ${fmtQty(inv.currentStock, decimals)}` : ''}</div>
      </div>
      <div class="tt-count-state-badge ${state}">${state === 'counted' ? icon('check', 13) + ' Counted' : state === 'unsynced' ? 'Saving…' : 'Not counted'}</div>
    </div>
    ${unusual ? `<div class="tt-variance-warning">${icon('alert', 14)} Big change from system quantity — double check before moving on.</div>` : ''}
    <div class="tt-stepper-row">
      <button class="tt-stepper-btn" data-step="-1" aria-label="Decrease ${esc(inv.item.name)}">${icon('minus', 18)}</button>
      <input class="tt-qty-input" type="number" inputmode="decimal" step="${stepForUnit(inv.unit)}" min="0"
        value="${counted !== undefined ? counted : ''}" placeholder="0" aria-label="${esc(inv.item.name)} quantity, ${esc(inv.unit)}">
      <button class="tt-stepper-btn" data-step="1" aria-label="Increase ${esc(inv.item.name)}">${icon('plus', 18)}</button>
    </div>
  </div>`;
}

function bindCard(root, inv, idx, list) {
  const card = root.querySelector(`.tt-count-card[data-idx="${idx}"]`);
  if (!card) return;
  const input = card.querySelector('.tt-qty-input');
  const step = stepForUnit(inv.unit);
  const decimals = decimalsForUnit(inv.unit);

  function currentVal() { return input.value === '' ? null : Number(input.value); }
  function setVal(v) {
    const clamped = Math.max(0, Math.round(v / step) * step);
    input.value = decimals > 0 ? clamped.toFixed(decimals) : String(Math.round(clamped));
  }

  card.querySelectorAll('.tt-stepper-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const base = currentVal() ?? (Number(inv.currentStock) || 0);
      setVal(base + Number(btn.dataset.step) * step);
      commit(root, inv, currentVal(), list, idx);
    });
  });
  input.addEventListener('change', () => {
    if (currentVal() === null) return;
    commit(root, inv, currentVal(), list, idx);
  });
  card.addEventListener('focusin', () => { focusIndex = idx; });
}

/** Accessible replacement for window.prompt() — an in-modal reason field. */
function promptRecountReason() {
  return new Promise((resolve) => {
    const dialog = openModal(`
      <h2 id="tt-recount-title" class="tt-modal-title">Reason for recount</h2>
      <p class="tt-modal-body">Required so the original count stays in the audit trail with an explanation for the change.</p>
      <div class="tt-field"><label for="ttRecountReason" class="tt-sr-only">Reason</label>
        <textarea class="tt-input" id="ttRecountReason" rows="2" placeholder="e.g. Miscounted first time, recounted with manager"></textarea></div>
      <div class="tt-pin-error" id="ttRecountError" role="alert" aria-live="assertive"></div>
      <div class="tt-modal-actions">
        <button class="tt-btn ghost" data-action="cancel">Cancel</button>
        <button class="tt-btn" data-action="confirm">Save recount</button>
      </div>
    `, { labelledBy: 'tt-recount-title', onClose: () => resolve(null) });
    dialog.querySelector('[data-action="cancel"]').addEventListener('click', () => closeModal());
    dialog.querySelector('[data-action="confirm"]').addEventListener('click', () => {
      const val = dialog.querySelector('#ttRecountReason').value.trim();
      if (!val) { dialog.querySelector('#ttRecountError').textContent = 'A reason is required to save a recount.'; return; }
      const overlay = dialog.closest('.tt-modal-overlay');
      if (overlay) overlay._onClose = null;
      closeModal();
      resolve(val);
    });
  });
}

/** Anomaly confirmation (Priority 5) — lets the count through, but only after an explicit yes. */
function confirmAnomaly(reasons) {
  return confirmDialog({
    title: 'Double check this count',
    body: `<ul class="tt-anomaly-list">${reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`,
    confirmLabel: 'Yes, that’s correct', cancelLabel: 'Let me fix it',
  });
}

async function commit(root, inv, countedQty, list, idx) {
  if (countedQty === null || Number.isNaN(countedQty) || countedQty < 0) {
    toast('Enter a valid quantity', { error: true });
    return;
  }
  if (hasInvalidDecimals(countedQty, inv.unit)) {
    toast(`${esc(inv.unit)} is only counted to ${decimalsForUnit(inv.unit)} decimal place${decimalsForUnit(inv.unit) === 1 ? '' : 's'}`, { error: true });
    return;
  }

  const anomalies = getAnomalyReasons(inv, countedQty);
  if (anomalies.length) {
    const proceed = await confirmAnomaly(anomalies);
    if (!proceed) { toast('Not saved — update the count and try again', { error: true }); return; }
  }

  const sess = getSession();
  const draft = readDraft(sessionCache.id);
  draft[inv.id] = countedQty;
  writeDraft(sessionCache.id, draft);
  refreshCardState(root, inv.id, list, idx, 'unsynced');

  try {
    await db.saveCountLine({
      sessionId: sessionCache.id, storeInventoryId: inv.id,
      systemQty: inv.currentStock, countedQty, unit: inv.unit, staffId: sess.staffId,
    });
    countLinesCache = await db.getCountLines(sessionCache.id);
    delete draft[inv.id];
    writeDraft(sessionCache.id, draft);
    refreshCardState(root, inv.id, list, idx, 'counted');
  } catch (e) {
    if (e instanceof db.ConflictError) {
      const proceed = await confirmDialog({
        title: 'Someone already counted this',
        body: `${esc(e.message)}`,
        confirmLabel: 'Recount anyway', danger: true,
      });
      if (proceed) {
        const reason = await promptRecountReason();
        if (reason) {
          await db.saveCountLine({
            sessionId: sessionCache.id, storeInventoryId: inv.id,
            systemQty: inv.currentStock, countedQty, unit: inv.unit, staffId: sess.staffId,
            recountReason: reason,
          });
          countLinesCache = await db.getCountLines(sessionCache.id);
          delete draft[inv.id];
          writeDraft(sessionCache.id, draft);
          refreshCardState(root, inv.id, list, idx, 'counted');
          toast('Recount saved');
          return;
        }
      }
      toast('Not saved — count left as a draft on this device', { error: true });
    } else if (e instanceof db.ValidationError) {
      toast(e.message, { error: true });
    } else {
      toast('Could not save — kept as an unsynced draft on this device', { error: true });
    }
  }
}

function refreshCardState(root, invId, list, idx, forcedState) {
  const card = root.querySelector(`.tt-count-card[data-id="${invId}"]`);
  if (!card) return;
  card.classList.remove('incomplete', 'unsynced', 'counted');
  card.classList.add(forcedState);
  const badge = card.querySelector('.tt-count-state-badge');
  badge.className = `tt-count-state-badge ${forcedState}`;
  badge.innerHTML = forcedState === 'counted' ? `${icon('check', 13)} Counted` : forcedState === 'unsynced' ? 'Saving…' : 'Not counted';
}

// ---- Review & submit ------------------------------------------------------------
async function openReview(root) {
  const sess = getSession();
  countLinesCache = await db.getCountLines(sessionCache.id);
  const uncounted = inventoryCache.filter((i) => !isCounted(i));
  const unusual = countLinesCache
    .map((l) => ({ ...l, inv: inventoryCache.find((i) => i.id === l.storeInventoryId) }))
    .filter((l) => l.inv && variancePct(l.inv, l.countedQty) > ANOMALY_VARIANCE_PCT);

  const dialog = openModal(`
    <h2 id="tt-review-title" class="tt-modal-title">Review before submitting</h2>
    <p class="tt-modal-body">${countLinesCache.length} of ${inventoryCache.length} items counted.</p>
    ${uncounted.length ? `<div class="tt-review-section"><div class="tt-review-section-title">${icon('alert', 14)} ${uncounted.length} not counted yet</div>
      <div class="tt-list-rows">${uncounted.slice(0, 6).map((i) => `<div class="tt-list-row"><div class="tt-list-row-name">${esc(i.item.name)}</div></div>`).join('')}${uncounted.length > 6 ? `<div class="tt-list-row-sub">+${uncounted.length - 6} more</div>` : ''}</div>
    </div>` : ''}
    ${unusual.length ? `<div class="tt-review-section"><div class="tt-review-section-title">${icon('alert', 14)} ${unusual.length} unusual count${unusual.length === 1 ? '' : 's'} — worth a second look</div>
      <div class="tt-list-rows">${unusual.map((l) => `<div class="tt-list-row"><div><div class="tt-list-row-name">${esc(l.inv.item.name)}</div><div class="tt-list-row-sub">System ${fmtQty(l.systemQty)} → counted ${fmtQty(l.countedQty)} ${esc(l.unit)}</div></div></div>`).join('')}</div>
    </div>` : ''}
    ${uncounted.length ? `<label class="tt-checkbox-row">
      <input type="checkbox" id="ttAckIncomplete">
      <span>I understand ${uncounted.length} item${uncounted.length === 1 ? '' : 's'} will be submitted as not counted.</span>
    </label>` : ''}
    <div class="tt-modal-actions">
      <button class="tt-btn ghost" id="ttReviewCancel">Keep counting</button>
      <button class="tt-btn" id="ttReviewSubmit" ${uncounted.length ? 'disabled' : ''}>Submit stocktake</button>
    </div>
  `, { labelledBy: 'tt-review-title' });
  dialog.querySelector('#ttReviewCancel').addEventListener('click', closeModal);
  const ackBox = dialog.querySelector('#ttAckIncomplete');
  if (ackBox) ackBox.addEventListener('change', () => { dialog.querySelector('#ttReviewSubmit').disabled = !ackBox.checked; });
  dialog.querySelector('#ttReviewSubmit').addEventListener('click', async () => {
    const btn = dialog.querySelector('#ttReviewSubmit');
    btn.disabled = true; btn.textContent = 'Submitting…';
    try {
      await db.submitSession(sessionCache.id, sess.staffId, sessionCache.version);
      closeModal();
      toast('Stocktake submitted');
      sessionCache = await db.getSession(sessionCache.id);
      renderCount(root);
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Submit stocktake';
      if (e instanceof db.ConflictError) {
        toast(e.message, { error: true, duration: 5000 });
      } else {
        toast('Submission failed — nothing was lost, try again', { error: true, duration: 5000 });
      }
    }
  });
}
