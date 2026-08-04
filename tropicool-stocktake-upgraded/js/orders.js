/**
 * Orders tab — Priority 7. Two parts: a "Needs ordering" list grouped by
 * supplier with a suggested quantity (managers can select items and turn a
 * group into a draft order), and order history (draft/sent/received/
 * cancelled) with status-appropriate actions. See database.js's "Purchase
 * orders" section for the full draft -> sent -> received/cancelled model
 * and why receiving is the point stock actually changes.
 *
 * This never contacts a supplier itself — "sent" and "received" are the
 * human telling the app what they already did (working rule 6).
 */
import * as db from './database.js';
import { getSession, isManager } from './auth.js';
import { esc, icon, fmtQty, toast, confirmDialog, promptText, openModal, closeModal } from './ui.js';
import { formatBrisbaneDate, brisbaneDateISO } from './date.js';
import { decimalsForUnit } from './config.js';

const NO_SUPPLIER = 'No supplier set';
let selected = {}; // { [storeInventoryId]: qty } — persists across re-renders within a visit to the tab

/**
 * Order timestamps are stored as full ISO instants (created_at etc, not a
 * pre-computed business-date field like session.businessDate/batch.receivedDate
 * elsewhere) — so, matching date.js's own warning against deriving a date
 * from raw UTC, this converts via brisbaneDateISO rather than naively
 * slicing the first 10 characters, which would show the wrong calendar day
 * for anything logged 10am Brisbane or earlier (still "yesterday" in UTC).
 */
function brisbaneDateOf(isoInstant) {
  return brisbaneDateISO(new Date(isoInstant));
}

export async function renderOrders(root) {
  const sess = getSession();
  const [reorderList, history] = await Promise.all([db.getReorderList(sess.storeId), db.getOrders(sess.storeId)]);

  const groups = {};
  reorderList.forEach((i) => { (groups[i.supplierName || NO_SUPPLIER] = groups[i.supplierName || NO_SUPPLIER] || []).push(i); });
  reorderList.forEach((i) => { if (!(i.id in selected)) selected[i.id] = i.suggestedQty || 1; });

  root.innerHTML = `
    <div class="tt-order-header">
      <div class="tt-panel-title">Needs ordering today · ${reorderList.length}</div>
      ${reorderList.length ? `<button class="tt-btn ghost" id="ttCopyOrder">Copy list</button>` : ''}
    </div>
    ${!reorderList.length ? `<div class="tt-panel"><div class="tt-empty"><b>Nothing needs ordering</b>Every item is above its reorder point right now.</div></div>` : ''}
    ${Object.entries(groups).map(([supplierName, items]) => `
      <div class="tt-panel">
        <div class="tt-order-group-title"><span>${esc(supplierName)}</span>${isManager() ? `<button class="tt-btn ghost" data-create-order="${esc(supplierName)}">Create order</button>` : ''}</div>
        ${items.map((i) => `<div class="tt-order-line-row">
          ${isManager() ? `<input type="checkbox" class="tt-order-line-check" data-select="${i.id}" ${selected[i.id] ? 'checked' : ''} aria-label="Include ${esc(i.item.name)} in order">` : ''}
          <div class="tt-order-line-main">
            <div class="tt-order-line-name">${esc(i.item.name)}</div>
            <div class="tt-order-line-sub">${fmtQty(i.currentStock, decimalsForUnit(i.unit))} ${esc(i.unit)} on hand · reorder point ${fmtQty(i.reorderPoint, decimalsForUnit(i.unit))}${i.leadTimeDays != null ? ` · ${i.leadTimeDays}d lead time` : ''}${i.safetyStockDays != null ? ` · ${i.safetyStockDays}d safety stock` : ''}</div>
          </div>
          ${isManager() ? `<input class="tt-input tt-order-line-qty" type="number" min="0" step="0.01" data-qty="${i.id}" value="${selected[i.id] ?? i.suggestedQty}" aria-label="Order quantity for ${esc(i.item.name)}">` : `<div class="tt-order-line-sub">Suggested ${fmtQty(i.suggestedQty, decimalsForUnit(i.unit))} ${esc(i.unit)}</div>`}
          ${i.supplierUrl ? `<a class="tt-link-btn" href="${esc(i.supplierUrl)}" target="_blank" rel="noopener noreferrer">${icon('chevronRight', 12)}</a>` : ''}
        </div>`).join('')}
      </div>`).join('')}

    <div class="tt-panel-title" style="margin-top:var(--sp-5);">Order history</div>
    ${!history.length ? `<div class="tt-panel"><div class="tt-empty">No orders placed yet.</div></div>` : `
      <div class="tt-list-rows">
        ${history.map((o) => `<button class="tt-order-history-row" data-open-order="${o.id}">
          <div>
            <div class="tt-list-row-name">${esc(o.supplierName)}</div>
            <div class="tt-list-row-sub">${o.lines.length} item${o.lines.length === 1 ? '' : 's'} · ${esc(formatBrisbaneDate(brisbaneDateOf(o.createdAt)))}</div>
          </div>
          <span class="tt-status-badge ${o.status}">${esc(o.status)}</span>
        </button>`).join('')}
      </div>`}
  `;

  root.querySelector('#ttCopyOrder')?.addEventListener('click', async () => {
    const text = Object.entries(groups).map(([supplierName, items]) =>
      `${supplierName}\n${items.map((i) => `- ${i.item.name}: ${fmtQty(i.currentStock, decimalsForUnit(i.unit))} ${i.unit} on hand, suggested ${fmtQty(i.suggestedQty, decimalsForUnit(i.unit))} ${i.unit}`).join('\n')}`,
    ).join('\n\n');
    try { await navigator.clipboard.writeText(text); toast('Order list copied'); }
    catch { toast('Could not copy', { error: true }); }
  });

  root.querySelectorAll('[data-select]').forEach((cb) => cb.addEventListener('change', (e) => {
    if (!e.target.checked) delete selected[e.target.dataset.select];
    else selected[e.target.dataset.select] = Number(root.querySelector(`[data-qty="${e.target.dataset.select}"]`)?.value) || 1;
  }));
  root.querySelectorAll('[data-qty]').forEach((inp) => inp.addEventListener('input', (e) => {
    const id = e.target.dataset.qty;
    const checkbox = root.querySelector(`[data-select="${id}"]`);
    if (checkbox && !checkbox.checked) return; // ignore edits to a currently-excluded item
    selected[id] = Number(e.target.value) || 0;
  }));
  root.querySelectorAll('[data-create-order]').forEach((btn) => btn.addEventListener('click', () =>
    createOrderFromGroup(root, btn.dataset.createOrder, groups[btn.dataset.createOrder])));
  root.querySelectorAll('[data-open-order]').forEach((btn) => btn.addEventListener('click', () =>
    openOrderDetail(root, history.find((o) => o.id === btn.dataset.openOrder))));
}

async function createOrderFromGroup(root, supplierName, items) {
  const sess = getSession();
  const lines = items
    .filter((i) => selected[i.id] > 0)
    .map((i) => ({ storeInventoryId: i.id, quantityOrdered: selected[i.id] }));
  if (!lines.length) { toast('Select at least one item to order', { error: true }); return; }
  try {
    await db.createDraftOrder({ storeId: sess.storeId, supplierName, lines, actorId: sess.staffId });
    items.forEach((i) => delete selected[i.id]);
    toast(`Draft order created for ${supplierName}`);
    renderOrders(root);
  } catch (e) {
    toast(e instanceof db.ValidationError ? e.message : 'Could not create order', { error: true });
  }
}

function orderMeta(o) {
  if (o.status === 'sent') return `Sent ${formatBrisbaneDate(brisbaneDateOf(o.sentAt))}`;
  if (o.status === 'received') return `Received ${formatBrisbaneDate(brisbaneDateOf(o.receivedAt))}`;
  if (o.status === 'cancelled') return `Cancelled${o.cancelReason ? ' — ' + o.cancelReason : ''}`;
  return `Created ${formatBrisbaneDate(brisbaneDateOf(o.createdAt))}`;
}

async function openOrderDetail(root, order) {
  if (!order) return;
  const editable = order.status === 'draft' && isManager();
  const dialog = openModal(`
    <h2 id="tt-order-title" class="tt-modal-title">${esc(order.supplierName)} <span class="tt-status-badge ${order.status}">${esc(order.status)}</span></h2>
    <p class="tt-modal-body">${esc(orderMeta(order))}</p>
    <div class="tt-list-rows" id="ttOrderLines">
      ${order.lines.map((l) => `<div class="tt-order-line-row">
        <div class="tt-order-line-main">
          <div class="tt-order-line-name">${esc(l.itemName)}</div>
          <div class="tt-order-line-sub">Ordered ${fmtQty(l.quantityOrdered, decimalsForUnit(l.unit))} ${esc(l.unit)}${l.quantityReceived != null ? ` · received ${fmtQty(l.quantityReceived, decimalsForUnit(l.unit))} ${esc(l.unit)}` : ''}</div>
        </div>
        ${editable ? `<input class="tt-input tt-order-line-qty" type="number" min="0.01" step="0.01" value="${l.quantityOrdered}" data-line-qty="${l.id}">
          <button class="tt-icon-btn danger" data-line-remove="${l.id}" aria-label="Remove ${esc(l.itemName)}">×</button>` : ''}
      </div>`).join('')}
    </div>
    <div class="tt-pin-error" id="ttOrderError" role="alert" aria-live="assertive"></div>
    <div class="tt-modal-actions">
      <button class="tt-btn ghost" id="ttOrderClose">Close</button>
      ${isManager() && order.status === 'draft' ? `<button class="tt-btn ghost" data-action="cancel-order">Cancel order</button><button class="tt-btn" data-action="send-order">Mark as sent</button>` : ''}
      ${isManager() && order.status === 'sent' ? `<button class="tt-btn ghost" data-action="cancel-order">Cancel order</button><button class="tt-btn" data-action="receive-order">Mark as received</button>` : ''}
    </div>
  `, { labelledBy: 'tt-order-title' });

  dialog.querySelector('#ttOrderClose').addEventListener('click', closeModal);

  dialog.querySelectorAll('[data-line-qty]').forEach((inp) => inp.addEventListener('change', async (e) => {
    const errEl = dialog.querySelector('#ttOrderError');
    errEl.textContent = '';
    try {
      await db.updateOrderLineQty(e.target.dataset.lineQty, e.target.value, getSession().staffId);
      toast('Quantity updated');
    } catch (err) {
      errEl.textContent = err instanceof db.ValidationError ? err.message : 'Could not update quantity.';
    }
  }));
  dialog.querySelectorAll('[data-line-remove]').forEach((btn) => btn.addEventListener('click', async () => {
    const errEl = dialog.querySelector('#ttOrderError');
    errEl.textContent = '';
    try {
      await db.removeOrderLine(btn.dataset.lineRemove, getSession().staffId);
      const fresh = (await db.getOrders(getSession().storeId)).find((o) => o.id === order.id);
      closeModal();
      openOrderDetail(root, fresh);
      renderOrders(root);
    } catch (err) {
      errEl.textContent = err instanceof db.ValidationError ? err.message : 'Could not remove item.';
    }
  }));

  dialog.querySelector('[data-action="send-order"]')?.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Mark as sent?',
      body: `Only tick this once you've actually placed this order with ${esc(order.supplierName)} yourself — the app does not contact suppliers.`,
      confirmLabel: 'Mark as sent',
    });
    if (!ok) return;
    try {
      await db.markOrderSent(order.id, getSession().staffId);
      toast('Order marked as sent');
      closeModal();
      renderOrders(root);
    } catch (err) {
      toast(err instanceof db.ValidationError ? err.message : 'Could not update order', { error: true });
    }
  });

  dialog.querySelector('[data-action="cancel-order"]')?.addEventListener('click', async () => {
    const reason = await promptText({
      title: 'Cancel this order?', label: 'Reason (optional)',
      placeholder: 'e.g. supplier out of stock, ordered by mistake', confirmLabel: 'Cancel order', required: false,
    });
    if (reason === null) return;
    try {
      await db.cancelOrder(order.id, reason, getSession().staffId);
      toast('Order cancelled');
      closeModal();
      renderOrders(root);
    } catch (err) {
      toast(err instanceof db.ValidationError ? err.message : 'Could not cancel order', { error: true });
    }
  });

  dialog.querySelector('[data-action="receive-order"]')?.addEventListener('click', () => openReceiveModal(root, order));
}

function openReceiveModal(root, order) {
  const today = brisbaneDateISO();
  const dialog = openModal(`
    <h2 id="tt-receive-title" class="tt-modal-title">Receive order — ${esc(order.supplierName)}</h2>
    <p class="tt-modal-body">Enter what actually arrived. This updates on-hand stock right away; a use-by date is optional and only needed for items you want tracked as a batch.</p>
    <div id="ttReceiveLines">
      ${order.lines.map((l) => `<div class="tt-receive-row">
        <div class="tt-order-line-main">
          <div class="tt-order-line-name">${esc(l.itemName)}</div>
          <div class="tt-order-line-sub">Ordered ${fmtQty(l.quantityOrdered, decimalsForUnit(l.unit))} ${esc(l.unit)}</div>
        </div>
        <input class="tt-input tt-receive-qty" type="number" min="0" step="0.01" value="${l.quantityOrdered}" data-receive-qty="${l.id}" aria-label="Quantity received for ${esc(l.itemName)}">
        <input class="tt-input tt-receive-usebydate" type="date" min="${today}" data-receive-useby="${l.id}" aria-label="Use-by date for ${esc(l.itemName)} (optional)">
      </div>`).join('')}
    </div>
    <div class="tt-pin-error" id="ttReceiveError" role="alert" aria-live="assertive"></div>
    <div class="tt-modal-actions">
      <button class="tt-btn ghost" id="ttReceiveCancel">Cancel</button>
      <button class="tt-btn" id="ttReceiveConfirm">Confirm received</button>
    </div>
  `, { labelledBy: 'tt-receive-title' });

  dialog.querySelector('#ttReceiveCancel').addEventListener('click', () => openOrderDetail(root, order));
  dialog.querySelector('#ttReceiveConfirm').addEventListener('click', async () => {
    const errEl = dialog.querySelector('#ttReceiveError');
    errEl.textContent = '';
    const lines = order.lines.map((l) => ({
      lineId: l.id,
      quantityReceived: dialog.querySelector(`[data-receive-qty="${l.id}"]`).value,
      useByDate: dialog.querySelector(`[data-receive-useby="${l.id}"]`).value || null,
    }));
    try {
      await db.receiveOrder({ orderId: order.id, lines, actorId: getSession().staffId });
      toast('Order received, stock updated');
      closeModal();
      renderOrders(root);
    } catch (err) {
      errEl.textContent = err instanceof db.ValidationError ? err.message : 'Could not record delivery — try again.';
    }
  });
}
