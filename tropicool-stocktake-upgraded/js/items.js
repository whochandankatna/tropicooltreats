/**
 * Items management. Desktop keeps a dense editable table (the brief
 * explicitly allows this); mobile gets cards + an edit drawer instead of
 * the original's single 12-column table at every width (Priority 4).
 * Deletion is replaced with archive + reason + undo (Priority 5), and every
 * add/edit is validated both here (fast feedback) and in database.js
 * (defense in depth — see ValidationError there).
 */
import * as db from './database.js';
import { getSession, isManager } from './auth.js';
import { esc, icon, fmtQty, toast, confirmDialog, openModal, closeModal } from './ui.js';
import { CATEGORIES } from './config.js';

let query = '';
let showArchived = false;

export async function renderItems(root, storeId) {
  const inventory = await db.getStoreInventory(storeId);
  const archived = showArchived ? await db.getArchivedInventory(storeId) : [];
  const filtered = inventory.filter((i) => i.item.name.toLowerCase().includes(query.trim().toLowerCase()));

  root.innerHTML = `
    <div class="tt-search-bar"><label class="tt-sr-only" for="ttItemSearch">Search items</label>
      ${icon('search', 16)}<input class="tt-input" id="ttItemSearch" placeholder="Search items..." value="${esc(query)}"></div>
    ${isManager() ? `<div class="tt-actions-row"><button class="tt-btn ghost" id="ttAddItemBtn">+ Add item</button>
      <button class="tt-btn ghost" id="ttToggleArchived">${showArchived ? 'Hide' : 'Show'} archived</button></div>` : ''}
    <div class="tt-item-cards">
      ${filtered.map((i) => itemCardHtml(i)).join('') || '<div class="tt-empty">No items match.</div>'}
    </div>
    ${showArchived ? `<div class="tt-panel-title" style="margin-top:16px;">Archived</div>
      <div class="tt-item-cards">${archived.map((i) => archivedCardHtml(i)).join('') || '<div class="tt-empty">Nothing archived.</div>'}</div>` : ''}
  `;

  root.querySelector('#ttItemSearch').addEventListener('input', (e) => { query = e.target.value; renderItems(root, storeId); queueMicrotask(() => document.getElementById('ttItemSearch')?.focus()); });
  root.querySelector('#ttToggleArchived')?.addEventListener('click', () => { showArchived = !showArchived; renderItems(root, storeId); });
  root.querySelector('#ttAddItemBtn')?.addEventListener('click', () => openAddItemModal(root, storeId));

  root.querySelectorAll('[data-edit]').forEach((btn) => btn.addEventListener('click', () => openEditDrawer(root, storeId, btn.dataset.edit)));
  root.querySelectorAll('[data-archive]').forEach((btn) => btn.addEventListener('click', () => archiveFlow(root, storeId, btn.dataset.archive, btn.dataset.name)));
  root.querySelectorAll('[data-unarchive]').forEach((btn) => btn.addEventListener('click', async () => {
    await db.unarchiveItem(btn.dataset.unarchive, getSession().staffId);
    toast('Item restored');
    renderItems(root, storeId);
  }));
}

function itemCardHtml(i) {
  const low = i.currentStock <= i.reorderPoint;
  return `<div class="tt-item-card">
    <div class="tt-item-card-main">
      <div class="tt-item-card-name">${i.important ? '<span class="tt-star">&#9733;</span> ' : ''}${esc(i.item.name)}</div>
      <div class="tt-item-card-sub">${esc(CATEGORIES[i.item.categoryKey]?.label || i.item.categoryKey)} · ${fmtQty(i.currentStock)} ${esc(i.unit)} on hand${low ? ' · needs order' : ''}${i.supplierName ? ' · ' + esc(i.supplierName) : ''}</div>
    </div>
    ${isManager() ? `<div class="tt-item-card-actions">
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
  `;
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
      <div class="tt-field"><label for="ttNewMax">Max level</label><input class="tt-input" type="number" min="0" id="ttNewMax" placeholder="optional"></div>
      ${supplierFieldsHtml('ttNew')}
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
        maxStock: dialog.querySelector('#ttNewMax').value,
        supplierName: dialog.querySelector('#ttNewSupplierName').value,
        supplierUrl: dialog.querySelector('#ttNewSupplierUrl').value,
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
        <div class="tt-field"><label for="ttEditMax">Max level</label><input class="tt-input" type="number" min="0" id="ttEditMax" value="${i.maxStock ?? ''}" placeholder="none"></div>
        <div class="tt-field"><label for="ttEditLocation">Storage location</label><input class="tt-input" id="ttEditLocation" value="${esc(i.storageLocation || '')}"></div>
        ${supplierFieldsHtml('ttEdit', i)}
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
          maxStock: dialog.querySelector('#ttEditMax').value === '' ? null : Number(dialog.querySelector('#ttEditMax').value),
          storageLocation: dialog.querySelector('#ttEditLocation').value.trim(),
          supplierName: dialog.querySelector('#ttEditSupplierName').value.trim(),
          supplierUrl: dialog.querySelector('#ttEditSupplierUrl').value.trim(),
        }, getSession().staffId);
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
