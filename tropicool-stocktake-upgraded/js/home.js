/**
 * Home — action-first live dashboard (Priority 3). Urgent information is
 * visible immediately; deeper detail sits behind "View details" so staff
 * aren't forced through several category screens to spot a problem.
 */
import * as db from './database.js';
import { getSession } from './auth.js';
import { esc, icon, fmtQty, openModal, closeModal } from './ui.js';
import { EXPIRY_WARN_DAYS, DRAFT_STORAGE_PREFIX, CONFLICT_STORAGE_PREFIX, decimalsForUnit } from './config.js';
import { formatBrisbaneDate } from './date.js';
import { setActiveTab } from './nav.js';
import { isOnline } from './connectivity.js';

let detailsOpen = false;

/** Counts individual queued items across all draft-prefixed keys, not just
 * how many sessions happen to have a draft — a whole shift's worth of
 * offline counts is one key but many items, and the banner should say so. */
function countByPrefix(prefix) {
  let n = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix)) {
        try { n += Object.keys(JSON.parse(localStorage.getItem(key) || '{}')).length; } catch { /* corrupt entry, skip */ }
      }
    }
  } catch { /* ignore */ }
  return n;
}

export async function renderHome(root) {
  const sess = getSession();
  const storeId = sess.storeId;

  const session = await db.getOrStartSession(storeId, sess.staffId);
  const progress = await db.getSessionProgress(session.id);
  const reorderList = await db.getReorderList(storeId);
  const expiryAlerts = await db.getExpiryAlerts(storeId, EXPIRY_WARN_DAYS);
  const expired = expiryAlerts.filter((a) => a.daysUntilExpiry < 0);
  const expiringSoon = expiryAlerts.filter((a) => a.daysUntilExpiry >= 0);
  const variances = await db.getLargestVariances(session.id, 3);
  const unsynced = countByPrefix(DRAFT_STORAGE_PREFIX);
  const conflicted = countByPrefix(CONFLICT_STORAGE_PREFIX);

  const resumeLabel = session.status === 'draft' ? 'Start today’s stocktake' : 'Resume today’s stocktake';

  root.innerHTML = `
    <div class="tt-home">
      <section class="tt-hero-card" aria-label="Today's stocktake">
        <div class="tt-hero-top">
          <div>
            <div class="tt-hero-date">${esc(formatBrisbaneDate(session.businessDate, { weekday: 'long', day: 'numeric', month: 'long' }))}</div>
            <div class="tt-hero-progress">${progress.countedItems}<span>/${progress.totalItems} items counted</span></div>
          </div>
          <div class="tt-hero-pct" aria-hidden="true">${progress.completionPct}%</div>
        </div>
        <div class="tt-progress-track" role="progressbar" aria-valuenow="${progress.completionPct}" aria-valuemin="0" aria-valuemax="100" aria-label="Stocktake completion">
          <div class="tt-progress-fill" style="width:${progress.completionPct}%"></div>
        </div>
        <button class="tt-btn tt-btn-hero" id="ttResumeBtn">${esc(resumeLabel)}</button>
      </section>

      ${conflicted > 0 ? `
      <button class="tt-alert-banner conflict" id="ttConflictBanner" type="button">
        ${icon('alert', 16)} ${conflicted} count${conflicted === 1 ? '' : 's'} need review — counted by someone else while offline. Tap to resolve in Count.
      </button>` : ''}
      ${unsynced > 0 ? `
      <div class="tt-alert-banner ${isOnline() ? '' : 'offline'}" role="status">
        ${icon(isOnline() ? 'wifi' : 'wifiOff', 16)} ${unsynced} ${isOnline() ? 'unsynced change' : 'count'}${unsynced === 1 ? '' : 's'} ${isOnline() ? 'saved on this device — syncing shortly.' : 'queued on this device — will sync once you\'re back online.'}
      </div>` : ''}

      <ul class="tt-chip-row">
        ${chip('reorder', 'Needs order', reorderList.length, 'alert')}
        ${chip('expired', 'Expired', expired.length, 'alert')}
        ${chip('expiring', 'Expiring soon', expiringSoon.length, 'warn')}
        ${chip('variance', 'Large variances', variances.filter((v) => Math.abs(v.variance) > 0).length, 'warn')}
      </ul>

      <button class="tt-details-toggle" id="ttDetailsToggle" aria-expanded="${detailsOpen}">
        ${detailsOpen ? 'Hide details' : 'View details'}
        ${icon(detailsOpen ? 'chevronLeft' : 'chevronRight', 14)}
      </button>

      <div class="tt-details ${detailsOpen ? 'open' : ''}">
        <div class="tt-panel">
          <h2 class="tt-panel-title">This stocktake</h2>
          <dl class="tt-detail-list">
            <div><dt>Started by</dt><dd>${esc(staffNameOf(session.startedBy))}</dd></div>
            <div><dt>Status</dt><dd>${esc(session.status)}</dd></div>
          </dl>
        </div>
        ${variances.length ? `
        <div class="tt-panel">
          <h2 class="tt-panel-title">Largest variances so far</h2>
          ${variances.map((v) => `<div class="tt-list-row"><span>${esc(itemNameOf(v.storeInventoryId))}</span><span class="${v.variance < 0 ? 'neg' : v.variance > 0 ? 'pos' : ''}">${v.variance > 0 ? '+' : ''}${fmtQty(v.variance, 1)} ${esc(v.unit)}</span></div>`).join('')}
        </div>` : ''}
      </div>
    </div>
  `;

  root.querySelector('#ttResumeBtn').addEventListener('click', () => setActiveTab('count'));
  root.querySelector('#ttConflictBanner')?.addEventListener('click', () => setActiveTab('count'));
  root.querySelector('#ttDetailsToggle').addEventListener('click', () => {
    detailsOpen = !detailsOpen;
    renderHome(root);
  });
  root.querySelectorAll('.tt-chip[data-filter]').forEach((el) => {
    el.addEventListener('click', () => openFilterModal(el.dataset.filter, { reorderList, expired, expiringSoon, variances }));
  });

  function staffNameOf() { return sess.name; } // mock: single-session demo, always the signed-in staff
  function itemNameOf(storeInventoryId) {
    return reorderList.find((i) => i.id === storeInventoryId)?.item?.name
      || expiryAlerts.find((a) => a.inventory.id === storeInventoryId)?.inventory?.item?.name
      || 'Item';
  }
}

function chip(key, label, count, tone) {
  return `<li><button class="tt-chip ${tone} ${count === 0 ? 'zero' : ''}" data-filter="${key}">
    <span class="tt-chip-count">${count}</span>
    <span class="tt-chip-label">${esc(label)}</span>
  </button></li>`;
}

function openFilterModal(filter, data) {
  let title, rows;
  if (filter === 'reorder') {
    title = 'Needs order';
    rows = data.reorderList.map((i) => row(i.item.name, `${fmtQty(i.currentStock, decimalsForUnit(i.unit))} ${i.unit} on hand · reorder point ${i.reorderPoint}`));
  } else if (filter === 'expired') {
    title = 'Expired';
    rows = data.expired.map((a) => row(a.inventory.item.name, `Expired ${Math.abs(a.daysUntilExpiry)}d ago · ${fmtQty(a.batch.quantityRemaining, decimalsForUnit(a.inventory.unit))} ${a.inventory.unit} affected`));
  } else if (filter === 'expiring') {
    title = 'Expiring soon';
    rows = data.expiringSoon.map((a) => row(a.inventory.item.name, `${a.daysUntilExpiry === 0 ? 'Expires today' : `Expires in ${a.daysUntilExpiry}d`} · ${fmtQty(a.batch.quantityRemaining, decimalsForUnit(a.inventory.unit))} ${a.inventory.unit} affected`));
  } else {
    title = 'Largest variances';
    rows = data.variances.map((v) => row(v.storeInventoryId, `Variance ${v.variance > 0 ? '+' : ''}${fmtQty(v.variance, 1)} ${v.unit}`));
  }
  openModal(`
    <h2 id="tt-filter-title" class="tt-modal-title">${esc(title)}</h2>
    <div class="tt-list-rows">${rows.join('') || '<div class="tt-empty">Nothing here right now.</div>'}</div>
    <div class="tt-modal-actions"><button class="tt-btn" id="ttFilterClose">Close</button></div>
  `, { labelledBy: 'tt-filter-title' });
  document.getElementById('ttFilterClose').addEventListener('click', closeModal);
}
function row(name, sub) {
  return `<div class="tt-list-row"><div><div class="tt-list-row-name">${esc(name)}</div><div class="tt-list-row-sub">${esc(sub)}</div></div></div>`;
}
