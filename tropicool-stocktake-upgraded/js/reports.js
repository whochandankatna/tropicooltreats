/**
 * Reports tab — Priority 8. A report picker plus one panel at a time:
 * today's stocktake (Phase 4), staff completion, waste, expiry, valuation,
 * orders, and (managers only) the audit log. Every report can be exported
 * as a real CSV or JSON file (Blob download, no server round-trip) or
 * printed — "Print" uses the browser's own print-to-PDF via window.print(),
 * not a generated PDF file, which is the honest way to describe it rather
 * than claiming a PDF export this app doesn't build (working rule 7).
 *
 * Valuation and the audit log are manager-only, matching the fact that
 * unit cost is already only ever shown to managers elsewhere (the Items
 * edit drawer) and audit entries can include before/after state a staff
 * account has no reason to see.
 */
import * as db from './database.js';
import { getSession, isManager } from './auth.js';
import { esc, fmtQty, toast, downloadFile, toCSV } from './ui.js';
import { formatBrisbaneDate, formatBrisbaneInstant } from './date.js';
import { CATEGORIES, decimalsForUnit } from './config.js';

const REPORTS = [
  { key: 'stocktake', label: "Today's stocktake" },
  { key: 'staff', label: 'Staff completion' },
  { key: 'waste', label: 'Waste' },
  { key: 'expiry', label: 'Expiry' },
  { key: 'valuation', label: 'Valuation', managerOnly: true },
  { key: 'orders', label: 'Orders' },
  { key: 'audit', label: 'Audit log', managerOnly: true },
];

let activeReport = 'stocktake';

export async function renderReports(root) {
  const sess = getSession();
  const visibleReports = REPORTS.filter((r) => !r.managerOnly || isManager());
  if (!visibleReports.find((r) => r.key === activeReport)) activeReport = visibleReports[0].key;

  root.innerHTML = `
    <div class="tt-report-picker" role="tablist" aria-label="Choose a report">
      ${visibleReports.map((r) => `<button class="tt-report-tab ${r.key === activeReport ? 'active' : ''}" data-report="${r.key}" role="tab" aria-selected="${r.key === activeReport}">${esc(r.label)}</button>`).join('')}
    </div>
    <div id="ttReportBody"></div>
  `;
  root.querySelectorAll('[data-report]').forEach((btn) => btn.addEventListener('click', () => {
    activeReport = btn.dataset.report;
    renderReports(root);
  }));

  const body = root.querySelector('#ttReportBody');
  const renderers = {
    stocktake: renderStocktakeReport, staff: renderStaffReport, waste: renderWasteReport,
    expiry: renderExpiryReport, valuation: renderValuationReport, orders: renderOrdersReport, audit: renderAuditReport,
  };
  await renderers[activeReport](body, sess);
}

function reportActionsHtml() {
  return `<div class="tt-report-actions">
    <button class="tt-btn ghost" data-export="csv">Export CSV</button>
    <button class="tt-btn ghost" data-export="json">Export JSON</button>
    <button class="tt-btn ghost" data-print>Print</button>
  </div>`;
}
function wireReportActions(body, { filenameBase, headers, csvRows, jsonData }) {
  body.querySelector('[data-export="csv"]')?.addEventListener('click', () => {
    downloadFile(`${filenameBase}.csv`, 'text/csv', toCSV(headers, csvRows));
    toast('CSV downloaded');
  });
  body.querySelector('[data-export="json"]')?.addEventListener('click', () => {
    downloadFile(`${filenameBase}.json`, 'application/json', JSON.stringify(jsonData, null, 2));
    toast('JSON downloaded');
  });
  body.querySelector('[data-print]')?.addEventListener('click', () => window.print());
}

async function renderStocktakeReport(body, sess) {
  const session = await db.getOrStartSession(sess.storeId, sess.staffId);
  const lines = await db.getCountLines(session.id);
  const inventory = await db.getStoreInventory(sess.storeId);

  const rows = lines.map((l) => {
    const inv = inventory.find((i) => i.id === l.storeInventoryId);
    return { name: inv?.item?.name || 'Item', unit: l.unit, system: l.systemQty, counted: l.countedQty, variance: l.countedQty - l.systemQty };
  }).sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance));

  body.innerHTML = `
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
      </div>
      ${reportActionsHtml()}` : `<div class="tt-empty">No counts logged yet today.</div>`}
    </div>
  `;
  if (rows.length) {
    wireReportActions(body, {
      filenameBase: `stocktake-${session.businessDate}`,
      headers: ['Item', 'Unit', 'System', 'Counted', 'Variance'],
      csvRows: rows.map((r) => [r.name, r.unit, r.system, r.counted, r.variance]),
      jsonData: rows,
    });
  }
}

async function renderStaffReport(body, sess) {
  const session = await db.getOrStartSession(sess.storeId, sess.staffId);
  const rows = await db.getStaffCompletion(session.id, sess.storeId);
  const inventory = await db.getStoreInventory(sess.storeId);
  const totalItems = inventory.length;

  body.innerHTML = `
    <div class="tt-panel">
      <div class="tt-panel-title">Staff completion — ${esc(formatBrisbaneDate(session.businessDate))}</div>
      <div class="tt-panel-sub">${totalItems} items in this store's count</div>
      ${rows.length ? `
      <div class="tt-report-table-wrap">
        <table class="tt-report-table">
          <thead><tr><th>Staff</th><th>Role</th><th>Items counted</th><th>% of store</th></tr></thead>
          <tbody>
            ${rows.map((r) => `<tr>
              <td>${esc(r.name)}</td>
              <td>${esc(r.role)}</td>
              <td>${r.countedItems}</td>
              <td>${totalItems ? Math.round((r.countedItems / totalItems) * 100) : 0}%</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${reportActionsHtml()}` : `<div class="tt-empty">No active staff at this store.</div>`}
    </div>
  `;
  if (rows.length) {
    wireReportActions(body, {
      filenameBase: `staff-completion-${session.businessDate}`,
      headers: ['Staff', 'Role', 'Items counted', 'Total items', 'Percent'],
      csvRows: rows.map((r) => [r.name, r.role, r.countedItems, totalItems, totalItems ? Math.round((r.countedItems / totalItems) * 100) : 0]),
      jsonData: rows,
    });
  }
}

async function renderWasteReport(body, sess) {
  const rows = await db.getWasteReport(sess.storeId, 30);
  const totalCost = rows.reduce((sum, r) => sum + (r.estimatedCost ?? 0), 0);
  const missingCost = rows.filter((r) => r.estimatedCost == null).length;

  body.innerHTML = `
    <div class="tt-panel">
      <div class="tt-panel-title">Waste — last 30 days</div>
      <div class="tt-panel-sub">${rows.length} record${rows.length === 1 ? '' : 's'} · estimated cost $${totalCost.toFixed(2)}${missingCost ? ` (${missingCost} with no unit cost on file, not included)` : ''}</div>
      ${rows.length ? `
      <div class="tt-report-table-wrap">
        <table class="tt-report-table">
          <thead><tr><th>Item</th><th>Quantity</th><th>Reason</th><th>Staff</th><th>Date</th><th>Est. cost</th></tr></thead>
          <tbody>
            ${rows.map((r) => `<tr>
              <td>${esc(r.itemName)}</td>
              <td>${fmtQty(r.quantity, decimalsForUnit(r.unit))} ${esc(r.unit)}</td>
              <td>${esc(r.reason || '')}</td>
              <td>${esc(r.staffName)}</td>
              <td>${esc(formatBrisbaneInstant(r.occurredAt))}</td>
              <td>${r.estimatedCost != null ? '$' + r.estimatedCost.toFixed(2) : '—'}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${reportActionsHtml()}` : `<div class="tt-empty">No waste logged in the last 30 days.</div>`}
    </div>
  `;
  if (rows.length) {
    wireReportActions(body, {
      filenameBase: 'waste-last-30-days',
      headers: ['Item', 'Quantity', 'Unit', 'Reason', 'Staff', 'Date', 'Estimated cost'],
      csvRows: rows.map((r) => [r.itemName, r.quantity, r.unit, r.reason || '', r.staffName, r.occurredAt, r.estimatedCost ?? '']),
      jsonData: rows,
    });
  }
}

async function renderExpiryReport(body, sess) {
  const alerts = await db.getExpiryAlerts(sess.storeId, 14);
  alerts.sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry);

  body.innerHTML = `
    <div class="tt-panel">
      <div class="tt-panel-title">Expiry — next 14 days</div>
      <div class="tt-panel-sub">${alerts.length} batch${alerts.length === 1 ? '' : 'es'} expired or expiring soon</div>
      ${alerts.length ? `
      <div class="tt-report-table-wrap">
        <table class="tt-report-table">
          <thead><tr><th>Item</th><th>On hand in batch</th><th>Use-by</th><th>Status</th></tr></thead>
          <tbody>
            ${alerts.map((a) => `<tr>
              <td>${esc(a.inventory.item.name)}</td>
              <td>${fmtQty(a.batch.quantityRemaining, decimalsForUnit(a.inventory.unit))} ${esc(a.inventory.unit)}</td>
              <td>${esc(formatBrisbaneDate(a.batch.useByDate))}</td>
              <td class="${a.daysUntilExpiry < 0 ? 'neg' : ''}">${a.daysUntilExpiry < 0 ? `Expired ${Math.abs(a.daysUntilExpiry)}d ago` : a.daysUntilExpiry === 0 ? 'Expires today' : `${a.daysUntilExpiry}d left`}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${reportActionsHtml()}` : `<div class="tt-empty">Nothing expired or expiring in the next 14 days.</div>`}
    </div>
  `;
  if (alerts.length) {
    wireReportActions(body, {
      filenameBase: 'expiry-next-14-days',
      headers: ['Item', 'Quantity remaining', 'Unit', 'Use-by', 'Days until expiry'],
      csvRows: alerts.map((a) => [a.inventory.item.name, a.batch.quantityRemaining, a.inventory.unit, a.batch.useByDate, a.daysUntilExpiry]),
      jsonData: alerts.map((a) => ({ itemName: a.inventory.item.name, quantityRemaining: a.batch.quantityRemaining, unit: a.inventory.unit, useByDate: a.batch.useByDate, daysUntilExpiry: a.daysUntilExpiry })),
    });
  }
}

async function renderValuationReport(body, sess) {
  const { rows, total, missingCostCount } = await db.getValuationReport(sess.storeId);
  const byCategory = {};
  rows.forEach((r) => { (byCategory[r.categoryKey] = byCategory[r.categoryKey] || []).push(r); });

  body.innerHTML = `
    <div class="tt-panel">
      <div class="tt-panel-title">Stock valuation</div>
      <div class="tt-panel-sub">Total on hand: $${total.toFixed(2)}${missingCostCount ? ` · ${missingCostCount} item${missingCostCount === 1 ? '' : 's'} with no unit cost on file (excluded from the total, not counted as $0)` : ''}</div>
      ${rows.length ? Object.entries(byCategory).map(([key, items]) => {
        const subtotal = items.reduce((sum, r) => sum + (r.value ?? 0), 0);
        return `<div class="tt-order-group-title"><span>${esc(CATEGORIES[key]?.label || key)}</span><span>$${subtotal.toFixed(2)}</span></div>
        <div class="tt-report-table-wrap">
          <table class="tt-report-table">
            <thead><tr><th>Item</th><th>On hand</th><th>Unit cost</th><th>Value</th></tr></thead>
            <tbody>
              ${items.map((r) => `<tr>
                <td>${esc(r.itemName)}</td>
                <td>${fmtQty(r.currentStock, decimalsForUnit(r.unit))} ${esc(r.unit)}</td>
                <td>${r.unitCost != null ? '$' + r.unitCost.toFixed(2) : '—'}</td>
                <td>${r.value != null ? '$' + r.value.toFixed(2) : 'no cost set'}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>`;
      }).join('') + reportActionsHtml() : `<div class="tt-empty">No items to value.</div>`}
    </div>
  `;
  if (rows.length) {
    wireReportActions(body, {
      filenameBase: 'stock-valuation',
      headers: ['Item', 'Category', 'On hand', 'Unit', 'Unit cost', 'Value'],
      csvRows: rows.map((r) => [r.itemName, CATEGORIES[r.categoryKey]?.label || r.categoryKey, r.currentStock, r.unit, r.unitCost ?? '', r.value ?? '']),
      jsonData: { total, missingCostCount, rows },
    });
  }
}

async function renderOrdersReport(body, sess) {
  const orders = await db.getOrders(sess.storeId);

  body.innerHTML = `
    <div class="tt-panel">
      <div class="tt-panel-title">Orders</div>
      <div class="tt-panel-sub">${orders.length} order${orders.length === 1 ? '' : 's'} total</div>
      ${orders.length ? `
      <div class="tt-report-table-wrap">
        <table class="tt-report-table">
          <thead><tr><th>Supplier</th><th>Status</th><th>Items</th><th>Created</th></tr></thead>
          <tbody>
            ${orders.map((o) => `<tr>
              <td>${esc(o.supplierName)}</td>
              <td>${esc(o.status)}</td>
              <td>${o.lines.length}</td>
              <td>${esc(formatBrisbaneInstant(o.createdAt))}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${reportActionsHtml()}` : `<div class="tt-empty">No orders placed yet.</div>`}
    </div>
  `;
  if (orders.length) {
    wireReportActions(body, {
      filenameBase: 'orders',
      headers: ['Supplier', 'Status', 'Item count', 'Created'],
      csvRows: orders.map((o) => [o.supplierName, o.status, o.lines.length, o.createdAt]),
      jsonData: orders,
    });
  }
}

async function renderAuditReport(body, sess) {
  const entries = await db.getAuditLog(sess.storeId, 200);

  body.innerHTML = `
    <div class="tt-panel">
      <div class="tt-panel-title">Audit log</div>
      <div class="tt-panel-sub">Most recent ${entries.length} action${entries.length === 1 ? '' : 's'} at this store</div>
      ${entries.length ? `
      <div class="tt-report-table-wrap">
        <table class="tt-report-table">
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Entity</th></tr></thead>
          <tbody>
            ${entries.map((a) => `<tr>
              <td>${esc(formatBrisbaneInstant(a.occurredAt, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}</td>
              <td>${esc(a.actorName)}</td>
              <td>${esc(a.action)}</td>
              <td>${esc(a.entityType)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${reportActionsHtml()}` : `<div class="tt-empty">No actions logged yet.</div>`}
    </div>
  `;
  if (entries.length) {
    wireReportActions(body, {
      filenameBase: 'audit-log',
      headers: ['When', 'Who', 'Action', 'Entity type', 'Entity id'],
      csvRows: entries.map((a) => [a.occurredAt, a.actorName, a.action, a.entityType, a.entityId]),
      jsonData: entries,
    });
  }
}
