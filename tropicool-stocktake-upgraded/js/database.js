/**
 * Data-access layer. Every function here is async and returns plain
 * objects/arrays — that contract is deliberate so the mock implementation
 * below can be swapped for real Supabase calls (once the Phase 2/3
 * migrations are reviewed and actually run) without touching any calling
 * code in home.js/stocktake.js/etc.
 *
 * Currently backed entirely by the in-memory mock-data.js seed — nothing
 * here reaches a network or a real database. See config.js: SUPABASE_URL
 * is blank on purpose.
 */
import { seedMockData } from './mock-data.js';
import { verifyPin } from './pin-hash.js';
import { brisbaneDateISO } from './date.js';
import { validateSupplierUrl, ANOMALY_VARIANCE_PCT } from './config.js';

let state = null;
let realtimeListeners = [];

/**
 * Thrown for anything a client-side form bug (or a hand-crafted request,
 * once this is real) could otherwise slip past — mirrors the CHECK
 * constraints already written into 0001_stores_item_master_inventory.sql,
 * so the same rules are enforced here even if a UI validation is ever
 * missed or bypassed. Error-prevention belongs at this layer, not only in
 * the form (Priority 5).
 */
export class ValidationError extends Error {}

function recordAudit({ storeId, actorId, action, entityType, entityId, beforeState, afterState }) {
  state.auditLog.push({
    id: uid('audit'), storeId, actorId, action, entityType, entityId,
    beforeState: beforeState ?? null, afterState: afterState ?? null,
    occurredAt: new Date().toISOString(),
  });
}
export async function getAuditLog(storeId, limit = 50) {
  return clone(
    state.auditLog.filter((a) => !storeId || a.storeId === storeId)
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .slice(0, limit),
  );
}

export async function initDatabase() {
  state = await seedMockData();
  return state;
}

function notifyChange(table) {
  realtimeListeners.forEach((fn) => fn(table));
}
export function onChange(fn) {
  realtimeListeners.push(fn);
  return () => { realtimeListeners = realtimeListeners.filter((f) => f !== fn); };
}

function uid(prefix) { return `${prefix}_${Math.random().toString(36).slice(2, 10)}`; }
function clone(x) { return JSON.parse(JSON.stringify(x)); }

// ---- Items / store inventory ------------------------------------------------
export async function getStoreInventory(storeId) {
  return clone(
    state.storeInventory
      .filter((si) => si.storeId === storeId && si.active)
      .map((si) => ({ ...si, item: state.items.find((i) => i.id === si.itemId) })),
  );
}

/** FEFO order — earliest use-by date first, so staff always see what to use next. */
export async function getBatchesFor(storeInventoryId) {
  return clone(
    state.batches
      .filter((b) => b.storeInventoryId === storeInventoryId && b.status === 'active')
      .sort((a, b) => (a.useByDate || '9999').localeCompare(b.useByDate || '9999')),
  );
}

function nonNegativeOrNull(v, label) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  if (Number.isNaN(n) || n < 0) throw new ValidationError(`${label} can’t be negative.`);
  return n;
}

/**
 * Shared validation for anything that creates/edits a store_inventory row.
 * Mirrors the migration's CHECK constraints (max > reorder point) plus the
 * checks that can't be expressed as a single-row CHECK constraint
 * (duplicate name within the store — that needs a sibling-row lookup).
 * `excludeInventoryId` lets an edit exclude itself from the duplicate check.
 */
function validateInventoryInput({
  storeId, name, unit, currentStock, reorderPoint, maxStock, supplierName, supplierUrl,
  unitCost, leadTimeDays, safetyStockDays, orderPackSize, excludeInventoryId,
}) {
  if (name !== undefined) {
    const trimmed = String(name).trim();
    if (!trimmed) throw new ValidationError('Give the item a name.');
    const dup = state.storeInventory.some((si) =>
      si.storeId === storeId && si.active && si.id !== excludeInventoryId
      && state.items.find((i) => i.id === si.itemId)?.name.trim().toLowerCase() === trimmed.toLowerCase(),
    );
    if (dup) throw new ValidationError(`"${trimmed}" is already an item at this store.`);
  }
  if (unit !== undefined && !String(unit).trim()) {
    throw new ValidationError('Choose a unit (e.g. kg, tubs, boxes) — it drives count increments and can’t be blank.');
  }
  if (currentStock !== undefined && (Number.isNaN(Number(currentStock)) || Number(currentStock) < 0)) {
    throw new ValidationError('On-hand quantity can’t be negative.');
  }
  if (reorderPoint !== undefined && (Number.isNaN(Number(reorderPoint)) || Number(reorderPoint) < 0)) {
    throw new ValidationError('Reorder point can’t be negative.');
  }
  const maxNum = maxStock === '' || maxStock == null ? null : Number(maxStock);
  if (maxNum !== null) {
    if (Number.isNaN(maxNum) || maxNum < 0) throw new ValidationError('Max level can’t be negative.');
    const reorderNum = Number(reorderPoint) || 0;
    if (maxNum <= reorderNum) throw new ValidationError('Max level must be above the reorder point.');
  }
  // URL safety is checked unconditionally, before the softer "pair it with
  // a name" business rule below — an unsafe protocol is worth rejecting on
  // its own regardless of whether a supplier name happens to be filled in.
  let normalizedUrl;
  if (supplierUrl !== undefined) {
    const result = validateSupplierUrl(supplierUrl);
    if (!result.ok) throw new ValidationError(result.error);
    normalizedUrl = result.url;
  }
  if (supplierUrl !== undefined && supplierUrl !== '' && !String(supplierName || '').trim()) {
    throw new ValidationError('Add a supplier name to go with that link — an empty name next to a live link is confusing at order time.');
  }
  const normalizedUnitCost = nonNegativeOrNull(unitCost, 'Unit cost');
  const normalizedLeadTime = nonNegativeOrNull(leadTimeDays, 'Lead time');
  const normalizedSafetyStock = nonNegativeOrNull(safetyStockDays, 'Safety-stock days');
  const normalizedOrderPack = orderPackSize === '' || orderPackSize == null ? null : Number(orderPackSize);
  if (normalizedOrderPack !== null && (Number.isNaN(normalizedOrderPack) || normalizedOrderPack <= 0)) {
    throw new ValidationError('Order pack size must be greater than zero.');
  }
  return { normalizedUrl, normalizedUnitCost, normalizedLeadTime, normalizedSafetyStock, normalizedOrderPack };
}

export async function addItem({
  storeId, actorId, name, categoryKey, unit, currentStock, reorderPoint, maxStock, targetStock,
  supplierName, supplierUrl, supplierItemCode, supplierPackUnit, packConversion,
  unitCost, leadTimeDays, safetyStockDays, orderPackSize, important, criticalItem,
}) {
  const { normalizedUrl, normalizedUnitCost, normalizedLeadTime, normalizedSafetyStock, normalizedOrderPack } =
    validateInventoryInput({ storeId, name, unit, currentStock, reorderPoint, maxStock, supplierName, supplierUrl, unitCost, leadTimeDays, safetyStockDays, orderPackSize });
  const item = { id: uid('item'), name: name.trim(), categoryKey, defaultUnit: unit, criticalItem: !!criticalItem, archived: false };
  state.items.push(item);
  const inv = {
    id: uid('inv'), storeId, itemId: item.id, storageArea: '', storageLocation: '',
    unit, currentStock: Number(currentStock) || 0, reorderPoint: Number(reorderPoint) || 0,
    lowWarningAt: Math.round((Number(reorderPoint) || 0) * 1.4 * 10) / 10,
    targetStock: targetStock === '' || targetStock == null ? null : Number(targetStock),
    maxStock: maxStock === '' || maxStock == null ? null : Number(maxStock),
    supplierName: (supplierName || '').trim(), supplierUrl: normalizedUrl || '',
    supplierItemCode: (supplierItemCode || '').trim(), supplierPackUnit: (supplierPackUnit || '').trim(),
    packConversion: packConversion === '' || packConversion == null ? null : Number(packConversion),
    unitCost: normalizedUnitCost, leadTimeDays: normalizedLeadTime, safetyStockDays: normalizedSafetyStock,
    orderPackSize: normalizedOrderPack, important: !!important, active: true,
  };
  state.storeInventory.push(inv);
  recordAudit({ storeId, actorId, action: 'item_added', entityType: 'store_inventory', entityId: inv.id, afterState: inv });
  notifyChange('store_inventory');
  return clone({ ...inv, item });
}

export async function updateStoreInventory(id, patch, actorId) {
  const inv = state.storeInventory.find((si) => si.id === id);
  if (!inv) throw new Error('Not found');
  const merged = { ...inv, ...patch };
  const { normalizedUrl, normalizedUnitCost, normalizedLeadTime, normalizedSafetyStock, normalizedOrderPack } = validateInventoryInput({
    storeId: inv.storeId, excludeInventoryId: id,
    unit: merged.unit, currentStock: merged.currentStock, reorderPoint: merged.reorderPoint, maxStock: merged.maxStock,
    supplierName: merged.supplierName, supplierUrl: merged.supplierUrl,
    unitCost: merged.unitCost, leadTimeDays: merged.leadTimeDays, safetyStockDays: merged.safetyStockDays, orderPackSize: merged.orderPackSize,
  });
  const before = clone(inv);
  Object.assign(inv, patch);
  if (patch.supplierUrl !== undefined) inv.supplierUrl = normalizedUrl;
  if (patch.unitCost !== undefined) inv.unitCost = normalizedUnitCost;
  if (patch.leadTimeDays !== undefined) inv.leadTimeDays = normalizedLeadTime;
  if (patch.safetyStockDays !== undefined) inv.safetyStockDays = normalizedSafetyStock;
  if (patch.orderPackSize !== undefined) inv.orderPackSize = normalizedOrderPack;
  recordAudit({ storeId: inv.storeId, actorId, action: 'item_edited', entityType: 'store_inventory', entityId: inv.id, beforeState: before, afterState: inv });
  notifyChange('store_inventory');
  return clone(inv);
}

// ---- Batch-level expiry (Priority 6) --------------------------------------------
// Replaces the original app's single expiry_date-per-item with proper
// batch tracking: several open batches can exist for one item at once,
// each with its own received/use-by date and remaining quantity, sorted
// FEFO (getBatchesFor above) so staff always see what to use first.

export async function addBatch({ storeInventoryId, quantityReceived, receivedDate, useByDate, supplierReference, actorId }) {
  const inv = state.storeInventory.find((si) => si.id === storeInventoryId);
  if (!inv) throw new Error('Not found');
  const qty = Number(quantityReceived);
  if (Number.isNaN(qty) || qty <= 0) throw new ValidationError('Batch quantity must be greater than zero.');
  if (!receivedDate) throw new ValidationError('Received date is required.');
  if (useByDate && useByDate < receivedDate) throw new ValidationError('Use-by date can’t be before the received date.');
  const batch = {
    id: uid('batch'), storeInventoryId, quantityReceived: qty, quantityRemaining: qty,
    receivedDate, useByDate: useByDate || null, supplierReference: (supplierReference || '').trim(), status: 'active',
  };
  state.batches.push(batch);
  state.stockMovements.push({
    id: uid('mv'), storeInventoryId, movementType: 'delivery', quantity: qty, unit: inv.unit,
    reason: null, reference: batch.supplierReference || null, relatedStoreId: null, batchId: batch.id,
    sessionId: null, staffId: actorId, occurredAt: new Date().toISOString(),
  });
  recordAudit({ storeId: inv.storeId, actorId, action: 'batch_received', entityType: 'item_batch', entityId: batch.id, afterState: batch });
  notifyChange('item_batches');
  return clone(batch);
}

/** Marks a batch used up / thrown out. `status` is 'depleted' or 'wasted'; wasted requires a reason (mirrors the waste stock_movements CHECK constraint). */
export async function closeBatch(batchId, status, reason, actorId) {
  const batch = state.batches.find((b) => b.id === batchId);
  if (!batch) throw new Error('Not found');
  if (status === 'wasted' && !String(reason || '').trim()) {
    throw new ValidationError('A reason is required when recording waste.');
  }
  const inv = state.storeInventory.find((si) => si.id === batch.storeInventoryId);
  const before = clone(batch);
  const wastedQty = batch.quantityRemaining;
  batch.status = status;
  batch.quantityRemaining = 0;
  if (status === 'wasted' && wastedQty > 0) {
    state.stockMovements.push({
      id: uid('mv'), storeInventoryId: batch.storeInventoryId, movementType: 'waste', quantity: wastedQty,
      unit: inv?.unit || '', reason: reason.trim(), reference: null, relatedStoreId: null, batchId: batch.id,
      sessionId: null, staffId: actorId, occurredAt: new Date().toISOString(),
    });
  }
  recordAudit({ storeId: inv?.storeId, actorId, action: status === 'wasted' ? 'batch_wasted' : 'batch_depleted', entityType: 'item_batch', entityId: batch.id, beforeState: before, afterState: batch });
  notifyChange('item_batches');
  return clone(batch);
}

/** Critical-item flag lives on item_master (shared identity), not store_inventory. */
export async function setItemCritical(itemId, criticalItem, actorId) {
  const item = state.items.find((it) => it.id === itemId);
  if (!item) throw new Error('Not found');
  const before = clone(item);
  item.criticalItem = !!criticalItem;
  const inv = state.storeInventory.find((si) => si.itemId === itemId);
  recordAudit({ storeId: inv?.storeId, actorId, action: 'item_critical_flag_changed', entityType: 'item_master', entityId: item.id, beforeState: before, afterState: item });
  notifyChange('item_master');
  return clone(item);
}

export async function archiveItem(storeInventoryId, reason, actorId) {
  const inv = state.storeInventory.find((si) => si.id === storeInventoryId);
  if (!inv) throw new Error('Not found');
  const before = clone(inv);
  inv.active = false;
  inv.archivedReason = reason || null;
  inv.archivedAt = new Date().toISOString();
  recordAudit({ storeId: inv.storeId, actorId, action: 'item_archived', entityType: 'store_inventory', entityId: inv.id, beforeState: before, afterState: inv });
  notifyChange('store_inventory');
  return clone(inv);
}

export async function getArchivedInventory(storeId) {
  return clone(
    state.storeInventory
      .filter((si) => si.storeId === storeId && !si.active)
      .map((si) => ({ ...si, item: state.items.find((i) => i.id === si.itemId) })),
  );
}

export async function unarchiveItem(storeInventoryId, actorId) {
  const inv = state.storeInventory.find((si) => si.id === storeInventoryId);
  if (!inv) throw new Error('Not found');
  const before = clone(inv);
  inv.active = true;
  inv.archivedReason = null;
  inv.archivedAt = null;
  recordAudit({ storeId: inv.storeId, actorId, action: 'item_restored', entityType: 'store_inventory', entityId: inv.id, beforeState: before, afterState: inv });
  notifyChange('store_inventory');
  return clone(inv);
}

// ---- Stocktake sessions -------------------------------------------------------
export async function getOrStartSession(storeId, staffId) {
  const businessDate = brisbaneDateISO();
  let session = state.stocktakeSessions.find((s) => s.storeId === storeId && s.businessDate === businessDate);
  if (!session) {
    session = {
      id: uid('sess'), storeId, businessDate, status: 'draft',
      startedBy: staffId, startedAt: new Date().toISOString(),
      submittedBy: null, submittedAt: null, approvedBy: null, approvedAt: null,
      notes: '', version: 1,
    };
    state.stocktakeSessions.push(session);
    notifyChange('stocktake_sessions');
  }
  return clone(session);
}

export async function getSession(sessionId) {
  const s = state.stocktakeSessions.find((s) => s.id === sessionId);
  return s ? clone(s) : null;
}

export async function getSessionProgress(sessionId) {
  const session = state.stocktakeSessions.find((s) => s.id === sessionId);
  if (!session) return { totalItems: 0, countedItems: 0, completionPct: 0 };
  const totalItems = state.storeInventory.filter((si) => si.storeId === session.storeId && si.active).length;
  const countedItems = new Set(
    state.countLines.filter((cl) => cl.sessionId === sessionId && cl.isCurrent).map((cl) => cl.storeInventoryId),
  ).size;
  return { totalItems, countedItems, completionPct: totalItems ? Math.round((countedItems / totalItems) * 100) : 0 };
}

export async function submitSession(sessionId, staffId, expectedVersion) {
  const session = state.stocktakeSessions.find((s) => s.id === sessionId);
  if (!session) throw new Error('Session not found');
  if (session.version !== expectedVersion) {
    throw new ConflictError('This stocktake changed since you last loaded it. Reload before submitting.');
  }
  session.status = 'submitted';
  session.submittedBy = staffId;
  session.submittedAt = new Date().toISOString();
  session.version += 1;
  notifyChange('stocktake_sessions');
  return clone(session);
}

export async function approveSession(sessionId, staffId, expectedVersion) {
  const session = state.stocktakeSessions.find((s) => s.id === sessionId);
  if (!session) throw new Error('Session not found');
  if (session.version !== expectedVersion) {
    throw new ConflictError('This stocktake changed since you last loaded it. Reload before approving.');
  }
  session.status = 'approved';
  session.approvedBy = staffId;
  session.approvedAt = new Date().toISOString();
  session.version += 1;
  notifyChange('stocktake_sessions');
  return clone(session);
}

export async function reopenSession(sessionId, staffId, expectedVersion) {
  const session = state.stocktakeSessions.find((s) => s.id === sessionId);
  if (!session) throw new Error('Session not found');
  if (session.version !== expectedVersion) {
    throw new ConflictError('This stocktake changed since you last loaded it. Reload before reopening.');
  }
  session.status = 'reopened';
  session.version += 1;
  notifyChange('stocktake_sessions');
  return clone(session);
}

export class ConflictError extends Error {}

// ---- Count lines (append-only) -------------------------------------------------
export async function getCountLines(sessionId) {
  return clone(state.countLines.filter((cl) => cl.sessionId === sessionId && cl.isCurrent));
}

/**
 * Mirrors the real append-only design: never mutates a prior count line's
 * value, only flips is_current on the superseded row inside the same
 * logical operation (see 0005_rls_policies.sql's count_lines_immutable
 * trigger — the mock enforces the same shape so stocktake.js is exercising
 * the real interface, not a simplified one).
 */
export async function saveCountLine({ sessionId, storeInventoryId, systemQty, countedQty, unit, staffId, recountReason }) {
  if (Number.isNaN(Number(countedQty)) || Number(countedQty) < 0) {
    throw new ValidationError('Enter a valid, non-negative quantity.');
  }
  const existing = state.countLines.find(
    (cl) => cl.sessionId === sessionId && cl.storeInventoryId === storeInventoryId && cl.isCurrent,
  );
  if (existing && existing.staffId !== staffId && !recountReason) {
    throw new ConflictError(
      `${existing.staffId === staffId ? 'You' : 'Someone else'} already counted this item. Provide a recount reason to override.`,
    );
  }
  if (existing) existing.isCurrent = false;
  const line = {
    id: uid('cl'), sessionId, storeInventoryId, systemQty, countedQty, unit, staffId,
    countedAt: new Date().toISOString(),
    recountOfId: existing ? existing.id : null,
    recountReason: existing ? (recountReason || null) : null,
    isCurrent: true,
  };
  state.countLines.push(line);
  notifyChange('count_lines');
  return clone(line);
}

export async function getLastCountLineFor(storeInventoryId) {
  const lines = state.countLines.filter((cl) => cl.storeInventoryId === storeInventoryId).sort((a, b) => a.countedAt.localeCompare(b.countedAt));
  return lines.length ? clone(lines[lines.length - 1]) : null;
}

// ---- Staff / auth (mock-mode only — see AUTH_MODEL.md) -------------------------
export async function getStaffPublic(storeId) {
  return clone(
    state.staff.filter((s) => s.storeId === storeId && s.active).map((s) => ({
      id: s.id, name: s.name, role: s.role, active: s.active, hasPinSet: !!s.pinHash,
    })),
  );
}

/**
 * Stands in for calling the verify-staff-pin Edge Function. Checks the PIN
 * against every active staff hash at this store, client-side — acceptable
 * ONLY because this is mock/demo data with nothing real behind it. See the
 * warning at the top of pin-hash.js.
 */
export async function verifyStaffPin(storeId, pin) {
  const candidates = state.staff.filter((s) => s.storeId === storeId && s.active && s.pinHash);
  let matched = null;
  for (const candidate of candidates) {
    if (await verifyPin(pin, candidate.pinHash)) matched = candidate;
  }
  if (!matched) return { ok: false, error: 'Incorrect PIN' };
  return { ok: true, staff: { id: matched.id, name: matched.name, role: matched.role, storeId } };
}

// ---- Reports / dashboard helpers -----------------------------------------------
export async function getReorderList(storeId) {
  const inv = await getStoreInventory(storeId);
  return inv.filter((i) => i.currentStock <= i.reorderPoint);
}

export async function getExpiryAlerts(storeId, warnDays) {
  const inv = await getStoreInventory(storeId);
  const today = brisbaneDateISO();
  const alerts = [];
  for (const i of inv) {
    const batches = await getBatchesFor(i.id);
    for (const b of batches) {
      const days = Math.round((new Date(b.useByDate + 'T00:00:00+10:00') - new Date(today + 'T00:00:00+10:00')) / 86400000);
      if (days <= warnDays) alerts.push({ inventory: i, batch: b, daysUntilExpiry: days });
    }
  }
  return alerts;
}

export async function getLargestVariances(sessionId, limit = 5) {
  const lines = await getCountLines(sessionId);
  return lines
    .map((l) => ({ ...l, variance: l.countedQty - l.systemQty }))
    .sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance))
    .slice(0, limit);
}

// ---- Cash counts -----------------------------------------------------------------
export async function getCashCounts(storeId) {
  return clone(state.cashCounts.filter((c) => c.storeId === storeId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
}
export async function saveCashCount({ storeId, register, shift, expectedCash, countedCash, staffId, notes }) {
  const c = {
    id: uid('cash'), storeId, register, shift,
    expectedCash: expectedCash === '' ? null : Number(expectedCash),
    countedCash: Number(countedCash),
    variance: expectedCash === '' ? null : Number(countedCash) - Number(expectedCash),
    staffId, notes: notes || null,
    approvedBy: null,
    countDate: brisbaneDateISO(), createdAt: new Date().toISOString(),
  };
  state.cashCounts.push(c);
  notifyChange('cash_counts');
  return clone(c);
}

// ---- Announcements ------------------------------------------------------------------
export async function getAnnouncements(storeId) {
  return clone(state.announcements.filter((a) => !storeId || a.storeId === storeId || !a.storeId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
}
export async function postAnnouncement(message, staffName) {
  const a = { id: uid('ann'), message, staffName: staffName || null, createdAt: new Date().toISOString() };
  state.announcements.push(a);
  notifyChange('announcements');
  return clone(a);
}

// ---- Roster (read-only from this app, matching the original's model) ---------------
export async function getRoster(storeId) {
  return clone(state.rosterShifts.filter((r) => r.storeId === storeId));
}
