/**
 * Cash count — Phase 4 keeps this intentionally simple (register, expected
 * vs counted, staff, notes) rather than implementing the full Priority 9
 * redesign (denomination calculator, shift, manager approval) yet. Crucial
 * fix already in place though: counts are never summed into one "today's
 * total" figure across registers (AUDIT.md §8's flagged anti-pattern) —
 * each register's counts are shown separately.
 */
import * as db from './database.js';
import { getSession, isManager } from './auth.js';
import { esc, fmtQty, toast } from './ui.js';
import { formatBrisbaneDate } from './date.js';

export async function renderCash(root) {
  const sess = getSession();
  const counts = await db.getCashCounts(sess.storeId);
  const today = counts.filter((c) => c.countDate === counts[0]?.countDate);

  const byRegister = {};
  counts.forEach((c) => { (byRegister[c.register || 'Register'] = byRegister[c.register || 'Register'] || []).push(c); });

  root.innerHTML = `
    <div class="tt-panel">
      <div class="tt-panel-title">Cash count</div>
      <div class="tt-form">
        <div class="tt-field"><label for="ttCashRegister">Register</label><input class="tt-input" id="ttCashRegister" placeholder="Front counter"></div>
        <div class="tt-field"><label for="ttCashExpected">Expected ($)</label><input class="tt-input" type="number" min="0" step="0.05" id="ttCashExpected" placeholder="optional"></div>
        <div class="tt-field"><label for="ttCashCounted">Counted ($)</label><input class="tt-input" type="number" min="0" step="0.05" id="ttCashCounted"></div>
        <div class="tt-field"><label for="ttCashNotes">Notes</label><input class="tt-input" id="ttCashNotes" placeholder="optional"></div>
      </div>
      <div class="tt-actions-row"><button class="tt-btn" id="ttSaveCash">Save cash count</button></div>
    </div>
    ${isManager() ? `
    <div class="tt-panel">
      <div class="tt-panel-title">History (by register — never combined into one total)</div>
      ${Object.entries(byRegister).map(([reg, cs]) => `
        <div class="tt-panel-subtitle">${esc(reg)}</div>
        ${cs.map((c) => `<div class="tt-list-row"><div><div class="tt-list-row-name">$${Number(c.countedCash).toFixed(2)}${c.expectedCash != null ? ` <span class="${c.variance !== 0 ? (c.variance < 0 ? 'neg' : 'pos') : ''}">(${c.variance > 0 ? '+' : ''}${c.variance.toFixed(2)} vs expected)</span>` : ''}</div><div class="tt-list-row-sub">${esc(formatBrisbaneDate(c.countDate))}${c.notes ? ' · ' + esc(c.notes) : ''}</div></div></div>`).join('')}
      `).join('') || '<div class="tt-empty">No counts logged yet.</div>'}
    </div>` : `<div class="tt-panel"><div class="tt-empty">Cash history is visible to managers only.</div></div>`}
  `;

  root.querySelector('#ttSaveCash').addEventListener('click', async () => {
    const counted = root.querySelector('#ttCashCounted').value;
    if (counted === '' || Number(counted) < 0) { toast('Enter a valid counted amount', { error: true }); return; }
    await db.saveCashCount({
      storeId: sess.storeId,
      register: root.querySelector('#ttCashRegister').value.trim() || 'Register',
      shift: null,
      expectedCash: root.querySelector('#ttCashExpected').value,
      countedCash: counted,
      staffId: sess.staffId,
      notes: root.querySelector('#ttCashNotes').value.trim(),
    });
    toast('Cash count saved');
    renderCash(root);
  });
}
