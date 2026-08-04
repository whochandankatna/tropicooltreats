/**
 * Cash count — Priority 9 redesign. Register + shift + a denomination
 * calculator (the counted total is derived from coin/note quantities, not
 * typed as one lump figure) + expected-vs-counted variance + manager
 * approval, replacing Phase 4's simpler placeholder. Still true from
 * Phase 4: counts are never summed into one "today so far" total across
 * registers/shifts (AUDIT.md §8's flagged anti-pattern) — each register's
 * counts stay separate, grouped only for display.
 *
 * A recount can only supersede your *own* current entry for a register+
 * shift+day (mirrors 0008_cash_counts.sql's RLS) — a different staff
 * member hits a clear error pointing at a manager, who can override
 * anyone's count. Every recount requires a reason, same-staff or not,
 * since a cash correction is a standalone financial event worth
 * documenting either way (stricter than count_lines' same-staff exemption
 * — see database.js's saveCashCount for why).
 */
import * as db from './database.js';
import { getSession, isManager } from './auth.js';
import { esc, toast, confirmDialog, promptText, openModal, closeModal } from './ui.js';
import { formatBrisbaneDate } from './date.js';
import { CASH_DENOMINATIONS, CASH_SHIFTS } from './config.js';

function readDenominations(root) {
  const out = {};
  CASH_DENOMINATIONS.forEach((d) => { out[d.key] = Number(root.querySelector(`[data-denom="${d.key}"]`)?.value) || 0; });
  return out;
}
function computeTotal(denominations) {
  return CASH_DENOMINATIONS.reduce((sum, d) => sum + (Number(denominations[d.key]) || 0) * d.value, 0);
}
function updateLiveTotal(root) {
  const total = computeTotal(readDenominations(root));
  root.querySelector('#ttCashLiveTotal').textContent = `$${total.toFixed(2)}`;
}

export async function renderCash(root) {
  const sess = getSession();
  const counts = isManager() ? await db.getCashCounts(sess.storeId) : [];

  const byRegister = {};
  counts.forEach((c) => { (byRegister[c.register || 'Register'] = byRegister[c.register || 'Register'] || []).push(c); });

  root.innerHTML = `
    <div class="tt-panel">
      <h2 class="tt-panel-title">Cash count</h2>
      <div class="tt-form">
        <div class="tt-field"><label for="ttCashRegister">Register</label><input class="tt-input" id="ttCashRegister" placeholder="Front counter"></div>
        <div class="tt-field"><label for="ttCashShift">Shift</label><select class="tt-input" id="ttCashShift">
          ${CASH_SHIFTS.map((s) => `<option value="${s.key}">${esc(s.label)}</option>`).join('')}
        </select></div>
        <div class="tt-field"><label for="ttCashExpected">Expected ($)</label><input class="tt-input" type="number" min="0" step="0.05" id="ttCashExpected" placeholder="optional"></div>
      </div>
      <div class="tt-panel-subtitle">Denomination count</div>
      <div class="tt-cash-denom-grid">
        ${CASH_DENOMINATIONS.map((d) => `<div class="tt-cash-denom-row">
          <label for="ttDenom_${d.key}">${esc(d.label)}</label>
          <input class="tt-input tt-cash-denom-qty" type="number" min="0" step="1" id="ttDenom_${d.key}" data-denom="${d.key}" value="" placeholder="0" inputmode="numeric">
        </div>`).join('')}
      </div>
      <div class="tt-cash-total-row"><span>Counted total</span><span id="ttCashLiveTotal">$0.00</span></div>
      <div class="tt-field"><label for="ttCashNotes">Notes</label><input class="tt-input" id="ttCashNotes" placeholder="optional"></div>
      <div class="tt-pin-error" id="ttCashError" role="alert" aria-live="assertive"></div>
      <div class="tt-actions-row"><button class="tt-btn" id="ttSaveCash">Save cash count</button></div>
    </div>
    ${isManager() ? `
    <div class="tt-panel">
      <h2 class="tt-panel-title">History (by register — never combined into one total)</h2>
      ${Object.entries(byRegister).map(([reg, cs]) => `
        <div class="tt-panel-subtitle">${esc(reg)}</div>
        <div class="tt-list-rows">
        ${cs.map((c) => cashRowHtml(c)).join('')}
        </div>
      `).join('') || '<div class="tt-empty">No counts logged yet.</div>'}
    </div>` : `<div class="tt-panel"><div class="tt-empty">Cash history is visible to managers only.</div></div>`}
  `;

  CASH_DENOMINATIONS.forEach((d) => root.querySelector(`[data-denom="${d.key}"]`).addEventListener('input', () => updateLiveTotal(root)));

  root.querySelectorAll('[data-breakdown]').forEach((btn) => btn.addEventListener('click', () => {
    const c = counts.find((x) => x.id === btn.dataset.breakdown);
    if (c) openBreakdownModal(c);
  }));
  root.querySelectorAll('[data-approve]').forEach((btn) => btn.addEventListener('click', async () => {
    try {
      await db.approveCashCount(btn.dataset.approve, sess.staffId);
      toast('Cash count approved');
      renderCash(root);
    } catch (e) {
      toast(e instanceof db.ValidationError ? e.message : 'Could not approve', { error: true });
    }
  }));

  root.querySelector('#ttSaveCash').addEventListener('click', () => saveFlow(root, sess));
}

function cashRowHtml(c) {
  const varianceOk = c.expectedCash != null;
  const variance = varianceOk ? Math.round((c.countedCash - c.expectedCash) * 100) / 100 : null;
  return `<div class="tt-list-row">
    <div>
      <div class="tt-list-row-name">$${Number(c.countedCash).toFixed(2)}${varianceOk ? ` <span class="${variance !== 0 ? (variance < 0 ? 'neg' : 'pos') : ''}">(${variance > 0 ? '+' : ''}${variance.toFixed(2)} vs expected)</span>` : ''}</div>
      <div class="tt-list-row-sub">${esc(CASH_SHIFTS.find((s) => s.key === c.shift)?.label || c.shift)} · ${esc(formatBrisbaneDate(c.countDate))} · ${esc(c.staffName)}${c.recountOfId ? ' · recount' : ''}${c.notes ? ' · ' + esc(c.notes) : ''}</div>
      <div class="tt-list-row-sub">${c.approvedBy ? `Approved by ${esc(c.approverName)}` : 'Needs approval'}</div>
    </div>
    <div style="display:flex; flex-direction:column; gap:4px; align-items:flex-end;">
      <button class="tt-icon-btn" data-breakdown="${c.id}">Breakdown</button>
      ${!c.approvedBy ? `<button class="tt-icon-btn" data-approve="${c.id}">Approve</button>` : ''}
    </div>
  </div>`;
}

function openBreakdownModal(c) {
  const dialog = openModal(`
    <h2 id="tt-cash-breakdown-title" class="tt-modal-title">Denomination breakdown</h2>
    <p class="tt-modal-body">${esc(c.register)} · ${esc(CASH_SHIFTS.find((s) => s.key === c.shift)?.label || c.shift)} · ${esc(formatBrisbaneDate(c.countDate))}</p>
    <div class="tt-list-rows">
      ${CASH_DENOMINATIONS.filter((d) => (c.denominations[d.key] || 0) > 0).map((d) => `<div class="tt-list-row">
        <div class="tt-list-row-name">${esc(d.label)} &times; ${c.denominations[d.key]}</div>
        <div>$${(d.value * c.denominations[d.key]).toFixed(2)}</div>
      </div>`).join('') || '<div class="tt-empty">No denominations recorded.</div>'}
    </div>
    <div class="tt-modal-actions"><button class="tt-btn" id="ttBreakdownClose">Close</button></div>
  `, { labelledBy: 'tt-cash-breakdown-title' });
  dialog.querySelector('#ttBreakdownClose').addEventListener('click', closeModal);
}

async function saveFlow(root, sess, recountReason) {
  const errEl = root.querySelector('#ttCashError');
  errEl.textContent = '';
  const payload = {
    storeId: sess.storeId,
    register: root.querySelector('#ttCashRegister').value.trim(),
    shift: root.querySelector('#ttCashShift').value,
    expectedCash: root.querySelector('#ttCashExpected').value,
    denominations: readDenominations(root),
    notes: root.querySelector('#ttCashNotes').value,
    staffId: sess.staffId,
    recountReason,
  };
  try {
    await db.saveCashCount(payload);
    toast('Cash count saved');
    renderCash(root);
  } catch (e) {
    if (e instanceof db.ConflictError) {
      const proceed = await confirmDialog({
        title: 'Already counted today', body: esc(e.message),
        confirmLabel: 'Recount anyway', danger: true,
      });
      if (!proceed) return;
      const reason = await promptRecountReason();
      if (reason) await saveFlow(root, sess, reason);
      return;
    }
    if (e instanceof db.ValidationError) { errEl.textContent = e.message; return; }
    errEl.textContent = 'Could not save — try again.';
    console.error(e);
  }
}

/** Accessible replacement for window.prompt() — matches stocktake.js's recount reason field. */
function promptRecountReason() {
  return promptText({
    title: 'Reason for recount', label: 'Reason for recount',
    placeholder: 'e.g. Miscounted first time, recounted with manager',
    confirmLabel: 'Save recount',
  });
}
