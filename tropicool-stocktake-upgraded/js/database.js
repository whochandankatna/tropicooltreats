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
import { validateSupplierUrl, CASH_DENOMINATIONS, CASH_SHIFTS } from './config.js';

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
      .slice(0, limit)
      .map((a) => ({ ...a, actorName: state.staff.find((s) => s.id === a.actorId)?.name || 'Unknown' })),
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
/**
 * A conservative, honestly-labelled suggestion, not a demand forecast — this
 * app has no sales-velocity/usage-rate data to compute a real reorder point
 * from lead time and safety stock (AUDIT.md flags this as an open question),
 * so lead time/safety-stock days are surfaced to the human as context on the
 * order screen rather than silently folded into a formula that would imply
 * more precision than the data supports (working rule 7: no feature that
 * doesn't really do what it appears to do).
 */
function computeSuggestedQty(inv) {
  const base = inv.targetStock ?? inv.maxStock ?? inv.reorderPoint * 2;
  const raw = Math.max(0, Number(base) - Number(inv.currentStock));
  const pack = Number(inv.orderPackSize) || 0;
  if (pack > 0 && raw > 0) return Math.ceil(raw / pack) * pack;
  return Math.round(raw * 100) / 100;
}

export async function getReorderList(storeId) {
  const inv = await getStoreInventory(storeId);
  return inv.filter((i) => i.currentStock <= i.reorderPoint)
    .map((i) => ({ ...i, suggestedQty: computeSuggestedQty(i) }));
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

/**
 * Who counted what in the current session, for a completion breakdown —
 * "3 of 12 counted" per staff member, not a total across the whole store
 * (Priority 8's staff-completion report). Staff with zero lines still
 * appear (0 counted) so an obviously-idle account is visible, not just
 * silently absent from the list.
 */
export async function getStaffCompletion(sessionId, storeId) {
  const [lines, staff] = await Promise.all([getCountLines(sessionId), getStaffPublic(storeId)]);
  return staff.map((s) => ({
    staffId: s.id, name: s.name, role: s.role,
    countedItems: lines.filter((l) => l.staffId === s.id).length,
  })).sort((a, b) => b.countedItems - a.countedItems);
}

/**
 * Waste logged via item_batches (closeBatch status='wasted') within the
 * last `days` days, joined back to the item/unit for a readable report.
 * stock_movements doesn't carry store_id directly (only via
 * store_inventory_id), so this filters through getStoreInventory the same
 * way getExpiryAlerts does, rather than assuming a movement's store.
 */
export async function getWasteReport(storeId, days = 30) {
  const inv = await getStoreInventory(storeId);
  const invIds = new Set(inv.map((i) => i.id));
  const cutoff = Date.now() - days * 86400000;
  return clone(
    state.stockMovements
      .filter((m) => m.movementType === 'waste' && invIds.has(m.storeInventoryId) && new Date(m.occurredAt).getTime() >= cutoff)
      .map((m) => {
        const i = inv.find((x) => x.id === m.storeInventoryId);
        const staff = state.staff.find((s) => s.id === m.staffId);
        return {
          itemName: i?.item?.name || 'Item', unit: m.unit, quantity: m.quantity,
          reason: m.reason, staffName: staff?.name || 'Unknown', occurredAt: m.occurredAt,
          estimatedCost: i?.unitCost != null ? Math.round(i.unitCost * m.quantity * 100) / 100 : null,
        };
      })
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)),
  );
}

/**
 * Stock value = current_stock * unit_cost, per item, grouped by category
 * and totalled. Items with no unit_cost set are listed with a null value
 * rather than silently treated as worth $0 — "no cost on file" and "worth
 * nothing" are different facts, and conflating them would understate the
 * total without saying so (working rule 7).
 */
export async function getValuationReport(storeId) {
  const inv = await getStoreInventory(storeId);
  const rows = inv.map((i) => ({
    itemName: i.item.name, categoryKey: i.item.categoryKey, unit: i.unit,
    currentStock: i.currentStock, unitCost: i.unitCost ?? null,
    value: i.unitCost != null ? Math.round(i.currentStock * i.unitCost * 100) / 100 : null,
  }));
  const total = rows.reduce((sum, r) => sum + (r.value ?? 0), 0);
  const missingCostCount = rows.filter((r) => r.value === null).length;
  return { rows, total: Math.round(total * 100) / 100, missingCostCount };
}

// ---- Purchase orders (Priority 7: ordering workflow) ----------------------------
// draft -> sent -> received, or draft/sent -> cancelled (see
// supabase/migrations/0007_purchase_orders.sql). "Sent" only records that a
// human placed the order themselves (phone/website) — nothing here contacts
// a supplier (working rule 6: no external actions without approval).
// Receiving updates store_inventory.currentStock directly (matching how a
// delivery is actually handled day to day) and logs a stock_movement for
// the audit trail; if a use-by date is given at receive time it also opens
// a batch the same shape Phase 6's "Receive a new batch" creates. Note this
// means current_stock and batches remain two independently-tracked numbers
// for perishables (a batch alone, e.g. one added directly via Items, does
// not itself change current_stock) — an open simplification carried over
// from Phase 6, not newly introduced here.
export async function getOrders(storeId) {
  return clone(
    state.purchaseOrders.filter((o) => o.storeId === storeId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((o) => ({ ...o, lines: state.purchaseOrderLines.filter((l) => l.purchaseOrderId === o.id) })),
  );
}

export async function createDraftOrder({ storeId, supplierName, lines, actorId }) {
  const name = (supplierName || '').trim();
  if (!name) throw new ValidationError('Supplier name is required.');
  if (!lines || !lines.length) throw new ValidationError('Add at least one item to the order.');
  const builtLines = lines.map((l) => {
    const inv = state.storeInventory.find((si) => si.id === l.storeInventoryId);
    if (!inv) throw new ValidationError('One of the selected items could not be found.');
    const item = state.items.find((it) => it.id === inv.itemId);
    const qty = Number(l.quantityOrdered);
    if (!(qty > 0)) throw new ValidationError(`Quantity for ${item?.name || 'an item'} must be greater than zero.`);
    return { storeInventoryId: inv.id, itemName: item?.name || '', unit: inv.unit, quantityOrdered: qty, unitCostAtOrder: inv.unitCost ?? null };
  });
  const order = {
    id: uid('po'), storeId, supplierName: name, status: 'draft', notes: '',
    createdBy: actorId, createdAt: new Date().toISOString(),
    sentBy: null, sentAt: null, receivedBy: null, receivedAt: null,
    cancelledBy: null, cancelledAt: null, cancelReason: null,
  };
  state.purchaseOrders.push(order);
  builtLines.forEach((l) => state.purchaseOrderLines.push({ id: uid('pol'), purchaseOrderId: order.id, quantityReceived: null, ...l }));
  recordAudit({ storeId, actorId, action: 'order_created', entityType: 'purchase_order', entityId: order.id, afterState: order });
  notifyChange('purchase_orders');
  return clone(order);
}

export async function updateOrderLineQty(lineId, quantityOrdered, actorId) {
  const line = state.purchaseOrderLines.find((l) => l.id === lineId);
  if (!line) throw new Error('Not found');
  const order = state.purchaseOrders.find((o) => o.id === line.purchaseOrderId);
  if (!order || order.status !== 'draft') throw new ValidationError('Only a draft order can be edited.');
  const qty = Number(quantityOrdered);
  if (!(qty > 0)) throw new ValidationError('Quantity must be greater than zero.');
  line.quantityOrdered = qty;
  recordAudit({ storeId: order.storeId, actorId, action: 'order_line_changed', entityType: 'purchase_order_line', entityId: line.id, afterState: line });
  notifyChange('purchase_order_lines');
  return clone(line);
}

export async function removeOrderLine(lineId, actorId) {
  const line = state.purchaseOrderLines.find((l) => l.id === lineId);
  if (!line) return;
  const order = state.purchaseOrders.find((o) => o.id === line.purchaseOrderId);
  if (!order || order.status !== 'draft') throw new ValidationError('Only a draft order can be edited.');
  const siblingCount = state.purchaseOrderLines.filter((l) => l.purchaseOrderId === order.id).length;
  if (siblingCount <= 1) throw new ValidationError('Cancel the order instead of removing its only item.');
  state.purchaseOrderLines = state.purchaseOrderLines.filter((l) => l.id !== lineId);
  recordAudit({ storeId: order.storeId, actorId, action: 'order_line_removed', entityType: 'purchase_order_line', entityId: line.id, beforeState: line });
  notifyChange('purchase_order_lines');
}

export async function markOrderSent(orderId, actorId) {
  const order = state.purchaseOrders.find((o) => o.id === orderId);
  if (!order) throw new Error('Not found');
  if (order.status !== 'draft') throw new ValidationError('Only a draft order can be marked as sent.');
  const before = clone(order);
  order.status = 'sent';
  order.sentBy = actorId;
  order.sentAt = new Date().toISOString();
  recordAudit({ storeId: order.storeId, actorId, action: 'order_sent', entityType: 'purchase_order', entityId: order.id, beforeState: before, afterState: order });
  notifyChange('purchase_orders');
  return clone(order);
}

export async function cancelOrder(orderId, reason, actorId) {
  const order = state.purchaseOrders.find((o) => o.id === orderId);
  if (!order) throw new Error('Not found');
  if (order.status === 'received' || order.status === 'cancelled') throw new ValidationError('This order can no longer be cancelled.');
  const before = clone(order);
  order.status = 'cancelled';
  order.cancelledBy = actorId;
  order.cancelledAt = new Date().toISOString();
  order.cancelReason = (reason || '').trim() || null;
  recordAudit({ storeId: order.storeId, actorId, action: 'order_cancelled', entityType: 'purchase_order', entityId: order.id, beforeState: before, afterState: order });
  notifyChange('purchase_orders');
  return clone(order);
}

/** lines: [{ lineId, quantityReceived, useByDate? }] */
export async function receiveOrder({ orderId, lines, actorId }) {
  const order = state.purchaseOrders.find((o) => o.id === orderId);
  if (!order) throw new Error('Not found');
  if (order.status !== 'sent') throw new ValidationError('Only a sent order can be received.');
  if (!lines || !lines.length) throw new ValidationError('Nothing to receive.');
  const plans = lines.map((l) => {
    const line = state.purchaseOrderLines.find((pl) => pl.id === l.lineId && pl.purchaseOrderId === orderId);
    if (!line) throw new ValidationError('One of the order lines could not be found.');
    const qty = Number(l.quantityReceived);
    if (Number.isNaN(qty) || qty < 0) throw new ValidationError(`Received quantity for ${line.itemName} must be zero or more.`);
    const inv = state.storeInventory.find((si) => si.id === line.storeInventoryId);
    if (!inv) throw new ValidationError(`${line.itemName} is no longer in this store's inventory.`);
    if (l.useByDate && !/^\d{4}-\d{2}-\d{2}$/.test(l.useByDate)) throw new ValidationError('Use-by date is not valid.');
    return { line, inv, qty, useByDate: l.useByDate || null };
  });
  const today = brisbaneDateISO();
  const ref = `Order #${orderId.slice(-6)}`;
  for (const { line, inv, qty, useByDate } of plans) {
    line.quantityReceived = qty;
    if (qty > 0) {
      inv.currentStock = Math.round((Number(inv.currentStock) + qty) * 100) / 100;
      state.stockMovements.push({
        id: uid('mv'), storeInventoryId: inv.id, movementType: 'delivery', quantity: qty, unit: inv.unit,
        reason: null, reference: ref, relatedStoreId: null, batchId: null,
        sessionId: null, staffId: actorId, occurredAt: new Date().toISOString(),
      });
      if (useByDate) {
        state.batches.push({
          id: uid('batch'), storeInventoryId: inv.id, quantityReceived: qty, quantityRemaining: qty,
          receivedDate: today, useByDate, supplierReference: ref, status: 'active',
        });
      }
    }
  }
  const before = clone(order);
  order.status = 'received';
  order.receivedBy = actorId;
  order.receivedAt = new Date().toISOString();
  recordAudit({ storeId: order.storeId, actorId, action: 'order_received', entityType: 'purchase_order', entityId: order.id, beforeState: before, afterState: order });
  notifyChange('purchase_orders');
  notifyChange('store_inventory');
  notifyChange('item_batches');
  return clone(order);
}

// ---- Cash counts (Priority 9: register/shift/denomination/approval redesign) ----
// Append-only, same shape as count_lines: a recount flips the superseded
// row's isCurrent rather than overwriting its value (0008_cash_counts.sql).
// Never summed across registers/shifts in the UI into one "today so far"
// figure -- that's the exact anti-pattern AUDIT.md §8 flagged in the
// original app.
function isManagerStaff(staffId) {
  return state.staff.find((s) => s.id === staffId)?.role === 'manager';
}

function sumDenominations(denominations) {
  return CASH_DENOMINATIONS.reduce((sum, d) => sum + (Number(denominations[d.key]) || 0) * d.value, 0);
}

export async function getCashCounts(storeId) {
  return clone(
    state.cashCounts.filter((c) => c.storeId === storeId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((c) => ({
        ...c,
        staffName: state.staff.find((s) => s.id === c.staffId)?.name || 'Unknown',
        approverName: c.approvedBy ? (state.staff.find((s) => s.id === c.approvedBy)?.name || 'Unknown') : null,
      })),
  );
}

/**
 * denominations: { [denomination key]: quantity }. countedCash is always
 * derived from it here, never taken as a caller-supplied lump number, so
 * the stored total can't drift from what was actually counted coin by
 * coin/note by note.
 *
 * A recount is only allowed for the *same* staff member's own current
 * entry (mirrors 0008's RLS: a staff member can't supersede a colleague's
 * cash count, only a manager can) — and, unlike count_lines, always
 * requires a reason, same-staff or not, since a cash correction is a
 * standalone financial event worth documenting either way.
 */
export async function saveCashCount({ storeId, register, shift, expectedCash, denominations, staffId, notes, recountReason }) {
  const reg = (register || '').trim();
  if (!reg) throw new ValidationError('Register name is required.');
  if (!CASH_SHIFTS.some((s) => s.key === shift)) throw new ValidationError('Choose a shift.');
  const countedCash = Math.round(sumDenominations(denominations || {}) * 100) / 100;
  if (countedCash <= 0) throw new ValidationError('Enter at least one denomination — the count can’t be zero.');
  const expected = expectedCash === '' || expectedCash == null ? null : Number(expectedCash);
  if (expected != null && (Number.isNaN(expected) || expected < 0)) throw new ValidationError('Expected amount must be zero or more.');

  const businessDate = brisbaneDateISO();
  const existing = state.cashCounts.find(
    (c) => c.storeId === storeId && c.register === reg && c.shift === shift && c.countDate === businessDate && c.isCurrent,
  );
  if (existing) {
    if (existing.staffId !== staffId && !isManagerStaff(staffId)) {
      throw new ValidationError(`${reg} (${shift}) was already counted today by someone else. A manager needs to record the recount.`);
    }
    if (!String(recountReason || '').trim()) {
      throw new ConflictError(`${reg} (${shift}) has already been counted today. Provide a reason to save a recount.`);
    }
  }
  if (existing) existing.isCurrent = false;

  const c = {
    id: uid('cash'), storeId, register: reg, shift,
    countDate: businessDate,
    denominations: { ...denominations },
    countedCash,
    expectedCash: expected,
    notes: (notes || '').trim() || null,
    staffId,
    recountOfId: existing ? existing.id : null,
    recountReason: existing ? recountReason.trim() : null,
    isCurrent: true,
    approvedBy: null,
    approvedAt: null,
    createdAt: new Date().toISOString(),
  };
  state.cashCounts.push(c);
  recordAudit({
    storeId, actorId: staffId, action: existing ? 'cash_count_recounted' : 'cash_count_saved',
    entityType: 'cash_count', entityId: c.id, beforeState: existing ? { countedCash: existing.countedCash } : null, afterState: c,
  });
  notifyChange('cash_counts');
  return clone(c);
}

export async function approveCashCount(cashCountId, actorId) {
  const c = state.cashCounts.find((cc) => cc.id === cashCountId);
  if (!c) throw new Error('Not found');
  if (!isManagerStaff(actorId)) throw new ValidationError('Only a manager can approve a cash count.');
  if (c.approvedBy) throw new ValidationError('This cash count is already approved.');
  const before = clone(c);
  c.approvedBy = actorId;
  c.approvedAt = new Date().toISOString();
  recordAudit({ storeId: c.storeId, actorId, action: 'cash_count_approved', entityType: 'cash_count', entityId: c.id, beforeState: before, afterState: c });
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
