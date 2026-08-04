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

// ---- Error prevention / anomaly confirmation (Priority 5) -----------------------

/**
 * How far a count can differ from the system quantity before it's treated
 * as worth a second look. Documented here as a single constant standing in
 * for what the brief calls a "manager-defined threshold" — there's no
 * per-store settings table yet (see DATA_MODEL.md), so this isn't actually
 * configurable from the UI yet. Flagged rather than pretending it is.
 */
export const ANOMALY_VARIANCE_PCT = 0.5;

/** True if `value` has more decimal places than the unit's step allows. */
export function hasInvalidDecimals(value, unit) {
  const str = String(value);
  const decimalPart = str.includes('.') ? str.split('.')[1] : '';
  return decimalPart.length > decimalsForUnit(unit);
}

const ALLOWED_URL_PROTOCOLS = ['http:', 'https:'];

/**
 * Normalises a supplier URL, prepending https:// only when the user typed
 * no scheme at all. If they *did* type an explicit scheme, it's validated
 * against an allow-list rather than trusted — this is what stops a
 * javascript: or data: URL from being stored and later rendered as a
 * clickable supplier link.
 * Returns { ok: true, url } or { ok: false, error }.
 */
/**
 * Reasons a just-entered count is worth a second look before it saves
 * (Priority 5 "anomaly confirmation" — these are warnings the user can
 * proceed past, distinct from the hard validation errors above that block
 * saving outright). Returns an array of human-readable strings; empty if
 * nothing's unusual.
 */
export function getAnomalyReasons(inv, countedQty) {
  const reasons = [];
  const system = Number(inv.currentStock) || 0;
  const qty = Number(countedQty);
  if (inv.maxStock != null && qty > inv.maxStock) {
    reasons.push(`Above the max level of ${inv.maxStock} ${inv.unit}`);
  }
  if (qty === 0 && system > 0) {
    reasons.push(`Counted as zero, but the system expected ${system} ${inv.unit}`);
  }
  const pctChange = system === 0 ? (qty > 0 ? Infinity : 0) : Math.abs(qty - system) / system;
  if (pctChange > ANOMALY_VARIANCE_PCT && !(qty === 0 && system > 0)) {
    const dir = qty > system ? 'higher' : 'lower';
    reasons.push(`${Math.round(pctChange * 100)}% ${dir} than the system quantity of ${system} ${inv.unit}`);
  }
  return reasons;
}

export function validateSupplierUrl(raw) {
  const v = (raw || '').trim();
  if (!v) return { ok: true, url: '' };
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`;
  let parsed;
  try { parsed = new URL(candidate); } catch { return { ok: false, error: 'That doesn’t look like a valid URL' }; }
  if (!ALLOWED_URL_PROTOCOLS.includes(parsed.protocol)) {
    return { ok: false, error: `Links must start with http:// or https:// (not ${parsed.protocol})` };
  }
  return { ok: true, url: parsed.toString() };
}

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
