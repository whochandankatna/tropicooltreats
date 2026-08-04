/**
 * Reports tab. Phase 4 ships one real report — today's stocktake, with
 * opening/system/counted/variance per counted item, matching Priority 8's
 * "Do not combine kilograms, boxes, bottles and tubs into one meaningless
 * total" by keeping variance per-unit rather than summed across units. The
 * full Reports area (waste, valuation, expiry, supplier orders, staff
 * completion, exports) is Priority 8 and will add tabs here, not replace
 * this one.
 */
import * as db from './database.js';
import { getSession } from './auth.js';
import { esc, fmtQty } from './ui.js';
import { formatBrisbaneDate } from './date.js';

export async function renderReports(root) {
  const sess = getSession();
  const session = await db.getOrStartSession(sess.storeId, sess.staffId);
  const lines = await db.getCountLines(session.id);
  const inventory = await db.getStoreInventory(sess.storeId);

  const rows = lines.map((l) => {
    const inv = inventory.find((i) => i.id === l.storeInventoryId);
    const variance = l.countedQty - l.systemQty;
    return { name: inv?.item?.name || 'Item', unit: l.unit, system: l.systemQty, counted: l.countedQty, variance };
  }).sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance));

  root.innerHTML = `
    <div class="tt-panel">
      <div class="tt-panel-title">Today's stocktake — ${esc(formatBrisbaneDate(session.businessDate))}</div>
      <div class="tt-panel-sub">${lines.length} of ${inventory.length} items counted · status: ${esc(session.status)}</div>
      ${rows.length ? `
      <div class="tt-report-table-wrap">
        <table class="tt-report-table">
          <thead><tr><th>Item</th><th>System</th><th>Counted</th><th>Variance</th></tr></thead>
          <tbody>
            ${rows.map((r) => `<tr>
              <td>${esc(r.name)}</td>
              <td>${fmtQty(r.system, 1)} ${esc(r.unit)}</td>
              <td>${fmtQty(r.counted, 1)} ${esc(r.unit)}</td>
              <td class="${r.variance < 0 ? 'neg' : r.variance > 0 ? 'pos' : ''}">${r.variance > 0 ? '+' : ''}${fmtQty(r.variance, 1)} ${esc(r.unit)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>` : `<div class="tt-empty">No counts logged yet today.</div>`}
    </div>
    <div class="tt-panel">
      <div class="tt-panel-title">More reports</div>
      <div class="tt-empty">Waste, valuation, expiry, supplier orders, staff completion, and exports land in a later phase (Priority 8) — this area will grow into a full Reports section rather than being replaced.</div>
    </div>
  `;
}
