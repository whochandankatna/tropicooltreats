/**
 * In-memory mock data layer standing in for the real Supabase project until
 * the Phase 2/3 migrations are reviewed, approved, and actually run (see
 * DATA_MODEL.md, AUTH_MODEL.md — nothing has been deployed). Shaped after
 * the proposed schema (store_inventory, stocktake_sessions, count_lines,
 * stock_movements) so swapping database.js's implementation over to real
 * Supabase calls later is a like-for-like swap, not a rewrite.
 *
 * Everything here resets on page reload except what stocktake.js explicitly
 * persists to localStorage as a draft (see DRAFT_STORAGE_PREFIX in
 * config.js) — that's deliberate: it's what lets Phase 4 demonstrate real
 * "survive a refresh" draft behaviour without a backend.
 */
import { STORES, CATEGORIES } from './config.js';
import { hashPin } from './pin-hash.js';
import { brisbaneDateISO } from './date.js';

function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

const MOO = STORES[0].id;

const itemSeed = [
  { name: 'Vanilla Gelato Base', category: 'premix', unit: 'tubs', par: 4, max: 14, stock: 9, important: true, criticalItem: true },
  { name: 'Choc Gelato Base', category: 'premix', unit: 'tubs', par: 4, max: 14, stock: 2, important: true, criticalItem: true },
  { name: 'Mango Sorbet Base', category: 'premix', unit: 'tubs', par: 3, max: 10, stock: 6 },
  { name: 'Frozen Strawberries', category: 'frozenfruit', unit: 'kg', par: 5, max: 20, stock: 4.5 },
  { name: 'Frozen Mango', category: 'frozenfruit', unit: 'kg', par: 5, max: 20, stock: 12 },
  { name: 'Frozen Blueberries', category: 'frozenfruit', unit: 'kg', par: 3, max: 12, stock: 1.2 },
  { name: 'Waffle Cones', category: 'packaging', unit: 'boxes', par: 3, max: 12, stock: 5 },
  { name: 'Cups (Regular)', category: 'packaging', unit: 'packs', par: 4, max: 16, stock: 3 },
  { name: 'Cups (Large)', category: 'packaging', unit: 'packs', par: 4, max: 16, stock: 9 },
  { name: 'Spoons', category: 'packaging', unit: 'packs', par: 3, max: 12, stock: 10 },
  { name: 'Fresh Bananas', category: 'freshfruit', unit: 'kg', par: 3, max: 10, stock: 2.8 },
  { name: 'Fresh Strawberries', category: 'freshfruit', unit: 'kg', par: 3, max: 10, stock: 1.8, expiresInDays: 2 },
  { name: 'Full Cream Milk', category: 'milk', unit: 'litres', par: 6, max: 24, stock: 8, expiresInDays: 5 },
  { name: 'Oat Milk', category: 'milk', unit: 'litres', par: 3, max: 12, stock: 1 },
  { name: 'Orange Juice', category: 'juices', unit: 'litres', par: 4, max: 16, stock: 10 },
  { name: 'Chocolate Sauce', category: 'sauces', unit: 'bottles', par: 2, max: 8, stock: 1 },
  { name: 'Caramel Sauce', category: 'sauces', unit: 'bottles', par: 2, max: 8, stock: 5 },
  { name: 'Rainbow Sprinkles', category: 'toppings', unit: 'tubs', par: 2, max: 8, stock: 3 },
  { name: 'Crushed Nuts', category: 'toppings', unit: 'tubs', par: 2, max: 8, stock: 0, important: true },
  { name: 'Sanitiser Spray', category: 'cleaning', unit: 'bottles', par: 2, max: 8, stock: 6 },
  { name: 'Tiramisu Cups', category: 'tiramisus', unit: 'units', par: 6, max: 24, stock: 3, expiresInDays: 1 },
  { name: 'Napkins', category: 'dry', unit: 'packs', par: 3, max: 12, stock: 11 },
];

export async function seedMockData() {
  const today = brisbaneDateISO();

  const items = itemSeed.map((s) => ({
    id: uid('item'),
    name: s.name,
    categoryKey: s.category,
    defaultUnit: s.unit,
    criticalItem: !!s.criticalItem,
    archived: false,
  }));

  const storeInventory = items.map((item, i) => {
    const s = itemSeed[i];
    return {
      id: uid('inv'),
      storeId: MOO,
      itemId: item.id,
      storageArea: CATEGORIES[s.category]?.main || 'shelf',
      storageLocation: '',
      unit: s.unit,
      currentStock: s.stock,
      reorderPoint: s.par,
      lowWarningAt: Math.round(s.par * 1.4 * 10) / 10,
      targetStock: Math.round((s.par + s.max) / 2),
      maxStock: s.max,
      supplierName: '',
      supplierUrl: '',
      important: !!s.important,
      active: true,
    };
  });

  const batches = [];
  itemSeed.forEach((s, i) => {
    if (s.expiresInDays === undefined) return;
    const useBy = new Date();
    useBy.setDate(useBy.getDate() + s.expiresInDays);
    batches.push({
      id: uid('batch'),
      storeInventoryId: storeInventory[i].id,
      quantityRemaining: storeInventory[i].currentStock,
      receivedDate: today,
      useByDate: useBy.toISOString().slice(0, 10),
      status: 'active',
    });
  });

  const staff = [
    { id: uid('staff'), storeId: MOO, name: 'Alice Nguyen', role: 'staff', pin: '1111' },
    { id: uid('staff'), storeId: MOO, name: 'Bob Ferreira', role: 'manager', pin: '2222' },
    { id: uid('staff'), storeId: MOO, name: 'Chloe Sanders', role: 'staff', pin: '3333' },
  ];
  for (const s of staff) {
    s.pinHash = await hashPin(s.pin);
    delete s.pin; // never keep the plaintext around, even in the mock layer
    s.active = true;
    s.failedPinAttempts = 0;
    s.lockedUntil = null;
  }

  // One in-progress session so the Home/Count screens have something real
  // to resume on first load.
  const session = {
    id: uid('sess'),
    storeId: MOO,
    businessDate: today,
    status: 'in_progress',
    startedBy: staff[0].id,
    startedAt: new Date().toISOString(),
    submittedBy: null,
    submittedAt: null,
    approvedBy: null,
    approvedAt: null,
    notes: '',
    version: 1,
  };

  // Pre-count a few items so progress/variance widgets have real data.
  const countLines = [];
  const preCounted = [0, 1, 6]; // indices into storeInventory
  preCounted.forEach((idx) => {
    const inv = storeInventory[idx];
    const countedQty = idx === 1 ? 2 : inv.currentStock; // index 1 (Choc Gelato) gets a real variance
    countLines.push({
      id: uid('cl'),
      sessionId: session.id,
      storeInventoryId: inv.id,
      systemQty: inv.currentStock,
      countedQty,
      unit: inv.unit,
      staffId: staff[0].id,
      countedAt: new Date().toISOString(),
      recountOfId: null,
      recountReason: null,
      isCurrent: true,
    });
  });

  return {
    items,
    storeInventory,
    batches,
    staff,
    stocktakeSessions: [session],
    countLines,
    stockMovements: [],
    cashCounts: [],
    announcements: [
      { id: uid('ann'), message: 'Freezer 2 door seal is loose again, logged with maintenance.', staffName: 'Bob Ferreira', createdAt: new Date(Date.now() - 3600e3 * 5).toISOString() },
    ],
    rosterShifts: [],
  };
}
