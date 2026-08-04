# Tropicool Treats Stocktake — Audit of `tropicool-stocktake_9.html`

Audit date: 2026-08-04
Source file: `tropicool-stocktake_9.html` (3,304 lines, single-file HTML/CSS/JS), unmodified, preserved at repo root.

This document is the required first deliverable before any code changes: a full read of the existing app, its Supabase dependency, and a list of confirmed defects and open questions, organised by the priority order in the upgrade brief.

---

## 1. Frontend structure

Single HTML file with three parts:

- **Lines 1–767**: inline `<style>`. CSS custom properties drive a light/dark theme (`html[data-theme="dark"]`). No build step, no CSS framework.
- **Lines 769–884**: static shell markup — splash screen, sidebar (desktop ≥900px), top HUD (title, sync/health status, tab bar), a single `#stkContent` div that every screen renders into, a modal overlay, a toast.
- **Lines 885–3302**: one `<script>` block, no modules, everything in global scope. All UI is generated as HTML strings (`innerHTML`) and re-bound after every `render()` call — there is no virtual DOM/diffing, so every render tears down and rebuilds listeners.

Client-side "router" is a set of module-level variables (`activeTab`, `dashMain`, `dashCategory`, `entryMain`, `entryCategory`, `itemsSubTab`, `dashSection`, …) that `render()` branches on. No URL routing — refresh always returns to the dashboard root, so a mid-count staff member who refreshes loses their place in the drill-down (though in-progress *counts* are held in Supabase per keystroke save, not lost, see §5).

Five tabs today: **Dashboard, Stocktake (daily entry), Items, Roster, Cash**. Peanut board, Announcements, and Staff management are nested inside Dashboard/Items rather than being top-level.

## 2. Supabase tables and fields referenced

No migration files exist in the repo; the schema below is *inferred entirely from client queries*. It must be confirmed against the live database before any migration is written.

| Table | Fields referenced by the client | Notes |
|---|---|---|
| `tt_items` | `id, name, unit, category, current_stock, par, low_at, max_at, reorder_qty, supplier_url, supplier_name, expiry_date, important, updated_at` | One row per item. `current_stock` is live on-hand, overwritten directly by both stocktake saves and manual edits — no history. Single `expiry_date` per item (§6). No `store_id`. |
| `tt_entries` | `item_id, entry_date, opening, received, closing, usage, staff_name, created_at` | Primary key is effectively `(item_id, entry_date)` — `saveEntry` upserts `onConflict:'item_id,entry_date'`, so **a second count of the same item on the same day overwrites the first with no trace of the original** (confirmed, §5). `received` is always written as `0` — the field exists but nothing in the UI ever sets it. |
| `tt_subcategories` | `key, main_category` | Maps a subcategory (e.g. `sauces`) to a main storage area (`fridge`/`freezer`/`shelf`). |
| `tt_staff` | `id, name, active, pin, role` | `role` is either `'manager'` or anything else treated as staff. `pin` is stored and read back to the browser today (§7 — critical finding). |
| `tt_staff_working` | `team_member_id, name, clocked_in_at` | Read-only from this client; nothing here writes to it, so the clock-in source is external/unknown. |
| `tt_roster` | `team_member_id, name, start_at, end_at` | Read-only from this client. |
| `tt_cash_counts` | `count_date, amount, staff_name, notes, created_at` | Single `amount` field, no register/shift/expected-cash/approval (§9). |
| `tt_announcements` | `id, message, staff_name, created_at` | Simple feed, hard delete. |
| `tt_push_subscriptions` | `endpoint, p256dh, auth, staff_name` | Web Push subscriptions, upserted on `endpoint`. |

**Edge Function referenced but not present in this repo:** `verify-staff-pin` (called at line 3234 via `fetch(`${SUPABASE_URL}/functions/v1/verify-staff-pin`)`). Its source is not available to this audit — whether it hashes/salts PINs, rate-limits, or just does a plaintext lookup is **unknown and must be confirmed** before any claim is made about current PIN security.

**No `store_id`, no session/versioning columns, no audit log table, no batches table, no stock-movements table exist anywhere in the referenced schema.**

## 3. Authentication and PIN flow

1. On load, `checkPinLockNeeded()` runs a `count`-only query (`head:true`, so no row data returned) for `tt_staff` rows with a non-null `pin`. If zero, no lock is shown — the app is fully open (this is presumably the app's current live state, since there's no other login gate).
2. If PINs exist, a 4-digit keypad overlay appears. Entering 4 digits calls `verify-staff-pin` with the anon key as bearer token and gets back `{ ok, name, role }` or an error.
3. On success, `currentStaffName`/`currentStaffRole` are set as **plain in-memory JS variables** — not a token, not persisted, not attached to any subsequent database call. `localStorage.tt_last_staff_name` is set too, but that's just a display convenience, not a credential.
4. Every later "permission" check in the app (`canManageStaff`, `canSeeCashHistory`, the staff sub-tab) is a plain `if (currentStaffRole === 'manager')` in client JS that decides what to render. **Nothing enforces this server-side.** The Supabase client is initialised with the anon key and used for every table identically regardless of `currentStaffRole` — there is no `.eq('store_id', ...)`, no JWT claim, no Supabase Auth session at all.
5. No rate limiting or lockout on PIN attempts (client-side or visible server-side).
6. No logout button anywhere in the UI.
7. No session expiry — once past the keypad, the tab stays "authenticated" (i.e., `currentStaffRole` in memory) indefinitely until the page is closed or reloaded.

## 4. Current counting and usage calculation

`onSaveEntry()` (the Daily Entry save handler) is the only counting workflow. Per item with a non-empty input:

```
usage = Math.max(0, opening - closing)
```

where `opening` is always read from the item's *current* `current_stock` at save time, not from a stored opening balance for the day. Then:

- `saveEntry()` upserts the `tt_entries` row for `(item_id, today)`, replacing anything already there.
- `item.currentStock = closing` and a *separate* `saveItem()` call overwrites `tt_items.current_stock`.

Confirmed defects:

- **Deliveries look like negative usage and get silently zeroed.** If stock goes *up* between counts (a delivery arrived and nobody logged it as a separate movement), `closing > opening`, so `Math.max(0, ...)` reports `0` usage instead of a negative number or a received-quantity prompt. This is the exact anti-pattern called out in the brief.
- **No stock-movement types exist at all** — no deliveries, waste, transfers, prep/production, or manual-adjustment records. `received` is a column on `tt_entries` that is always hard-coded to `0`.
- **Each item saves independently, not atomically.** The save loop in `onSaveEntry` does `for (const row of ...) { await saveEntry(...); await saveItem(...); }` and simply continues past a failed row (`ok=false` but the loop keeps going). A dropped connection partway through leaves some items updated and others not, with a generic toast and no retry/resume affordance, and no idempotency key.
- **No conflict detection.** Two people counting the same item on the same day: the second `saveEntry` silently overwrites the first (upsert on `item_id, entry_date`), with no "X changed this 4 minutes ago" warning, no version check.

## 5. Realtime subscriptions

One channel (`subscribeRealtime`, `db.channel('stocktake-sync')`) listens to `postgres_changes` on `tt_items`, `tt_entries`, `tt_subcategories`, `tt_staff_working`, `tt_roster`, `tt_staff`, `tt_cash_counts`, `tt_announcements`. Every event handler does a full reload of that table plus a full `render()` — no merge logic, no diffing against in-flight local edits. If Staff A is mid-count and Staff B's save triggers a `tt_items` realtime event, Staff A's screen re-renders from the server state; any not-yet-saved input in open text fields is not explicitly clobbered (the entry rows are keyed by item id and inputs aren't controlled/re-templated for unrelated field changes only if the whole row list changes — since `renderEntry`/`renderEntryForm` re-run wholesale on `tt_items` changes, **any unsaved keystroke in the currently open count screen is lost** the moment any other device saves anything to `tt_items`).

## 6. Stock threshold logic

```
statusFor(item):
  reorder  if currentStock <= par
  low      if lowAt && currentStock <= lowAt      (lowAt auto = round(par * 1.4) unless set)
  over     if maxAt && maxAt > 0 && currentStock >= maxAt
  else ok
```

Single `expiryDate` per item (not batch-level); `EXPIRY_WARN_DAYS = 3` fixed. No lead time, safety-stock days, supplier pack size, order pack rounding, or critical-item-flag-driven behaviour beyond the `important` boolean (which only affects a dashboard filter, not ordering logic).

## 7. Security review — confirmed findings (frontend-observable)

These are established from reading the client code; anything requiring database or Supabase-project access to fully confirm is called out separately in §11.

1. **CRITICAL — Staff PINs are fetched to the browser.** `loadStaffList()` runs `db.from('tt_staff').select('*')` and the result (including `pin`) is held in the `staffList` array and used directly (`s.pin ? '· PIN set' : '· no PIN yet'`, line 2942) to render the staff admin panel. Every browser session that loads the Items → Staff tab receives every staff member's PIN in the network response, whatever the anon key's row-level security currently allows. This must be fixed by (a) never selecting `pin` in a client-facing query and (b) enforcing that at the database layer (RLS/column privileges), not just by editing this one call site.
2. **CRITICAL — All role checks are client-side only and trivially bypassable.** `currentStaffRole` is a plain JS variable. Setting `currentStaffRole = 'manager'` in the browser console (or simply not going through the PIN screen at all and calling the exposed `init()`/save functions directly) unlocks every "manager-only" UI branch, and — more importantly — nothing stops the anon Supabase key from writing to any table regardless of what the UI shows. Whether this is actually exploitable depends entirely on the live RLS policies, which this audit cannot see. **This must be verified against the live Supabase project before relying on anything else in this list** (see §11).
3. **HIGH — Permission checks fail open, not closed.** Both `canManageStaff` and `canSeeCashHistory` are `currentStaffRole === 'manager' || currentStaffRole === null`. Since `currentStaffRole` starts as `null` and only becomes non-null after a successful PIN check, **any session that skips or predates PIN setup is treated as a manager** for staff management and cash history visibility.
4. **HIGH — No rate limiting on PIN entry.** A 4-digit PIN is 10,000 combinations; `submitPin()` has no attempt counter, backoff, or lockout visible client-side, and calls the edge function directly with the (public) anon key.
5. **MEDIUM — Sign-off can impersonate any staff member.** The "Signed off by" / "Counted by" pickers on Daily Entry, Cash Count, and Announcements are a free list of buttons for every active staff member — clicking any of them signs the record as that person, regardless of who authenticated. There is no binding between the PIN-verified identity and who a count/cash entry/announcement is attributed to.
6. **MEDIUM — Deletion is destructive with no confirmation.** `deleteItem()` runs immediately on clicking "Remove" in the items table — no `confirm()`, no archive, no undo, no audit trail. (Verified: no `confirm(` call anywhere in the file.)
7. **LOW — No logout, no session expiry.** Once a PIN is accepted, the session runs indefinitely on that device with no way to sign out or lock again from the UI.
8. **LOW — Supplier URL validation is minimal.** `normalizeUrl()` prepends `https://` if no `http(s)://` prefix exists, but does not reject other schemes (e.g. `javascript:`) typed with an explicit protocol. All rendered supplier links do correctly carry `rel="noopener noreferrer"` and `target="_blank"`, and `esc()`/`escAttr()` are applied consistently everywhere user text is interpolated into HTML — no obvious stored-XSS path was found in the templates read.

Everything above is about **authorisation**, not about the anon key being present in the HTML — a public anon key in frontend code is normal Supabase practice and is not itself a defect, *provided* RLS is correctly configured to enforce the boundaries this app currently only pretends to enforce in JavaScript.

## 8. Cash counting

Single form: amount, staff (from the same free-pick chip list as §7.5), optional notes. Saved to `tt_cash_counts`. "Today so far" sums every count logged today into one total and displays it next to the individual entries — this **combines multiple registers/shifts into one figure**, which is exactly the anti-pattern flagged in the brief (no register, no shift, no expected-vs-counted variance, no denomination breakdown, no manager approval field). History access is gated by the same fail-open `canSeeCashHistory` check as §7.3.

## 9. Notifications and service worker

- `service-worker.js` is registered (`initPushNotifications`, line 3148) but **does not exist anywhere in this repo** — registration will fail in any environment that doesn't separately host that file next to the HTML. Confirmed via `find`/`grep`: no `service-worker.js`, no `manifest.webmanifest`, no `<link rel="manifest">` anywhere in the document.
- Push subscription flow (VAPID key hard-coded, `enablePushNotifications`) writes to `tt_push_subscriptions` but nothing in this file ever *sends* a push — the actual notification-sending side (presumably another edge function) is outside this file and unverified.
- No offline app shell, no cached assets, no queued-writes-while-offline, no "you have unsynced changes" indicator anywhere. A network drop mid-save shows a toast and otherwise loses the attempt (§4).

## 10. Mobile breakpoints and layout

Four `@media` rules total: `min-width:900px` (sidebar appears), `max-width:640px` (HUD/tabs stack), `max-width:480px` (stock-balance circles shrink), `min-width:700px` (two-column bento grid). Nothing tuned specifically for 320px/390px/430px. The Items management table (12 columns: name, category, unit, on-hand, reorder pt, low warn, max, order qty, use-by, supplier ×2, important, remove) has no mobile-specific alternative — it's the same dense `<table>` at every width, wrapped only in an `overflow-x:auto` container, and its `.stk-input.mini` fields are 34px tall (below the 44px touch-target guidance in the brief). Counting itself (Daily Entry) uses a single `<input type="number">` per item with no +/- steppers, no unit-aware increments, and no keyboard-safe-area/`100dvh` handling.

Accessibility: only two `aria-label`s exist in the whole file (both theme-related). No `role="dialog"`/`aria-modal` or focus trap on the item/category modal (Escape closes it, but focus is never returned to the triggering element). No `aria-live` regions for the toast, sync status, or save results. No `prefers-reduced-motion` media query anywhere, despite numerous CSS `@keyframes` (icon "breathing", sync pulse, number-roll animation, splash screen, peanut celebration) running unconditionally.

## 11. Assumptions and open questions requiring database/project access

These cannot be resolved by reading the HTML and must be answered (by you, or by me with credentials you provide) before implementation claims anything about production security or before any migration is written:

1. **What do the current Row Level Security policies on every `tt_*` table actually say?** This determines whether finding §7.2 is "everything is exploitable via the anon key" or "RLS already blocks writes and the UI checks are just a redundant convenience layer." I have no database credentials and cannot check this myself.
2. **What does the `verify-staff-pin` Edge Function actually do?** Specifically: is the PIN hashed/salted at rest, is there any rate limiting inside the function itself (as opposed to the browser), and what does it return beyond `{ok, name, role}`?
3. **Is there a second Edge Function that sends the Web Push notifications**, and on what trigger (e.g. a low-stock cron, a `tt_items` trigger)? Not visible from this client file.
4. **What writes to `tt_staff_working` and `tt_roster`?** Both are read-only from this client — presumably a separate rostering/POS system. Confirm before assuming they're safe to leave alone.
5. **Real row counts and history depth** — how many items, how many days of `tt_entries` history exist today — so migrations and any backfill can be sized and reviewed before running.
6. **Is Mooloolaba the only store currently live**, and are Noosa/Sunnybank real upcoming stores or placeholders? This affects how urgently the store-partitioning migration needs to happen versus being designed but rolled out gradually.

I will not write or run any migration against production, and will not assume an answer to any of the above — each will be called out again as an explicit approval point when its priority area is reached.

---

## 12. Implementation plan (phased, matching brief priority order)

Given the size of this brief (12 priority areas, new data model, RLS, edge functions, offline PWA, full test suite), this is being built as a sequence of reviewable phases rather than one pass. Each phase produces working, testable output before the next begins. Nothing in Phases 0–2 touches production data; Phases 3+ require your sign-off on the specific migration/RLS/function content before anything is proposed as ready to run (per your rule 5 and 6).

| Phase | Scope | Touches production? |
|---|---|---|
| **0 — done** | This audit; new project scaffold under `tropicool-stocktake-upgraded/` | No |
| **1** | Brisbane business-date module + tests (pure function, no DB) | No |
| **2** | Data-model design: stocktake sessions, count lines, stock movements, batches, store partitioning — written as **proposed** SQL migrations + a data-model doc, not run | No (proposal only) |
| **3** | RLS policy proposals + `verify-staff-pin` v2 (server-side hash/salt, rate limit) + new session-based auth Edge Function — written, not deployed | No (proposal only) |
| **4** | Information architecture rebuild (Home/Count/Orders/Reports/More + bottom nav), mobile counting UI (cards, steppers, unit-aware increments, drawer edit) | No |
| **5** | Error prevention, anomaly confirmation, archive-not-delete | No |
| **6** | Inventory model split (item master vs store inventory), batch expiry | Proposal only until §11.1–2 answered |
| **7** | Ordering workflow | No |
| **8** | Reports + exports (CSV/PDF/JSON) | No |
| **9** | Cash count redesign (denomination calculator, register/shift, approval) | No |
| **10** | Design system/accessibility pass | No |
| **11** | Offline/PWA (manifest, service worker, queue, conflict UI) | No |
| **12** | Final code-quality pass, full automated test suite, docs | No |

**Every migration file and Edge Function produced in Phases 2–9 will be written to `supabase/migrations/` and `supabase/functions/` for your review and will explicitly not be executed. I have no Supabase service-role credentials or CLI project link in this environment even if I wanted to run one.**

## 13. Changes that will require your explicit approval before production

Flagging these now so they're not a surprise later:

- Running any SQL migration (new tables, new columns, RLS policy changes, backfilling `store_id`).
- Replacing the current `verify-staff-pin` function or adding a new auth function.
- Any change to how existing `tt_items.current_stock` / `tt_entries` data is interpreted or migrated into the new stocktake-session model (this is a live data reshape, not additive).
- Rotating/regenerating the Supabase anon key or any credential.
- Enabling Web Push sending logic, or any change to `tt_push_subscriptions` handling.
- Deploying the new app anywhere, or pointing DNS/hosting at it.
- Any Square integration work (explicitly out of scope until you provide credentials).

---

*This file will be kept up to date as implementation proceeds. See `README.md` for setup/deployment instructions once they exist, and `tests/` for the automated coverage described in the brief.*
