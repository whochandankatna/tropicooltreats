/**
 * Items management. Desktop keeps a dense editable table (the brief
 * explicitly allows this); mobile gets cards + an edit drawer instead of
 * the original's single 12-column table at every width (Priority 4).
 * Deletion is replaced with archive + reason + undo (Priority 5).
 */
import * as db from './database.js';
import { isManager } from './auth.js';
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
    await db.unarchiveItem(btn.dataset.unarchive);
    toast('Item restored');
    renderItems(root, storeId);
  }));
}

function itemCardHtml(i) {
  const low = i.currentStock <= i.reorderPoint;
  return `<div class="tt-item-card">
    <div class="tt-item-card-main">
      <div class="tt-item-card-name">${i.important ? '<span class="tt-star">&#9733;</span> ' : ''}${esc(i.item.name)}</div>
      <div class="tt-item-card-sub">${esc(CATEGORIES[i.item.categoryKey]?.label || i.item.categoryKey)} · ${fmtQty(i.currentStock)} ${esc(i.unit)} on hand${low ? ' · needs order' : ''}</div>
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
    </div>
    <div class="tt-modal-actions">
      <button class="tt-btn ghost" id="ttAddCancel">Cancel</button>
      <button class="tt-btn" id="ttAddConfirm">Add item</button>
    </div>
  `, { labelledBy: 'tt-add-item-title' });
  dialog.querySelector('#ttAddCancel').addEventListener('click', closeModal);
  dialog.querySelector('#ttAddConfirm').addEventListener('click', async () => {
    const name = dialog.querySelector('#ttNewName').value.trim();
    if (!name) { toast('Give the item a name first', { error: true }); return; }
    const reorderPoint = Number(dialog.querySelector('#ttNewReorder').value || 0);
    const maxRaw = dialog.querySelector('#ttNewMax').value;
    const maxStock = maxRaw === '' ? null : Number(maxRaw);
    if (maxStock !== null && maxStock <= reorderPoint) { toast('Max level must be above the reorder point', { error: true }); return; }
    await db.addItem({
      storeId, name, categoryKey: dialog.querySelector('#ttNewCat').value,
      unit: dialog.querySelector('#ttNewUnit').value.trim() || 'units',
      currentStock: dialog.querySelector('#ttNewStock').value, reorderPoint, maxStock,
    });
    closeModal();
    toast('Item added');
    renderItems(root, storeId);
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
      </div>
      <div class="tt-modal-actions">
        <button class="tt-btn ghost" id="ttEditCancel">Cancel</button>
        <button class="tt-btn" id="ttEditSave">Save changes</button>
      </div>
    `, { labelledBy: 'tt-edit-item-title' });
    dialog.querySelector('#ttEditCancel').addEventListener('click', closeModal);
    dialog.querySelector('#ttEditSave').addEventListener('click', async () => {
      const reorderPoint = Number(dialog.querySelector('#ttEditReorder').value || 0);
      const maxRaw = dialog.querySelector('#ttEditMax').value;
      const maxStock = maxRaw === '' ? null : Number(maxRaw);
      if (maxStock !== null && maxStock <= reorderPoint) { toast('Max level must be above the reorder point', { error: true }); return; }
      await db.updateStoreInventory(inventoryId, {
        currentStock: Number(dialog.querySelector('#ttEditStock').value || 0),
        reorderPoint, maxStock, storageLocation: dialog.querySelector('#ttEditLocation').value.trim(),
      });
      closeModal();
      toast('Saved');
      renderItems(root, storeId);
    });
  });
}

async function archiveFlow(root, storeId, inventoryId, itemName) {
  const proceed = await confirmDialog({
    title: `Archive "${itemName}"?`,
    body: `This removes it from active counting and ordering. You can restore it any time from "Show archived", and this is fully undoable.`,
    confirmLabel: 'Archive', danger: true,
  });
  if (!proceed) return;
  const reason = window.prompt('Reason (optional):', '') || '';
  await db.archiveItem(inventoryId, reason.trim() || null);
  toast('Item archived');
  renderItems(root, storeId);
}
