/**
 * Orders tab. Intentionally lightweight for Phase 4 — a working reorder
 * list grouped by category (ported from the original's "Needs Ordering"
 * panel, adapted to the new store_inventory shape). The full ordering
 * workflow (suggested qty from lead time/safety stock, supplier grouping,
 * pack rounding, draft/sent/received status) is Priority 7 and will expand
 * this file rather than replace it.
 */
import * as db from './database.js';
import { getSession } from './auth.js';
import { esc, icon, fmtQty, toast } from './ui.js';
import { CATEGORIES } from './config.js';

export async function renderOrders(root) {
  const sess = getSession();
  const list = await db.getReorderList(sess.storeId);

  if (!list.length) {
    root.innerHTML = `<div class="tt-panel"><div class="tt-empty"><b>Nothing needs ordering</b>Every item is above its reorder point right now.</div></div>`;
    return;
  }

  const groups = {};
  list.forEach((i) => { (groups[i.item.categoryKey] = groups[i.item.categoryKey] || []).push(i); });

  root.innerHTML = `
    <div class="tt-order-header">
      <div class="tt-panel-title">Needs ordering today · ${list.length}</div>
      <button class="tt-btn ghost" id="ttCopyOrder">Copy list</button>
    </div>
    ${Object.entries(groups).map(([key, items]) => `
      <div class="tt-panel">
        <div class="tt-order-group-title">${esc(CATEGORIES[key]?.label || key)}</div>
        ${items.map((i) => `<div class="tt-list-row">
          <div><div class="tt-list-row-name">${esc(i.item.name)}</div>
          <div class="tt-list-row-sub">${fmtQty(i.currentStock)} ${esc(i.unit)} on hand · reorder point ${i.reorderPoint}</div></div>
          ${i.supplierUrl ? `<a class="tt-link-btn" href="${esc(i.supplierUrl)}" target="_blank" rel="noopener noreferrer">Order ${icon('chevronRight', 12)}</a>` : ''}
        </div>`).join('')}
      </div>`).join('')}
  `;

  root.querySelector('#ttCopyOrder').addEventListener('click', async () => {
    const text = Object.entries(groups).map(([key, items]) =>
      `${CATEGORIES[key]?.label || key}\n${items.map((i) => `- ${i.item.name}: ${fmtQty(i.currentStock)} ${i.unit} on hand`).join('\n')}`,
    ).join('\n\n');
    try { await navigator.clipboard.writeText(text); toast('Order list copied'); }
    catch { toast('Could not copy', { error: true }); }
  });
}
