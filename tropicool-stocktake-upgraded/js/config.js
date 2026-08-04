/**
 * Shared constants. No secrets live here — the Supabase anon key is safe to
 * ship in frontend code (Supabase's own model), but this project isn't
 * pointed at a real project yet (see DATA_MODEL.md / AUTH_MODEL.md), so
 * SUPABASE_URL/SUPABASE_ANON_KEY are left blank and database.js runs in
 * mock mode until they're filled in as part of an explicitly approved
 * deployment step.
 */
export const SUPABASE_URL = '';
export const SUPABASE_ANON_KEY = '';

export const STORES = [
  { id: 'store_mooloolaba', slug: 'mooloolaba', name: 'Mooloolaba' },
  { id: 'store_noosa', slug: 'noosa', name: 'Noosa' },
  { id: 'store_sunnybank', slug: 'sunnybank', name: 'Sunnybank' },
];

export const MAIN_CATEGORIES = {
  fridge: { label: 'Fridge', icon: 'fridge' },
  freezer: { label: 'Freezer', icon: 'freezer' },
  shelf: { label: 'Shelf', icon: 'shelf' },
};

export const CATEGORIES = {
  frozen: { label: 'Frozen Items', main: 'freezer' },
  frozenfruit: { label: 'Frozen Fruit', main: 'freezer' },
  tiramisus: { label: 'Tiramisus', main: 'freezer' },
  fridge: { label: 'Rest of Fridge', main: 'fridge' },
  freshfruit: { label: 'Fresh Fruit', main: 'fridge' },
  milk: { label: 'Milk', main: 'fridge' },
  juices: { label: 'Juices', main: 'fridge' },
  sauces: { label: 'Sauces', main: 'fridge' },
  premix: { label: 'Pre Mix', main: 'fridge' },
  toppings: { label: 'Toppings', main: 'shelf' },
  cleaning: { label: 'Cleaning', main: 'shelf' },
  packaging: { label: 'Packaging', main: 'shelf' },
  dry: { label: 'Misc', main: 'shelf' },
};

// Unit-aware count increments (Priority 4). Anything not listed falls back
// to whole-unit steps of 1.
export const UNIT_STEPS = {
  units: 1, unit: 1, tubs: 1, tub: 1, bottles: 1, bottle: 1,
  boxes: 1, box: 1, packs: 1, pack: 1, bags: 1, bag: 1,
  kg: 0.1, kilograms: 0.1,
  l: 0.1, litres: 0.1, liters: 0.1,
  g: 10, grams: 10,
  ml: 50,
};

export function stepForUnit(unit) {
  const key = String(unit || '').trim().toLowerCase();
  return UNIT_STEPS[key] ?? 1;
}

export function decimalsForUnit(unit) {
  const step = stepForUnit(unit);
  return step < 1 ? String(step).split('.')[1]?.length ?? 1 : 0;
}

export const EXPIRY_WARN_DAYS = 3;
export const SESSION_STORAGE_KEY = 'tt_session_v2';
export const DRAFT_STORAGE_PREFIX = 'tt_draft_v2_';
export const CLIENT_REF_KEY = 'tt_client_ref';

export function getOrCreateClientRef() {
  try {
    let ref = localStorage.getItem(CLIENT_REF_KEY);
    if (!ref) {
      ref = 'dev_' + crypto.randomUUID();
      localStorage.setItem(CLIENT_REF_KEY, ref);
    }
    return ref;
  } catch {
    return 'dev_no_storage';
  }
}
