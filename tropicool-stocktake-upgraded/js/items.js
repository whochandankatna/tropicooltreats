/**
 * Items management. Desktop keeps a dense editable table (the brief
 * explicitly allows this); mobile gets cards + an edit drawer instead of
 * the original's single 12-column table at every width (Priority 4).
 * Deletion is replaced with archive + reason + undo (Priority 5), and every
 * add/edit is validated both here (fast feedback) and in database.js
 * (defence in depth — see ValidationError there).
 *
 * Priority 6: exposes the full item_master/store_inventory split — supplier
 * item code, unit cost, target stock, lead time, safety-stock days, order
 * pack size, supplier pack unit, pack conversion, critical-item flag — and
 * batch-level expiry tracking (FEFO) replacing the original's single
 * expiry-date-per-item.
 */
import * as db from './database.js';
import { getSession, isManager } from './auth.js';
import { esc, icon, fmtQty, toast, promptText, openModal, closeModal } from './ui.js';
import { CATEGORIES, decimalsForUnit } from './config.js';
import { brisbaneDateISO, daysBetween, formatBrisbaneDate } from './date.js';

let query = '';
let showArchived = false;

export async function renderItems(root, storeId) {
  const inventory = await db.getStoreInventory(storeId);
  const archived = showArchived ? await db.getArchivedInventory(storeId) : [];
  const filtered = inventory.filter((i) => i.item.name.toLowerCase().includes(query.trim().toLowerCase()));
  const batchesByInv = {};
  for (const i of filtered) batchesByInv[i.id] = await db.getBatchesFor(i.id);

  root.innerHTML = `
    <div class="tt-search-bar"><label class="tt-sr-only" for="ttItemSearch">Search items</label>
      ${icon('search', 16)}<input class="tt-input" id="ttItemSearch" placeholder="Search items..." value="${esc(query)}"></div>
    ${isManager() ? `<div class="tt-actions-row"><button class="tt-btn ghost" id="ttAddItemBtn">+ Add item</button>
      <button class="tt-btn ghost" id="ttToggleArchived">${showArchived ? 'Hide' : 'Show'} archived</button></div>` : ''}
    <div class="tt-item-cards">
      ${filtered.map((i) => itemCardHtml(i, batchesByInv[i.id])).join('') || '<div class="tt-empty">No items match.</div>'}
    </div>
    ${showArchived ? `<h2 class="tt-panel-title" style="margin-top:16px;">Archived</h2>
      <div class="tt-item-cards">${archived.map((i) => archivedCardHtml(i)).join('') || '<div class="tt-empty">Nothing archived.</div>'}</div>` : ''}
  `;

  root.querySelector('#ttItemSearch').addEventListener('input', (e) => { query = e.target.value; renderItems(root, storeId); queueMicrotask(() => document.getElementById('ttItemSearch')?.focus()); });
  root.querySelector('#ttToggleArchived')?.addEventListener('click', () => { showArchived = !showArchived; renderItems(root, storeId); });
  root.querySelector('#ttAddItemBtn')?.addEventListener('click', () => openAddItemModal(root, storeId));

  root.querySelectorAll('[data-edit]').forEach((btn) => btn.addEventListener('click', () => openEditDrawer(root, storeId, btn.dataset.edit)));
  root.querySelectorAll('[data-batches]').forEach((btn) => btn.addEventListener('click', () => openBatchesModal(root, storeId, btn.dataset.batches, btn.dataset.name)));
  root.querySelectorAll('[data-archive]').forEach((btn) => btn.addEventListener('click', () => archiveFlow(root, storeId, btn.dataset.archive, btn.dataset.name)));
  root.querySelectorAll('[data-unarchive]').forEach((btn) => btn.addEventListener('click', async () => {
    await db.unarchiveItem(btn.dataset.unarchive, getSession().staffId);
    toast('Item restored');
    renderItems(root, storeId);
  }));
}

function expiryBadge(batches) {
  if (!batches || !batches.length) return '';
  const soonest = batches[0]; // getBatchesFor returns FEFO-sorted
  if (!soonest.useByDate) return '';
  const days = daysBetween(brisbaneDateISO(), soonest.useByDate);
  const label = days < 0 ? `Expired ${Math.abs(days)}d ago` : days === 0 ? 'Expires today' : `Expires in ${days}d`;
  const cls = days < 0 ? 'expired' : days <= 3 ? 'expiring' : '';
  return cls ? `<span class="tt-expiry-badge ${cls}">${esc(label)}</span>` : '';
}

function itemCardHtml(i, batches) {
  const low = i.currentStock <= i.reorderPoint;
  return `<div class="tt-item-card">
    <div class="tt-item-card-main">
      <div class="tt-item-card-name">${i.important ? '<span class="tt-star">&#9733;</span> ' : ''}${esc(i.item.name)}${i.item.criticalItem ? ' <span class="tt-critical-badge">CRITICAL</span>' : ''}</div>
      <div class="tt-item-card-sub">${esc(CATEGORIES[i.item.categoryKey]?.label || i.item.categoryKey)} · ${fmtQty(i.currentStock, decimalsForUnit(i.unit))} ${esc(i.unit)} on hand${low ? ' · needs order' : ''}${i.supplierName ? ' · ' + esc(i.supplierName) : ''}</div>
      ${expiryBadge(batches)}
    </div>
    ${isManager() ? `<div class="tt-item-card-actions">
      <button class="tt-icon-btn" data-batches="${i.id}" data-name="${esc(i.item.name)}" aria-label="Manage batches for ${esc(i.item.name)}">Batches${batches?.length ? ` (${batches.length})` : ''}</button>
      <button class="tt-icon-btn" data-edit="${i.id}" aria-label="Edit ${esc(i.item.name)}">Edit</button>
      <button class="tt-icon-btn danger" data-archive="${i.id}" data-name="${esc(i.item.name)}" aria-label="Archive ${esc(i.item.name)}">Archive</button>
    </div>` : ''}
  </div>`;
}
function archivedCardHtml(i) {
  return `<div class="tt-item-card archived">
    <div class="tt-item-card-main">
      <div class="tt-item-card-name">${esc(i.item.name)}</div>
      <div class="tt-item-card-sub">Archived${i.archivedReason ? ' · ' + esc(i.archivedReason) : ''}</div>
    </div>
    ${isManager() ? `<button class="tt-icon-btn" data-unarchive="${i.id}">Restore</button>` : ''}
  </div>`;
}

function supplierFieldsHtml(prefix, i = {}) {
  return `
    <div class="tt-field"><label for="${prefix}SupplierName">Supplier name</label><input class="tt-input" id="${prefix}SupplierName" value="${esc(i.supplierName || '')}" placeholder="optional"></div>
    <div class="tt-field"><label for="${prefix}SupplierUrl">Supplier link</label><input class="tt-input" id="${prefix}SupplierUrl" value="${esc(i.supplierUrl || '')}" placeholder="optional, https://..."></div>
    <div class="tt-field"><label for="${prefix}SupplierCode">Supplier item code</label><input class="tt-input" id="${prefix}SupplierCode" value="${esc(i.supplierItemCode || '')}" placeholder="optional"></div>
    <div class="tt-field"><label for="${prefix}SupplierPackUnit">Supplier pack unit</label><input class="tt-input" id="${prefix}SupplierPackUnit" value="${esc(i.supplierPackUnit || '')}" placeholder="e.g. carton of 4"></div>
    <div class="tt-field"><label for="${prefix}PackConversion">Pack conversion</label><input class="tt-input" type="number" min="0" id="${prefix}PackConversion" value="${i.packConversion ?? ''}" placeholder="units per pack"></div>
    <div class="tt-field"><label for="${prefix}UnitCost">Unit cost ($)</label><input class="tt-input" type="number" min="0" step="0.01" id="${prefix}UnitCost" value="${i.unitCost ?? ''}" placeholder="optional"></div>
    <div class="tt-field"><label for="${prefix}LeadTime">Lead time (days)</label><input class="tt-input" type="number" min="0" id="${prefix}LeadTime" value="${i.leadTimeDays ?? ''}" placeholder="optional"></div>
    <div class="tt-field"><label for="${prefix}SafetyStock">Safety-stock (days)</label><input class="tt-input" type="number" min="0" id="${prefix}SafetyStock" value="${i.safetyStockDays ?? ''}" placeholder="optional"></div>
    <div class="tt-field"><label for="${prefix}OrderPackSize">Order pack size</label><input class="tt-input" type="number" min="0" step="0.01" id="${prefix}OrderPackSize" value="${i.orderPackSize ?? ''}" placeholder="optional"></div>
  `;
}
function readSupplierFields(dialog, prefix) {
  return {
    supplierName: dialog.querySelector(`#${prefix}SupplierName`).value,
    supplierUrl: dialog.querySelector(`#${prefix}SupplierUrl`).value,
    supplierItemCode: dialog.querySelector(`#${prefix}SupplierCode`).value,
    supplierPackUnit: dialog.querySelector(`#${prefix}SupplierPackUnit`).value,
    packConversion: dialog.querySelector(`#${prefix}PackConversion`).value,
    unitCost: dialog.querySelector(`#${prefix}UnitCost`).value,
    leadTimeDays: dialog.querySelector(`#${prefix}LeadTime`).value,
    safetyStockDays: dialog.querySelector(`#${prefix}SafetyStock`).value,
    orderPackSize: dialog.querySelector(`#${prefix}OrderPackSize`).value,
  };
}

function openAddItemModal(root, storeId) {
  const dialog = openModal(`
    <h2 id="tt-add-item-title" class="tt-modal-title">Add an item</h2>
    <div class="tt-form">
      <div class="tt-field"><label for="ttNewName">Name</label><input class="tt-input" id="ttNewName"></div>
      <div class="tt-field"><label for="ttNewCat">Category</label><select class="tt-input" id="ttNewCat">${Object.entries(CATEGORIES).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('')}</select></div>
      <div class="tt-field"><label for="ttNewUnit">Unit</label><input class="tt-input" id="ttNewUnit" placeholder="tubs / kg / boxes"></div>
      <div class="tt-field"><label for="ttNewStock">On hand now</label><input class="tt-input" type="number" min="0" id="ttNewStock"></div>
      <div class="tt-field"><label for="ttNewReorder">Reorder point</label><input class="tt-input" type="number" min="0" id="ttNewReorder"></div>
      <div class="tt-field"><label for="ttNewTarget">Target stock</label><input class="tt-input" type="number" min="0" id="ttNewTarget" placeholder="optional"></div>
      <div class="tt-field"><label for="ttNewMax">Max level</label><input class="tt-input" type="number" min="0" id="ttNewMax" placeholder="optional"></div>
      ${supplierFieldsHtml('ttNew')}
      <div class="tt-field"><label class="tt-checkbox-row" style="margin:0;"><input type="checkbox" id="ttNewCritical"> <span>Critical item (business-critical if out of stock)</span></label></div>
    </div>
    <div class="tt-pin-error" id="ttAddError" role="alert" aria-live="assertive"></div>
    <div class="tt-modal-actions">
      <button class="tt-btn ghost" id="ttAddCancel">Cancel</button>
      <button class="tt-btn" id="ttAddConfirm">Add item</button>
    </div>
  `, { labelledBy: 'tt-add-item-title' });
  dialog.querySelector('#ttAddCancel').addEventListener('click', closeModal);
  dialog.querySelector('#ttAddConfirm').addEventListener('click', async () => {
    const errEl = dialog.querySelector('#ttAddError');
    errEl.textContent = '';
    const name = dialog.querySelector('#ttNewName').value.trim();
    if (!name) { errEl.textContent = 'Give the item a name first.'; return; }
    try {
      await db.addItem({
        storeId, actorId: getSession().staffId, name,
        categoryKey: dialog.querySelector('#ttNewCat').value,
        unit: dialog.querySelector('#ttNewUnit').value.trim(),
        currentStock: dialog.querySelector('#ttNewStock').value || 0,
        reorderPoint: dialog.querySelector('#ttNewReorder').value || 0,
        targetStock: dialog.querySelector('#ttNewTarget').value,
        maxStock: dialog.querySelector('#ttNewMax').value,
        criticalItem: dialog.querySelector('#ttNewCritical').checked,
        ...readSupplierFields(dialog, 'ttNew'),
      });
      closeModal();
      toast('Item added');
      renderItems(root, storeId);
    } catch (e) {
      if (e instanceof db.ValidationError) errEl.textContent = e.message;
      else { errEl.textContent = 'Could not add item — try again.'; console.error(e); }
    }
  });
}

function openEditDrawer(root, storeId, inventoryId) {
  db.getStoreInventory(storeId).then((inv) => {
    const i = inv.find((x) => x.id === inventoryId);
    if (!i) return;
    const dialog = openModal(`
      <h2 id="tt-edit-item-title" class="tt-modal-title">${esc(i.item.name)}</h2>
      <div class="tt-form">
        <div class="tt-field"><label for="ttEditStock">On hand</label><input class="tt-input" type="number" min="0" id="ttEditStock" value="${i.currentStock}"></div>
        <div class="tt-field"><label for="ttEditReorder">Reorder point</label><input class="tt-input" type="number" min="0" id="ttEditReorder" value="${i.reorderPoint}"></div>
        <div class="tt-field"><label for="ttEditTarget">Target stock</label><input class="tt-input" type="number" min="0" id="ttEditTarget" value="${i.targetStock ?? ''}" placeholder="optional"></div>
        <div class="tt-field"><label for="ttEditMax">Max level</label><input class="tt-input" type="number" min="0" id="ttEditMax" value="${i.maxStock ?? ''}" placeholder="none"></div>
        <div class="tt-field"><label for="ttEditLocation">Storage location</label><input class="tt-input" id="ttEditLocation" value="${esc(i.storageLocation || '')}"></div>
        ${supplierFieldsHtml('ttEdit', i)}
        <div class="tt-field"><label class="tt-checkbox-row" style="margin:0;"><input type="checkbox" id="ttEditCritical" ${i.item.criticalItem ? 'checked' : ''}> <span>Critical item (business-critical if out of stock)</span></label></div>
      </div>
      <div class="tt-pin-error" id="ttEditError" role="alert" aria-live="assertive"></div>
      <div class="tt-modal-actions">
        <button class="tt-btn ghost" id="ttEditCancel">Cancel</button>
        <button class="tt-btn" id="ttEditSave">Save changes</button>
      </div>
    `, { labelledBy: 'tt-edit-item-title' });
    dialog.querySelector('#ttEditCancel').addEventListener('click', closeModal);
    dialog.querySelector('#ttEditSave').addEventListener('click', async () => {
      const errEl = dialog.querySelector('#ttEditError');
      errEl.textContent = '';
      try {
        await db.updateStoreInventory(inventoryId, {
          currentStock: Number(dialog.querySelector('#ttEditStock').value || 0),
          reorderPoint: Number(dialog.querySelector('#ttEditReorder').value || 0),
          targetStock: dialog.querySelector('#ttEditTarget').value === '' ? null : Number(dialog.querySelector('#ttEditTarget').value),
          maxStock: dialog.querySelector('#ttEditMax').value === '' ? null : Number(dialog.querySelector('#ttEditMax').value),
          storageLocation: dialog.querySelector('#ttEditLocation').value.trim(),
          ...readSupplierFields(dialog, 'ttEdit'),
        }, getSession().staffId);
        if (dialog.querySelector('#ttEditCritical').checked !== i.item.criticalItem) {
          await db.setItemCritical(i.item.id, dialog.querySelector('#ttEditCritical').checked, getSession().staffId);
        }
        closeModal();
        toast('Saved');
        renderItems(root, storeId);
      } catch (e) {
        if (e instanceof db.ValidationError) errEl.textContent = e.message;
        else { errEl.textContent = 'Could not save — try again.'; console.error(e); }
      }
    });
  });
}

// ---- Batch-level expiry (Priority 6) --------------------------------------------
async function openBatchesModal(root, storeId, inventoryId, itemName) {
  const dialog = openModal(`<div id="ttBatchesBody"></div>`, { labelledBy: 'tt-batches-title' });
  await renderBatchesBody(dialog, root, storeId, inventoryId, itemName);
}

async function renderBatchesBody(dialog, root, storeId, inventoryId, itemName) {
  const batches = await db.getBatchesFor(inventoryId);
  const today = brisbaneDateISO();
  const body = dialog.querySelector('#ttBatchesBody');
  body.innerHTML = `
    <h2 id="tt-batches-title" class="tt-modal-title">Batches — ${esc(itemName)}</h2>
    <p class="tt-modal-body">First-expiring-first-out: use the top batch next. ${batches.length} open batch${batches.length === 1 ? '' : 'es'}.</p>
    <div class="tt-list-rows" style="margin-bottom:var(--sp-4);">
      ${batches.map((b) => {
        const days = b.useByDate ? daysBetween(today, b.useByDate) : null;
        const label = days === null ? 'No use-by set' : days < 0 ? `Expired ${Math.abs(days)}d ago` : days === 0 ? 'Expires today' : `Expires in ${days}d`;
        return `<div class="tt-list-row">
          <div>
            <div class="tt-list-row-name">${fmtQty(b.quantityRemaining, 2)} on hand${b.supplierReference ? ' · ' + esc(b.supplierReference) : ''}</div>
            <div class="tt-list-row-sub">Received ${esc(formatBrisbaneDate(b.receivedDate))} · ${esc(label)}</div>
          </div>
          <div style="display:flex; gap:4px;">
            <button class="tt-icon-btn" data-deplete="${b.id}">Used up</button>
            <button class="tt-icon-btn danger" data-waste="${b.id}">Waste</button>
          </div>
        </div>`;
      }).join('') || '<div class="tt-empty">No open batches — add one below when stock is received.</div>'}
    </div>
    <div class="tt-panel-subtitle">Receive a new batch</div>
    <div class="tt-form">
      <div class="tt-field"><label for="ttBatchQty">Quantity</label><input class="tt-input" type="number" min="0" step="0.01" id="ttBatchQty"></div>
      <div class="tt-field"><label for="ttBatchReceived">Received date</label><input class="tt-input" type="date" id="ttBatchReceived" value="${today}"></div>
      <div class="tt-field"><label for="ttBatchUseBy">Use-by date</label><input class="tt-input" type="date" id="ttBatchUseBy" placeholder="optional"></div>
      <div class="tt-field"><label for="ttBatchRef">Delivery reference</label><input class="tt-input" id="ttBatchRef" placeholder="optional"></div>
    </div>
    <div class="tt-pin-error" id="ttBatchError" role="alert" aria-live="assertive"></div>
    <div class="tt-modal-actions">
      <button class="tt-btn ghost" id="ttBatchesClose">Close</button>
      <button class="tt-btn" id="ttBatchAdd">Add batch</button>
    </div>
  `;
  body.querySelector('#ttBatchesClose').addEventListener('click', closeModal);
  body.querySelector('#ttBatchAdd').addEventListener('click', async () => {
    const errEl = body.querySelector('#ttBatchError');
    errEl.textContent = '';
    try {
      await db.addBatch({
        storeInventoryId: inventoryId,
        quantityReceived: body.querySelector('#ttBatchQty').value,
        receivedDate: body.querySelector('#ttBatchReceived').value,
        useByDate: body.querySelector('#ttBatchUseBy').value,
        supplierReference: body.querySelector('#ttBatchRef').value,
        actorId: getSession().staffId,
      });
      toast('Batch added');
      await renderBatchesBody(dialog, root, storeId, inventoryId, itemName);
      renderItems(root, storeId);
    } catch (e) {
      if (e instanceof db.ValidationError) errEl.textContent = e.message;
      else { errEl.textContent = 'Could not add batch — try again.'; console.error(e); }
    }
  });
  body.querySelectorAll('[data-deplete]').forEach((btn) => btn.addEventListener('click', async () => {
    await db.closeBatch(btn.dataset.deplete, 'depleted', null, getSession().staffId);
    toast('Batch marked used up');
    await renderBatchesBody(dialog, root, storeId, inventoryId, itemName);
    renderItems(root, storeId);
  }));
  body.querySelectorAll('[data-waste]').forEach((btn) => btn.addEventListener('click', async () => {
    // promptText() opens on the same modal singleton, which replaces this
    // batches view's markup while it's showing — so once it resolves, the
    // batches modal is reopened fresh (openBatchesModal) rather than
    // reusing `dialog`/`body` references that no longer point at anything
    // still in the DOM.
    const reason = await promptText({
      title: 'Reason for waste', label: 'Reason for waste',
      placeholder: 'e.g. spoiled, damaged in delivery', confirmLabel: 'Record waste',
    });
    if (reason === null) { await openBatchesModal(root, storeId, inventoryId, itemName); return; }
    try {
      await db.closeBatch(btn.dataset.waste, 'wasted', reason, getSession().staffId);
      toast('Batch recorded as waste');
    } catch (e) {
      toast(e instanceof db.ValidationError ? e.message : 'Could not record waste', { error: true });
    }
    await openBatchesModal(root, storeId, inventoryId, itemName);
    renderItems(root, storeId);
  }));
}

async function archiveFlow(root, storeId, inventoryId, itemName) {
  const dialog = openModal(`
    <h2 id="tt-archive-title" class="tt-modal-title">Archive "${esc(itemName)}"?</h2>
    <p class="tt-modal-body">This removes it from active counting and ordering. You can restore it any time from "Show archived", and this is fully undoable.</p>
    <div class="tt-field"><label for="ttArchiveReason">Reason (optional)</label><input class="tt-input" id="ttArchiveReason" placeholder="e.g. discontinued by supplier"></div>
    <div class="tt-modal-actions">
      <button class="tt-btn ghost" id="ttArchiveCancel">Cancel</button>
      <button class="tt-btn danger" id="ttArchiveConfirm">Archive</button>
    </div>
  `, { labelledBy: 'tt-archive-title' });
  dialog.querySelector('#ttArchiveCancel').addEventListener('click', closeModal);
  dialog.querySelector('#ttArchiveConfirm').addEventListener('click', async () => {
    const reason = dialog.querySelector('#ttArchiveReason').value.trim();
    const overlay = dialog.closest('.tt-modal-overlay');
    if (overlay) overlay._onClose = null;
    closeModal();
    await db.archiveItem(inventoryId, reason || null, getSession().staffId);
    renderItems(root, storeId);
    toast(`Archived "${itemName}"`, {
      action: {
        label: 'Undo',
        onClick: async () => {
          await db.unarchiveItem(inventoryId, getSession().staffId);
          toast('Restored');
          renderItems(root, storeId);
        },
      },
    });
  });
}
