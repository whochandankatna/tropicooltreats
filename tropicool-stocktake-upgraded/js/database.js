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

let state = null;
let realtimeListeners = [];

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

export async function getBatchesFor(storeInventoryId) {
  return clone(state.batches.filter((b) => b.storeInventoryId === storeInventoryId && b.status === 'active'));
}

export async function addItem({ storeId, name, categoryKey, unit, currentStock, reorderPoint, maxStock, important, criticalItem }) {
  const item = { id: uid('item'), name, categoryKey, defaultUnit: unit, criticalItem: !!criticalItem, archived: false };
  state.items.push(item);
  const inv = {
    id: uid('inv'), storeId, itemId: item.id, storageArea: '', storageLocation: '',
    unit, currentStock: Number(currentStock) || 0, reorderPoint: Number(reorderPoint) || 0,
    lowWarningAt: Math.round((Number(reorderPoint) || 0) * 1.4 * 10) / 10,
    targetStock: null, maxStock: maxStock === '' || maxStock == null ? null : Number(maxStock),
    supplierName: '', supplierUrl: '', important: !!important, active: true,
  };
  state.storeInventory.push(inv);
  notifyChange('store_inventory');
  return clone({ ...inv, item });
}

export async function updateStoreInventory(id, patch) {
  const inv = state.storeInventory.find((si) => si.id === id);
  if (!inv) throw new Error('Not found');
  Object.assign(inv, patch);
  notifyChange('store_inventory');
  return clone(inv);
}

export async function archiveItem(storeInventoryId, reason) {
  const inv = state.storeInventory.find((si) => si.id === storeInventoryId);
  if (!inv) throw new Error('Not found');
  inv.active = false;
  inv.archivedReason = reason || null;
  inv.archivedAt = new Date().toISOString();
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

export async function unarchiveItem(storeInventoryId) {
  const inv = state.storeInventory.find((si) => si.id === storeInventoryId);
  if (!inv) throw new Error('Not found');
  inv.active = true;
  inv.archivedReason = null;
  inv.archivedAt = null;
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
