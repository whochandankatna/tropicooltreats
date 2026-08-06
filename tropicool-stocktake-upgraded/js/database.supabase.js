/**
 * Real Supabase-backed data-access layer. Matches database.mock.js's
 * exported API function-for-function (see that file's top comment) so
 * database.js can pick either backend at module load time without any
 * calling code knowing which is active. Authorization is enforced by
 * Postgres RLS (supabase/migrations/0005_rls_policies.sql,
 * 0007/0008/0009) — the validation duplicated here (duplicate names,
 * required fields, max > reorder, etc.) exists purely for the same fast,
 * friendly inline error messages the mock gives, not as the real security
 * boundary. A rejected write always still fails safely even if a
 * client-side check here has a bug or is bypassed.
 *
 * Local realtime: notifyChange() only fires for mutations *this device*
 * just made, same as the mock — there is no Supabase Realtime subscription
 * wiring live updates in from other devices/staff yet. That's a real gap
 * for a multi-device shop (someone else's save on another tablet won't
 * appear here until this device's own next action or a manual refresh),
 * flagged rather than silently claimed as live sync.
 */
import { supabase } from './supabase-client.js';
import { brisbaneDateISO } from './date.js';
import {
  validateSupplierUrl, CASH_DENOMINATIONS, CASH_SHIFTS,
  getOrCreateClientRef, ACCESS_TOKEN_STORAGE_KEY,
} from './config.js';

export class ValidationError extends Error {}
export class ConflictError extends Error {}

// ---- snake_case <-> camelCase -------------------------------------------------
// Shallow by design: jsonb payload fields (cash_counts.denominations,
// audit_log.before_state/after_state) must pass through with their own
// keys untouched, not have this recurse into them.
function toCamel(k) { return k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase()); }
function toSnake(k) { return k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase()); }
function camelize(row) {
  if (row == null) return row;
  if (Array.isArray(row)) return row.map(camelize);
  if (typeof row !== 'object') return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) out[toCamel(k)] = v;
  return out;
}
function decamelize(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[toSnake(k)] = v;
  return out;
}
/** store_inventory rows fetched with a nested `item:item_master(*)` embed
 * need that nested object camelized separately — camelize() is shallow. */
function camelizeInventoryRow(row) {
  if (!row) return row;
  const { item, ...rest } = row;
  return { ...camelize(rest), item: item ? camelize(item) : undefined };
}

function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

async function resolveStaffNames(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return {};
  const data = unwrap(await supabase.from('staff_public').select('id, name').in('id', unique));
  const map = {};
  for (const s of data) map[s.id] = s.name;
  return map;
}

async function isManagerStaff(staffId) {
  const { data } = await supabase.from('staff_public').select('role').eq('id', staffId).maybeSingle();
  return data?.role === 'manager';
}

/** Best-effort — a flaky audit insert should never block the user-visible
 * action that already succeeded (matches how pwa.js treats a failed
 * service worker registration as non-fatal). */
async function recordAudit({ storeId, actorId, action, entityType, entityId, beforeState, afterState }) {
  const { error } = await supabase.from('audit_log').insert({
    store_id: storeId ?? null, actor_id: actorId, action, entity_type: entityType, entity_id: entityId ?? null,
    before_state: beforeState ?? null, after_state: afterState ?? null,
  });
  if (error) console.warn('audit_log insert failed (action still applied):', error.message);
}

export async function getAuditLog(storeId, limit = 50) {
  const data = unwrap(await supabase.from('audit_log').select('*')
    .eq('store_id', storeId).order('occurred_at', { ascending: false }).limit(limit));
  const rows = camelize(data);
  const names = await resolveStaffNames(rows.map((r) => r.actorId));
  return rows.map((r) => ({ ...r, actorName: names[r.actorId] || 'Unknown' }));
}

// ---- Boot / realtime (local-only, see file header) -----------------------------
export async function initDatabase() { return null; }

let realtimeListeners = [];
function notifyChange(table) { realtimeListeners.forEach((fn) => fn(table)); }
export function onChange(fn) {
  realtimeListeners.push(fn);
  return () => { realtimeListeners = realtimeListeners.filter((f) => f !== fn); };
}

// ---- Items / store inventory ------------------------------------------------
export async function getStoreInventory(storeId) {
  const data = unwrap(await supabase.from('store_inventory').select('*, item:item_master(*)')
    .eq('store_id', storeId).eq('active', true));
  return data.map(camelizeInventoryRow);
}

/** FEFO order — earliest use-by date first. */
export async function getBatchesFor(storeInventoryId) {
  const data = unwrap(await supabase.from('item_batches').select('*')
    .eq('store_inventory_id', storeInventoryId).eq('status', 'active')
    .order('use_by_date', { ascending: true, nullsFirst: false }));
  return camelize(data);
}

function nonNegativeOrNull(v, label) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  if (Number.isNaN(n) || n < 0) throw new ValidationError(`${label} can’t be negative.`);
  return n;
}

async function findDuplicateInventoryName(storeId, name, excludeInventoryId) {
  const data = unwrap(await supabase.from('store_inventory').select('id, item:item_master(name)')
    .eq('store_id', storeId).eq('active', true));
  const trimmed = name.trim().toLowerCase();
  return data.some((row) => row.id !== excludeInventoryId && (row.item?.name || '').trim().toLowerCase() === trimmed);
}

/** Async twin of database.mock.js's validateInventoryInput — same checks,
 * the duplicate-name lookup is a real query instead of an in-memory scan. */
async function validateInventoryInput({
  storeId, name, unit, currentStock, reorderPoint, maxStock, supplierName, supplierUrl,
  unitCost, leadTimeDays, safetyStockDays, orderPackSize, excludeInventoryId,
}) {
  if (name !== undefined) {
    const trimmed = String(name).trim();
    if (!trimmed) throw new ValidationError('Give the item a name.');
    if (await findDuplicateInventoryName(storeId, trimmed, excludeInventoryId)) {
      throw new ValidationError(`"${trimmed}" is already an item at this store.`);
    }
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
    await validateInventoryInput({ storeId, name, unit, currentStock, reorderPoint, maxStock, supplierName, supplierUrl, unitCost, leadTimeDays, safetyStockDays, orderPackSize });

  const item = unwrap(await supabase.from('item_master').insert({
    name: name.trim(), category_key: categoryKey, default_unit: unit, critical_item: !!criticalItem,
  }).select().single());

  const { data: inv, error: invErr } = await supabase.from('store_inventory').insert({
    store_id: storeId, item_id: item.id, unit,
    current_stock: Number(currentStock) || 0, reorder_point: Number(reorderPoint) || 0,
    low_warning_at: Math.round((Number(reorderPoint) || 0) * 1.4 * 10) / 10,
    target_stock: targetStock === '' || targetStock == null ? null : Number(targetStock),
    max_stock: maxStock === '' || maxStock == null ? null : Number(maxStock),
    supplier_name: (supplierName || '').trim(), supplier_url: normalizedUrl || '',
    supplier_item_code: (supplierItemCode || '').trim(), supplier_pack_unit: (supplierPackUnit || '').trim(),
    pack_conversion: packConversion === '' || packConversion == null ? null : Number(packConversion),
    unit_cost: normalizedUnitCost, lead_time_days: normalizedLeadTime, safety_stock_days: normalizedSafetyStock,
    order_pack_size: normalizedOrderPack, important: !!important, active: true,
  }).select('*, item:item_master(*)').single();
  if (invErr) {
    // Best-effort cleanup of the now-orphaned item_master row — item_master
    // has no delete policy for a *published* item, but an item that never
    // got a store_inventory row isn't visible anywhere, so this is safe;
    // if it also fails, the orphan is harmless (never surfaced by any UI).
    await supabase.from('item_master').delete().eq('id', item.id);
    throw invErr;
  }
  await recordAudit({ storeId, actorId, action: 'item_added', entityType: 'store_inventory', entityId: inv.id, afterState: camelizeInventoryRow(inv) });
  notifyChange('store_inventory');
  return camelizeInventoryRow(inv);
}

export async function updateStoreInventory(id, patch, actorId) {
  const before = unwrap(await supabase.from('store_inventory').select('*').eq('id', id).single());
  const merged = { ...camelize(before), ...patch };
  const { normalizedUrl, normalizedUnitCost, normalizedLeadTime, normalizedSafetyStock, normalizedOrderPack } = await validateInventoryInput({
    storeId: before.store_id, excludeInventoryId: id,
    unit: merged.unit, currentStock: merged.currentStock, reorderPoint: merged.reorderPoint, maxStock: merged.maxStock,
    supplierName: merged.supplierName, supplierUrl: merged.supplierUrl,
    unitCost: merged.unitCost, leadTimeDays: merged.leadTimeDays, safetyStockDays: merged.safetyStockDays, orderPackSize: merged.orderPackSize,
  });
  const finalPatch = { ...patch };
  if (patch.supplierUrl !== undefined) finalPatch.supplierUrl = normalizedUrl;
  if (patch.unitCost !== undefined) finalPatch.unitCost = normalizedUnitCost;
  if (patch.leadTimeDays !== undefined) finalPatch.leadTimeDays = normalizedLeadTime;
  if (patch.safetyStockDays !== undefined) finalPatch.safetyStockDays = normalizedSafetyStock;
  if (patch.orderPackSize !== undefined) finalPatch.orderPackSize = normalizedOrderPack;

  const updated = unwrap(await supabase.from('store_inventory').update(decamelize(finalPatch)).eq('id', id).select('*, item:item_master(*)').single());
  await recordAudit({ storeId: before.store_id, actorId, action: 'item_edited', entityType: 'store_inventory', entityId: id, beforeState: camelize(before), afterState: camelizeInventoryRow(updated) });
  notifyChange('store_inventory');
  return camelizeInventoryRow(updated);
}

// ---- Batch-level expiry (Priority 6) --------------------------------------------
export async function addBatch({ storeInventoryId, quantityReceived, receivedDate, useByDate, supplierReference, actorId }) {
  const qty = Number(quantityReceived);
  if (Number.isNaN(qty) || qty <= 0) throw new ValidationError('Batch quantity must be greater than zero.');
  if (!receivedDate) throw new ValidationError('Received date is required.');
  if (useByDate && useByDate < receivedDate) throw new ValidationError('Use-by date can’t be before the received date.');

  const inv = unwrap(await supabase.from('store_inventory').select('id, store_id, unit').eq('id', storeInventoryId).single());
  const batch = unwrap(await supabase.from('item_batches').insert({
    store_inventory_id: storeInventoryId, quantity_received: qty, quantity_remaining: qty,
    received_date: receivedDate, use_by_date: useByDate || null, supplier_reference: (supplierReference || '').trim(), status: 'active',
  }).select().single());
  unwrap(await supabase.from('stock_movements').insert({
    store_inventory_id: storeInventoryId, movement_type: 'delivery', quantity: qty, unit: inv.unit,
    reference: batch.supplier_reference || null, batch_id: batch.id, staff_id: actorId,
  }));
  await recordAudit({ storeId: inv.store_id, actorId, action: 'batch_received', entityType: 'item_batch', entityId: batch.id, afterState: camelize(batch) });
  notifyChange('item_batches');
  return camelize(batch);
}

/** status is 'depleted' or 'wasted'; wasted requires a reason. */
export async function closeBatch(batchId, status, reason, actorId) {
  if (status === 'wasted' && !String(reason || '').trim()) {
    throw new ValidationError('A reason is required when recording waste.');
  }
  const before = unwrap(await supabase.from('item_batches').select('*, inv:store_inventory(id, store_id, unit)').eq('id', batchId).single());
  const wastedQty = before.quantity_remaining;
  const updated = unwrap(await supabase.from('item_batches').update({ status, quantity_remaining: 0 }).eq('id', batchId).select().single());
  if (status === 'wasted' && wastedQty > 0) {
    unwrap(await supabase.from('stock_movements').insert({
      store_inventory_id: before.store_inventory_id, movement_type: 'waste', quantity: wastedQty,
      unit: before.inv?.unit || '', reason: reason.trim(), batch_id: batchId, staff_id: actorId,
    }));
  }
  const { inv, ...beforeRest } = before;
  await recordAudit({ storeId: inv?.store_id, actorId, action: status === 'wasted' ? 'batch_wasted' : 'batch_depleted', entityType: 'item_batch', entityId: batchId, beforeState: camelize(beforeRest), afterState: camelize(updated) });
  notifyChange('item_batches');
  return camelize(updated);
}

export async function setItemCritical(itemId, criticalItem, actorId) {
  const before = unwrap(await supabase.from('item_master').select('*').eq('id', itemId).single());
  const updated = unwrap(await supabase.from('item_master').update({ critical_item: !!criticalItem }).eq('id', itemId).select().single());
  const { data: invRow } = await supabase.from('store_inventory').select('store_id').eq('item_id', itemId).limit(1).maybeSingle();
  await recordAudit({ storeId: invRow?.store_id, actorId, action: 'item_critical_flag_changed', entityType: 'item_master', entityId: itemId, beforeState: camelize(before), afterState: camelize(updated) });
  notifyChange('item_master');
  return camelize(updated);
}

export async function archiveItem(storeInventoryId, reason, actorId) {
  const before = unwrap(await supabase.from('store_inventory').select('*').eq('id', storeInventoryId).single());
  const updated = unwrap(await supabase.from('store_inventory')
    .update({ active: false, archived_reason: reason || null, archived_at: new Date().toISOString() })
    .eq('id', storeInventoryId).select().single());
  await recordAudit({ storeId: before.store_id, actorId, action: 'item_archived', entityType: 'store_inventory', entityId: storeInventoryId, beforeState: camelize(before), afterState: camelize(updated) });
  notifyChange('store_inventory');
  return camelize(updated);
}

export async function getArchivedInventory(storeId) {
  const data = unwrap(await supabase.from('store_inventory').select('*, item:item_master(*)')
    .eq('store_id', storeId).eq('active', false));
  return data.map(camelizeInventoryRow);
}

export async function unarchiveItem(storeInventoryId, actorId) {
  const before = unwrap(await supabase.from('store_inventory').select('*').eq('id', storeInventoryId).single());
  const updated = unwrap(await supabase.from('store_inventory')
    .update({ active: true, archived_reason: null, archived_at: null })
    .eq('id', storeInventoryId).select().single());
  await recordAudit({ storeId: before.store_id, actorId, action: 'item_restored', entityType: 'store_inventory', entityId: storeInventoryId, beforeState: camelize(before), afterState: camelize(updated) });
  notifyChange('store_inventory');
  return camelize(updated);
}

// ---- Stocktake sessions -------------------------------------------------------
export async function getOrStartSession(storeId, staffId) {
  const businessDate = brisbaneDateISO();
  const existing = unwrap(await supabase.from('stocktake_sessions').select('*')
    .eq('store_id', storeId).eq('business_date', businessDate).maybeSingle());
  if (existing) return camelize(existing);
  const created = unwrap(await supabase.from('stocktake_sessions').insert({
    store_id: storeId, business_date: businessDate, status: 'draft', started_by: staffId,
  }).select().single());
  notifyChange('stocktake_sessions');
  return camelize(created);
}

export async function getSession(sessionId) {
  const data = unwrap(await supabase.from('stocktake_sessions').select('*').eq('id', sessionId).maybeSingle());
  return data ? camelize(data) : null;
}

export async function getSessionProgress(sessionId) {
  const data = unwrap(await supabase.from('stocktake_session_progress').select('*').eq('session_id', sessionId).maybeSingle());
  if (!data) return { totalItems: 0, countedItems: 0, completionPct: 0 };
  return { totalItems: data.total_items, countedItems: data.counted_items, completionPct: data.completion_pct };
}

/**
 * Atomic optimistic-concurrency update: the WHERE version=expectedVersion
 * clause means a stale write matches zero rows instead of racing a
 * separate read-then-compare-then-write. If the session id itself doesn't
 * exist at all (not reachable from any tested UI path — sessionId always
 * comes from a session this device already fetched), this also reports a
 * conflict rather than a distinct "not found", a deliberate simplification
 * matching the mock's own single ConflictError path for anything version-
 * related.
 */
async function updateSessionWithVersionCheck(sessionId, expectedVersion, patch, conflictMessage) {
  const { data, error } = await supabase.from('stocktake_sessions')
    .update(patch).eq('id', sessionId).eq('version', expectedVersion).select().maybeSingle();
  if (error) throw error;
  if (!data) throw new ConflictError(conflictMessage);
  notifyChange('stocktake_sessions');
  return camelize(data);
}

export async function submitSession(sessionId, staffId, expectedVersion) {
  return updateSessionWithVersionCheck(sessionId, expectedVersion,
    { status: 'submitted', submitted_by: staffId, submitted_at: new Date().toISOString() },
    'This stocktake changed since you last loaded it. Reload before submitting.');
}

export async function approveSession(sessionId, staffId, expectedVersion) {
  return updateSessionWithVersionCheck(sessionId, expectedVersion,
    { status: 'approved', approved_by: staffId, approved_at: new Date().toISOString() },
    'This stocktake changed since you last loaded it. Reload before approving.');
}

export async function reopenSession(sessionId, staffId, expectedVersion) {
  return updateSessionWithVersionCheck(sessionId, expectedVersion,
    { status: 'reopened' },
    'This stocktake changed since you last loaded it. Reload before reopening.');
}

// ---- Count lines (append-only) -------------------------------------------------
export async function getCountLines(sessionId) {
  const data = unwrap(await supabase.from('count_lines').select('*').eq('session_id', sessionId).eq('is_current', true));
  return camelize(data);
}

export async function saveCountLine({ sessionId, storeInventoryId, systemQty, countedQty, unit, staffId, recountReason }) {
  if (Number.isNaN(Number(countedQty)) || Number(countedQty) < 0) {
    throw new ValidationError('Enter a valid, non-negative quantity.');
  }
  const existing = unwrap(await supabase.from('count_lines').select('*')
    .eq('session_id', sessionId).eq('store_inventory_id', storeInventoryId).eq('is_current', true).maybeSingle());
  if (existing && existing.staff_id !== staffId && !recountReason) {
    throw new ConflictError(
      `${existing.staff_id === staffId ? 'You' : 'Someone else'} already counted this item. Provide a recount reason to override.`,
    );
  }
  if (existing) unwrap(await supabase.from('count_lines').update({ is_current: false }).eq('id', existing.id));
  const { data: line, error } = await supabase.from('count_lines').insert({
    session_id: sessionId, store_inventory_id: storeInventoryId, system_qty: systemQty, counted_qty: countedQty,
    unit, staff_id: staffId, recount_of_id: existing ? existing.id : null,
    recount_reason: existing ? (recountReason || null) : null, is_current: true,
  }).select().single();
  if (error) {
    // The unique partial index (count_lines_one_current_per_item) is the
    // real backstop if two saves for the same item raced past the
    // existing-row check above.
    if (error.code === '23505') throw new ConflictError('Someone else just counted this item. Reload and provide a recount reason to override.');
    throw error;
  }
  notifyChange('count_lines');
  return camelize(line);
}

export async function getLastCountLineFor(storeInventoryId) {
  const data = unwrap(await supabase.from('count_lines').select('*')
    .eq('store_inventory_id', storeInventoryId).order('counted_at', { ascending: false }).limit(1).maybeSingle());
  return data ? camelize(data) : null;
}

// ---- Staff / auth --------------------------------------------------------------
export async function getStaffPublic(storeId) {
  const data = unwrap(await supabase.from('staff_public').select('*').eq('home_store_id', storeId).eq('active', true));
  return camelize(data);
}

/**
 * Calls the verify-staff-pin Edge Function (service_role, the only code
 * path that can read staff.pin_hash — see 0002/0005) and stores the
 * returned session JWT for supabase-client.js's accessToken callback to
 * pick up on every subsequent request. See AUTH_MODEL.md "Client wiring".
 */
export async function verifyStaffPin(storeId, pin) {
  const clientRef = getOrCreateClientRef();
  const { data, error } = await supabase.functions.invoke('verify-staff-pin', {
    body: { store_id: storeId, pin, client_ref: clientRef },
  });
  if (error) {
    let message = 'Could not reach the server — check your connection and try again.';
    try {
      const body = await error.context?.json?.();
      if (body?.error) message = body.error;
    } catch { /* keep the generic message */ }
    return { ok: false, error: message };
  }
  if (!data.ok) return { ok: false, error: data.error || 'Incorrect PIN' };
  try { sessionStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, data.access_token); } catch { /* ignore */ }
  return { ok: true, staff: { id: data.staff.id, name: data.staff.name, role: data.staff.role, storeId: data.staff.store_id } };
}

// ---- Reports / dashboard helpers -----------------------------------------------
// Pure derivations over the already-real, already-camelized functions
// above — identical logic to database.mock.js, ported unchanged.
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

export async function getStaffCompletion(sessionId, storeId) {
  const [lines, staff] = await Promise.all([getCountLines(sessionId), getStaffPublic(storeId)]);
  return staff.map((s) => ({
    staffId: s.id, name: s.name, role: s.role,
    countedItems: lines.filter((l) => l.staffId === s.id).length,
  })).sort((a, b) => b.countedItems - a.countedItems);
}

export async function getWasteReport(storeId, days = 30) {
  const inv = await getStoreInventory(storeId);
  if (!inv.length) return [];
  const byId = new Map(inv.map((i) => [i.id, i]));
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const data = unwrap(await supabase.from('stock_movements').select('*')
    .eq('movement_type', 'waste').gte('occurred_at', cutoff).in('store_inventory_id', inv.map((i) => i.id)));
  const names = await resolveStaffNames(data.map((m) => m.staff_id));
  return camelize(data).map((m) => {
    const i = byId.get(m.storeInventoryId);
    return {
      itemName: i?.item?.name || 'Item', unit: m.unit, quantity: m.quantity,
      reason: m.reason, staffName: names[m.staffId] || 'Unknown', occurredAt: m.occurredAt,
      estimatedCost: i?.unitCost != null ? Math.round(i.unitCost * m.quantity * 100) / 100 : null,
    };
  }).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

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

// ---- Purchase orders (Priority 7) -----------------------------------------------
export async function getOrders(storeId) {
  const data = unwrap(await supabase.from('purchase_orders').select('*, lines:purchase_order_lines(*)')
    .eq('store_id', storeId).order('created_at', { ascending: false }));
  return data.map((o) => { const { lines, ...rest } = o; return { ...camelize(rest), lines: camelize(lines) }; });
}

export async function createDraftOrder({ storeId, supplierName, lines, actorId }) {
  const name = (supplierName || '').trim();
  if (!name) throw new ValidationError('Supplier name is required.');
  if (!lines || !lines.length) throw new ValidationError('Add at least one item to the order.');

  const invData = unwrap(await supabase.from('store_inventory').select('*, item:item_master(*)')
    .in('id', lines.map((l) => l.storeInventoryId)));
  const invById = new Map(invData.map((r) => [r.id, camelizeInventoryRow(r)]));
  const builtLines = lines.map((l) => {
    const inv = invById.get(l.storeInventoryId);
    if (!inv) throw new ValidationError('One of the selected items could not be found.');
    const qty = Number(l.quantityOrdered);
    if (!(qty > 0)) throw new ValidationError(`Quantity for ${inv.item?.name || 'an item'} must be greater than zero.`);
    return { store_inventory_id: inv.id, item_name: inv.item?.name || '', unit: inv.unit, quantity_ordered: qty, unit_cost_at_order: inv.unitCost ?? null };
  });

  const order = unwrap(await supabase.from('purchase_orders').insert({
    store_id: storeId, supplier_name: name, status: 'draft', created_by: actorId,
  }).select().single());
  const { error: linesErr } = await supabase.from('purchase_order_lines')
    .insert(builtLines.map((l) => ({ ...l, purchase_order_id: order.id })));
  if (linesErr) {
    // No delete policy on purchase_orders (0007 — cancel instead of
    // deleting), so an orphaned zero-line draft can't be cleaned up here;
    // it would show as an empty draft order, a rare edge case worth
    // cancelling by hand if it ever happens rather than adding a delete
    // policy just to cover a two-step-write failure.
    throw linesErr;
  }
  await recordAudit({ storeId, actorId, action: 'order_created', entityType: 'purchase_order', entityId: order.id, afterState: camelize(order) });
  notifyChange('purchase_orders');
  return camelize(order);
}

export async function updateOrderLineQty(lineId, quantityOrdered, actorId) {
  const line = unwrap(await supabase.from('purchase_order_lines').select('*, order:purchase_orders(*)').eq('id', lineId).single());
  if (line.order.status !== 'draft') throw new ValidationError('Only a draft order can be edited.');
  const qty = Number(quantityOrdered);
  if (!(qty > 0)) throw new ValidationError('Quantity must be greater than zero.');
  const updated = unwrap(await supabase.from('purchase_order_lines').update({ quantity_ordered: qty }).eq('id', lineId).select().single());
  await recordAudit({ storeId: line.order.store_id, actorId, action: 'order_line_changed', entityType: 'purchase_order_line', entityId: lineId, afterState: camelize(updated) });
  notifyChange('purchase_order_lines');
  return camelize(updated);
}

export async function removeOrderLine(lineId, actorId) {
  const { data: line, error: getErr } = await supabase.from('purchase_order_lines').select('*, order:purchase_orders(*)').eq('id', lineId).single();
  if (getErr || !line) return;
  if (line.order.status !== 'draft') throw new ValidationError('Only a draft order can be edited.');
  const { count } = await supabase.from('purchase_order_lines').select('*', { count: 'exact', head: true }).eq('purchase_order_id', line.purchase_order_id);
  if ((count ?? 0) <= 1) throw new ValidationError('Cancel the order instead of removing its only item.');
  unwrap(await supabase.from('purchase_order_lines').delete().eq('id', lineId));
  await recordAudit({ storeId: line.order.store_id, actorId, action: 'order_line_removed', entityType: 'purchase_order_line', entityId: lineId, beforeState: camelize(line) });
  notifyChange('purchase_order_lines');
}

export async function markOrderSent(orderId, actorId) {
  const before = unwrap(await supabase.from('purchase_orders').select('*').eq('id', orderId).single());
  if (before.status !== 'draft') throw new ValidationError('Only a draft order can be marked as sent.');
  const updated = unwrap(await supabase.from('purchase_orders')
    .update({ status: 'sent', sent_by: actorId, sent_at: new Date().toISOString() }).eq('id', orderId).select().single());
  await recordAudit({ storeId: before.store_id, actorId, action: 'order_sent', entityType: 'purchase_order', entityId: orderId, beforeState: camelize(before), afterState: camelize(updated) });
  notifyChange('purchase_orders');
  return camelize(updated);
}

export async function cancelOrder(orderId, reason, actorId) {
  const before = unwrap(await supabase.from('purchase_orders').select('*').eq('id', orderId).single());
  if (before.status === 'received' || before.status === 'cancelled') throw new ValidationError('This order can no longer be cancelled.');
  const updated = unwrap(await supabase.from('purchase_orders')
    .update({ status: 'cancelled', cancelled_by: actorId, cancelled_at: new Date().toISOString(), cancel_reason: (reason || '').trim() || null })
    .eq('id', orderId).select().single());
  await recordAudit({ storeId: before.store_id, actorId, action: 'order_cancelled', entityType: 'purchase_order', entityId: orderId, beforeState: camelize(before), afterState: camelize(updated) });
  notifyChange('purchase_orders');
  return camelize(updated);
}

/** lines: [{ lineId, quantityReceived, useByDate? }] */
export async function receiveOrder({ orderId, lines, actorId }) {
  const order = unwrap(await supabase.from('purchase_orders').select('*').eq('id', orderId).single());
  if (order.status !== 'sent') throw new ValidationError('Only a sent order can be received.');
  if (!lines || !lines.length) throw new ValidationError('Nothing to receive.');

  const orderLines = unwrap(await supabase.from('purchase_order_lines').select('*')
    .in('id', lines.map((l) => l.lineId)).eq('purchase_order_id', orderId));
  const linesById = new Map(orderLines.map((l) => [l.id, l]));
  const invRows = unwrap(await supabase.from('store_inventory').select('*').in('id', orderLines.map((l) => l.store_inventory_id)));
  const invById = new Map(invRows.map((r) => [r.id, r]));

  const plans = lines.map((l) => {
    const line = linesById.get(l.lineId);
    if (!line) throw new ValidationError('One of the order lines could not be found.');
    const qty = Number(l.quantityReceived);
    if (Number.isNaN(qty) || qty < 0) throw new ValidationError(`Received quantity for ${line.item_name} must be zero or more.`);
    const inv = invById.get(line.store_inventory_id);
    if (!inv) throw new ValidationError(`${line.item_name} is no longer in this store's inventory.`);
    if (l.useByDate && !/^\d{4}-\d{2}-\d{2}$/.test(l.useByDate)) throw new ValidationError('Use-by date is not valid.');
    return { line, inv, qty, useByDate: l.useByDate || null };
  });

  const today = brisbaneDateISO();
  const ref = `Order #${orderId.slice(-6)}`;
  for (const { line, inv, qty, useByDate } of plans) {
    unwrap(await supabase.from('purchase_order_lines').update({ quantity_received: qty }).eq('id', line.id));
    if (qty > 0) {
      const newStock = Math.round((Number(inv.current_stock) + qty) * 100) / 100;
      unwrap(await supabase.from('store_inventory').update({ current_stock: newStock }).eq('id', inv.id));
      unwrap(await supabase.from('stock_movements').insert({
        store_inventory_id: inv.id, movement_type: 'delivery', quantity: qty, unit: inv.unit, reference: ref, staff_id: actorId,
      }));
      if (useByDate) {
        unwrap(await supabase.from('item_batches').insert({
          store_inventory_id: inv.id, quantity_received: qty, quantity_remaining: qty,
          received_date: today, use_by_date: useByDate, supplier_reference: ref, status: 'active',
        }));
      }
    }
  }
  const updatedOrder = unwrap(await supabase.from('purchase_orders')
    .update({ status: 'received', received_by: actorId, received_at: new Date().toISOString() }).eq('id', orderId).select().single());
  await recordAudit({ storeId: order.store_id, actorId, action: 'order_received', entityType: 'purchase_order', entityId: orderId, beforeState: camelize(order), afterState: camelize(updatedOrder) });
  notifyChange('purchase_orders'); notifyChange('store_inventory'); notifyChange('item_batches');
  return camelize(updatedOrder);
}

// ---- Cash counts (Priority 9) ----------------------------------------------------
function sumDenominations(denominations) {
  return CASH_DENOMINATIONS.reduce((sum, d) => sum + (Number(denominations[d.key]) || 0) * d.value, 0);
}

export async function getCashCounts(storeId) {
  const data = unwrap(await supabase.from('cash_counts').select('*').eq('store_id', storeId).order('created_at', { ascending: false }));
  const names = await resolveStaffNames(data.flatMap((c) => [c.staff_id, c.approved_by]));
  return camelize(data).map((c) => ({
    ...c, staffName: names[c.staffId] || 'Unknown', approverName: c.approvedBy ? (names[c.approvedBy] || 'Unknown') : null,
  }));
}

export async function saveCashCount({ storeId, register, shift, expectedCash, denominations, staffId, notes, recountReason }) {
  const reg = (register || '').trim();
  if (!reg) throw new ValidationError('Register name is required.');
  if (!CASH_SHIFTS.some((s) => s.key === shift)) throw new ValidationError('Choose a shift.');
  const countedCash = Math.round(sumDenominations(denominations || {}) * 100) / 100;
  if (countedCash <= 0) throw new ValidationError('Enter at least one denomination — the count can’t be zero.');
  const expected = expectedCash === '' || expectedCash == null ? null : Number(expectedCash);
  if (expected != null && (Number.isNaN(expected) || expected < 0)) throw new ValidationError('Expected amount must be zero or more.');

  const businessDate = brisbaneDateISO();
  // RLS (cash_counts_select, 0008) only lets a non-manager see their OWN
  // rows, so a colleague's still-current count for this slot may be
  // invisible to this pre-check even though it exists. That's the correct
  // security property (staff can't even detect a colleague counted a
  // specific register) — the unique index (cash_counts_one_current_per_slot)
  // is the real backstop for that case, its violation caught below and
  // translated into the same friendly message this pre-check would give.
  const existing = unwrap(await supabase.from('cash_counts').select('*')
    .eq('store_id', storeId).eq('register', reg).eq('shift', shift).eq('count_date', businessDate).eq('is_current', true).maybeSingle());
  if (existing) {
    if (existing.staff_id !== staffId && !(await isManagerStaff(staffId))) {
      throw new ValidationError(`${reg} (${shift}) was already counted today by someone else. A manager needs to record the recount.`);
    }
    if (!String(recountReason || '').trim()) {
      throw new ConflictError(`${reg} (${shift}) has already been counted today. Provide a reason to save a recount.`);
    }
  }
  if (existing) unwrap(await supabase.from('cash_counts').update({ is_current: false }).eq('id', existing.id));

  const { data: c, error } = await supabase.from('cash_counts').insert({
    store_id: storeId, register: reg, shift, count_date: businessDate, denominations: denominations || {},
    counted_cash: countedCash, expected_cash: expected, notes: (notes || '').trim() || null, staff_id: staffId,
    recount_of_id: existing ? existing.id : null, recount_reason: existing ? recountReason.trim() : null, is_current: true,
  }).select().single();
  if (error) {
    if (error.code === '23505') {
      throw new ValidationError(`${reg} (${shift}) was already counted today by someone else. A manager needs to record the recount.`);
    }
    throw error;
  }
  await recordAudit({
    storeId, actorId: staffId, action: existing ? 'cash_count_recounted' : 'cash_count_saved',
    entityType: 'cash_count', entityId: c.id, beforeState: existing ? { countedCash: existing.counted_cash } : null, afterState: camelize(c),
  });
  notifyChange('cash_counts');
  return camelize(c);
}

export async function approveCashCount(cashCountId, actorId) {
  if (!(await isManagerStaff(actorId))) throw new ValidationError('Only a manager can approve a cash count.');
  const before = unwrap(await supabase.from('cash_counts').select('*').eq('id', cashCountId).single());
  if (before.approved_by) throw new ValidationError('This cash count is already approved.');
  const updated = unwrap(await supabase.from('cash_counts')
    .update({ approved_by: actorId, approved_at: new Date().toISOString() }).eq('id', cashCountId).select().single());
  await recordAudit({ storeId: before.store_id, actorId, action: 'cash_count_approved', entityType: 'cash_count', entityId: cashCountId, beforeState: camelize(before), afterState: camelize(updated) });
  notifyChange('cash_counts');
  return camelize(updated);
}

// ---- Announcements ------------------------------------------------------------------
export async function getAnnouncements(storeId) {
  const data = unwrap(await supabase.from('announcements').select('*')
    .or(`store_id.is.null,store_id.eq.${storeId}`).order('created_at', { ascending: false }));
  return camelize(data);
}

export async function postAnnouncement({ storeId, message, staffId, staffName }) {
  const data = unwrap(await supabase.from('announcements').insert({
    store_id: storeId ?? null, message, staff_id: staffId, staff_name: staffName || null,
  }).select().single());
  notifyChange('announcements');
  return camelize(data);
}

// ---- Roster (read-only from this app) -----------------------------------------------
export async function getRoster(storeId) {
  const data = unwrap(await supabase.from('roster_shifts').select('*').eq('store_id', storeId));
  return camelize(data);
}
