# Tropicool Treats Stocktake — Upgrade (in progress)

This is the upgraded stocktake app, built alongside the original
`tropicool-stocktake_9.html` (kept unchanged at the repo root). See
[`AUDIT.md`](./AUDIT.md) for the full audit of the original app, confirmed
security findings, data-model assumptions that still need confirming, and
the phased implementation plan this project is following.

## Status

This project is being built in phases (see AUDIT.md §12). Nothing here has
been deployed, and no production Supabase migration has been run.

- [x] Phase 0 — Audit + project scaffold
- [x] Phase 1 — Brisbane business-date module (`js/date.js`) + tests
- [x] Phase 2 — Data-model design (stocktake sessions, stock movements, store
      partitioning) — proposed migrations only, see `DATA_MODEL.md`
- [x] Phase 3 — RLS policies + PIN/session auth redesign — proposed only,
      see `AUTH_MODEL.md`
- [x] Phase 4 — Information architecture + mobile counting UI — real,
      running app (mock data backend), see "Running the app" below
- [x] Phase 5 — Error prevention / anomaly confirmation — validation
      (duplicate names, missing units, unsafe URLs, max/reorder ordering,
      negative/decimal quantities) plus anomaly confirmation (large
      variance, over max, unexpected zero) and an in-modal recount reason
      replacing window.prompt
- [x] Phase 6 — Inventory model split + batch expiry
- [x] Phase 7 — Ordering workflow
- [x] Phase 8 — Reports + exports
- [ ] Phase 9 — Cash count redesign
- [ ] Phase 10 — Design system / accessibility pass
- [ ] Phase 11 — Offline/PWA
- [ ] Phase 12 — Final code-quality pass + full test suite + docs

## Layout

```
tropicool-stocktake-upgraded/
  AUDIT.md                 audit + implementation plan (start here)
  DATA_MODEL.md              Phase 2 schema design, rationale, open questions
  AUTH_MODEL.md                Phase 3 auth/session/RLS design, open questions
  index.html                app shell — 5-tab IA, loads js/app.js as a module
  css/app.css                design system: purple brand accent, semantic
                                colours, 44px touch targets, dark mode,
                                prefers-reduced-motion, safe-area/100dvh
  manifest.webmanifest       minimal valid PWA manifest (no icons yet, no
                                service worker registered — that's Phase 11;
                                not claiming installability until it's real)
  js/
    date.js                 Australia/Brisbane business-date utilities —
                               now a plain ES module (was UMD in Phase 1;
                               converted so the browser and Node tests share
                               literally the same file, see package.json)
    config.js                stores, categories, unit-aware step sizes
    pin-hash.js               browser-side twin of the Edge Function's
                                 hash.ts, used ONLY by the mock auth below
    mock-data.js               in-memory seed data (see "Mock data" below)
    database.js                 data-access layer — every function is async
                                   and shaped like the real Supabase calls
                                   will be, currently backed by mock-data.js
    auth.js                      PIN keypad UI + sessionStorage session
    ui.js                         escaping, toasts (aria-live), accessible
                                     modal (focus trap + focus return), icons
    nav.js                         5-tab state, bottom nav (mobile) / sidebar
                                      (desktop)
    home.js                         Home dashboard (Priority 3)
    stocktake.js                     Count tab — the mobile counting
                                        workflow (Priority 4, see below)
    orders.js, reports.js              Orders/Reports tabs (intentionally
                                          light — Priorities 7/8 expand these)
    items.js, staff.js, roster.js,       screens under More (Priority 3)
    cash.js, announcements.js, more.js
    app.js                                   entry point, wires it all up
  supabase/
    migrations/               proposed SQL migrations (not run against production;
                                 0001-0007 verified to apply cleanly against a
                                 throwaway local Postgres 16, see DATA_MODEL.md
                                 and AUTH_MODEL.md)
    functions/
      _shared/                   hash.ts (PBKDF2 PIN hashing), jwt.ts (HS256
                                    session tokens), cors.ts — no external deps,
                                    tested in tests/hash_and_jwt.test.mjs
      verify-staff-pin/          PIN check + rate limiting + session mint (not deployed)
      set-staff-pin/             manager-only PIN reset/role/lock (not deployed)
  service-worker.js         not created yet — Phase 11
  tests/
    date.test.js               Brisbane date tests (16 passing)
    hash_and_jwt.test.mjs        PIN hashing + JWT signing/verification tests (8 passing)
    sql/_local_auth_stub.sql       test-only harness simulating auth.jwt() locally
```

## Running the app (Phase 4)

No build step — it's plain ES modules loaded via `<script type="module">`.
Serve the folder with any static file server and open it in a browser:

```bash
npx http-server tropicool-stocktake-upgraded -p 8080
# then open http://localhost:8080/index.html
```

Pick a store, then sign in with one of the demo PINs. Mooloolaba: **1111**
(Alice, staff), **2222** (Bob, manager), **3333** (Chloe, staff). Noosa (a
second store, seeded from Phase 6 to exercise multi-store isolation with a
smaller, different catalogue): **4444** (Deepak Rao, manager). These are
mock/demo-only credentials seeded by `mock-data.js` — see the warning at the
top of `js/pin-hash.js` for why this approach is fine for a mock layer but
must never be how a real deployment checks a PIN.

### Mock data — what's real and what resets

Every screen is fully functional against `js/database.js`, but that's
currently backed by an in-memory mock seeded fresh on every page load
(see `mock-data.js`) — there is no real backend yet (Phase 2/3's migrations
aren't deployed, see AUDIT.md §13). Two consequences worth knowing before
poking at it:

- **Saved counts don't survive a full page reload** — the mock "database"
  itself resets, which is expected for an in-memory stand-in and is not the
  same thing as the draft-survival requirement (Priority 4's "resume after
  browser closure"). That requirement is about **not losing an in-progress,
  not-yet-confirmed-saved count** if the browser closes mid-entry, which the
  `localStorage` draft layer in `stocktake.js` (`writeDraft`/`readDraft`,
  prefixed `tt_draft_v2_`) does handle correctly — a draft is written before
  the save attempt starts and only cleared after it's confirmed saved. Once
  Phase 2/3 are deployed and `database.js` is swapped to real Supabase
  calls, saved counts will persist for real; only the mock's ephemerality
  goes away, not the interface.
- **Your signed-in session does survive a reload** (`sessionStorage`,
  intentionally — see AUTH_MODEL.md "Session storage choice"), so you won't
  be asked for your PIN again until you close the tab or sign out.

### What was actually verified, not just written

Every screen was driven end to end with Playwright (store picker → PIN
entry → all 5 tabs → item counting → archive flow → sign-in as both roles)
at all six required widths — **320, 390, 430, 768, 1024, and 1440 desktop**
— checking for console/page errors at each. That process caught and fixed
five real bugs before this was called done:
1. A `??`/`||` mix with no parens in `stocktake.js` — a hard JS syntax
   error that would have broken the entire Count tab.
2. `js/date.js` was still in Phase 1's UMD wrapper (`module.exports`), which
   `import` in the browser can't consume — converted to a plain ES module
   (see the `js/date.js` note above) and the test file updated to match.
3. A flexbox `min-width: auto` bug on the quantity input pushed the "+"
   stepper button completely off-screen at 320px width (confirmed via
   measured bounding boxes: the button was rendering at `x: 409` in a
   320px-wide viewport). Fixed with `min-width: 0` on `.tt-qty-input`.
4. The PIN-lock screen's logo (`tt-pinlock-logo`) was never actually styled
   — `app.css` only had a rule for `tt-splash-logo` from the store picker,
   so the two screens' class names had silently drifted apart.
5. The archive confirmation dialog didn't include the item's name, which
   Priority 5 explicitly requires ("Confirmation showing the item name") —
   fixed to read `Archive "Vanilla Gelato Base"?` instead of a generic title.

Also verified: dark mode (`prefers-color-scheme`) renders with correct
contrast and semantic colours; the review-before-submit modal traps focus
and closes on Escape; a manager sees Edit/Archive controls on Items that a
staff account does not (real `isManager()` check, not a cosmetic hide).

### Phase 5 — error prevention + anomaly confirmation

Adds, on top of Phase 4:

- **Validation** (blocks saving outright): duplicate item names within a
  store, missing/blank units, negative quantities, decimal precision finer
  than a unit's step (e.g. `2.567` for a kg item that only counts to 0.1),
  max level not above the reorder point, a supplier link with no supplier
  name, and supplier URLs restricted to `http(s)://` — an explicit
  `javascript:` or other scheme is rejected rather than silently prefixed.
  Enforced in both `items.js` (fast UI feedback) and `database.js`
  (`ValidationError`, mirroring the real migration's CHECK constraints) so
  the rule holds even if a UI check is ever missed or bypassed.
- **Anomaly confirmation** (lets it through, but only after an explicit
  yes): counting well above the max level, an unexpectedly zero count
  where the system expected stock, or a count that differs from the system
  quantity by more than `ANOMALY_VARIANCE_PCT` (`config.js` — a stand-in
  for the brief's "manager-defined threshold"; not yet configurable from
  the UI, flagged rather than pretending it is). A same-item,
  different-staff save without a reason is still treated as a hard
  conflict (Phase 4), now resolved through an accessible in-modal reason
  field instead of `window.prompt` — the gap flagged at the end of the
  Phase 4 notes above is fixed.
- **Incomplete-section acknowledgment**: the review-before-submit modal now
  disables the Submit button until an explicit checkbox is ticked when any
  items are still uncounted, instead of silently allowing submission.
- **Undo after archive**: archiving now shows a toast with an "Undo"
  action (`ui.js`'s `toast()` gained an optional action button for this),
  in addition to the existing "Show archived" restore path.
- **Audit trail**: `database.js` now records `item_added`/`item_edited`/
  `item_archived`/`item_restored` events (actor, before/after state,
  timestamp) to an in-memory audit log — no viewer UI yet, that's the
  Reports area's Audit Log in Priority 8, but the data is being captured
  from this phase on rather than retrofitted later.

Verified with 20 new Playwright checks covering every validation and
anomaly path above (duplicate names, missing units, unsafe protocols,
max/reorder ordering, large-variance confirmation with both cancel and
confirm outcomes, the in-modal recount flow including its own empty-reason
validation, incomplete-section acknowledgment, and undo-after-archive), all
passing, plus a full re-run of the Phase 4 breakpoint/interaction suite to
confirm nothing regressed. One test bug caught along the way and fixed in
product code, not just the test: a `javascript:` URL entered with no
supplier name was rejected for the wrong reason (missing name, checked
first) rather than the protocol — reordered `database.js`'s validation so
unsafe-URL rejection is unconditional rather than only checked once a name
is present.

### Phase 6 — inventory model split + batch expiry

Adds, on top of Phase 5, the full `item_master` / `store_inventory` field
split proposed in `DATA_MODEL.md`, exposed in the Items screen rather than
just living in the schema docs:

- **Ordering/costing fields**: supplier item code, supplier pack unit, pack
  conversion (units per pack), unit cost, lead time (days), safety-stock
  (days), order pack size — all optional, editable on both add and edit,
  and threaded through `database.js`'s validation the same way the Phase 5
  fields are.
- **Critical-item flag**: a checkbox separate from the existing "important"
  star — lives on `item_master` (shared identity) rather than
  `store_inventory` (per-store stock levels), matching the schema split in
  `DATA_MODEL.md`. Shown as a `CRITICAL` badge on the item card. Editing it
  goes through a new `db.setItemCritical()` rather than being folded into
  `updateStoreInventory`, since it is not a per-store field.
- **Batch-level expiry (FEFO)**: replaces the original app's single
  expiry-date-per-item with proper batches — `db.addBatch()`,
  `db.closeBatch(id, 'depleted' | 'wasted', reason, actorId)`,
  `db.getBatchesFor()` (FEFO-sorted, soonest use-by first). The Items
  screen gained a "Batches" button per item opening a modal that lists open
  batches (quantity remaining, received date, use-by, days-to-expiry
  label), lets a manager mark one used up or wasted, and receive a new one
  (quantity, received date, use-by, delivery reference). Wasting a batch
  requires a reason, captured through the existing accessible `promptText()`
  modal rather than reintroducing `window.prompt` (see "Errors and fixes"
  below — this was caught and fixed before testing, not after). Item cards
  and archived-item list also show an expiry badge (`Expires in Nd` /
  `Expires today` / `Expired Nd ago`) sourced from the soonest open batch.
- **Multi-store isolation, exercised not just asserted**: a second store
  (Noosa) was added to the mock seed with its own small item catalogue and
  its own manager (Deepak Rao, PIN 4444), specifically so store isolation
  could be driven end to end in a real browser session rather than reasoned
  about from the code. Every item, inventory, and batch row carries
  `storeId`/derives it via the inventory row, and `getStoreInventory`,
  `getBatchesFor`, etc. all filter by it.

Verified with 18 new Playwright checks: new item-form fields (supplier
code, pack unit/conversion, unit cost, lead time, safety-stock, order pack
size) saving and round-tripping correctly through the edit drawer; the
critical-item badge and checkbox; the full batch lifecycle (add, mark used
up, mark wasted with a required reason, confirming no native
`window.prompt` fires and an empty reason is blocked inline); and
multi-store isolation (signing in at Noosa and confirming exactly its 4
seeded items are visible, that a Mooloolaba-only item from earlier in the
same run is absent, and vice versa). All 18 passing, plus a full re-run of
the Phase 4 and Phase 5 Playwright suites (no regressions) and all 24 unit
tests (date + hash/JWT, still passing).

Two bugs were self-caught and fixed before testing began, not found by the
tests: reusing `window.prompt()` for the waste reason (the exact
anti-pattern Phase 5 had just removed) — fixed by adding a `promptText()`
helper to `ui.js`; and the waste-reason prompt clobbering the open batches
modal's DOM since both use the same modal singleton — fixed by reopening
the batches modal fresh after the prompt resolves instead of reusing stale
element references.

### Phase 7 — ordering workflow

Turns the "needs ordering" list from earlier phases into a trackable
draft &rarr; sent &rarr; received (or cancelled) workflow, proposed as
`supabase/migrations/0007_purchase_orders.sql` (`purchase_orders`,
`purchase_order_lines`, RLS-enforced, not run — see the migration testing
note below) and implemented against the mock layer in `js/orders.js` /
`js/database.js`.

- **Needs ordering, grouped by supplier**: each item shows on-hand stock,
  reorder point, lead time/safety-stock days (context for the human, see
  below), and a suggested order quantity a manager can adjust before
  selecting items to include.
- **Suggested quantity** is deliberately conservative: `target stock (or
  max, or 2x reorder point) - on hand`, rounded up to a full order pack if
  one is set. This app has no sales-velocity data to compute a real,
  demand-based reorder point from lead time and safety stock, so those are
  shown as context for a human to judge urgency rather than folded into a
  formula that would claim more precision than the data supports (working
  rule 7 — no feature that doesn't really do what it looks like it does).
- **Draft &rarr; sent &rarr; received/cancelled**: a manager selects items
  from a supplier group to create a draft order (quantities editable,
  lines removable), marks it sent once they've actually placed it with the
  supplier themselves, and marks it received when it arrives. This app
  never contacts a supplier — "sent" only records that a human did that
  step outside the app (working rule 6: no external actions without
  approval).
- **Receiving updates stock for real**: entering what actually arrived
  (which can differ from what was ordered) bumps `store_inventory.
  currentStock` immediately and logs a stock_movement (`movement_type=
  'delivery'`) for the audit trail. An optional use-by date at receive time
  also opens a batch through the same path Phase 6's "Receive a new batch"
  uses — though, as before, a batch and `currentStock` remain two
  independently tracked numbers (see the comment above `receiveOrder` in
  `database.js`); this is a known, flagged simplification, not new to
  Phase 7.
- Staff (non-managers) see the needs-ordering list and order history
  read-only — no create/edit/send/receive/cancel controls — matching the
  manager-only gating already used for Items.

Verified with 24 new Playwright checks: the full lifecycle (create draft
&rarr; edit quantity &rarr; mark sent &rarr; receive with a use-by date
&rarr; confirm stock and a batch were created), removing a line from a
draft (and being blocked from removing the last one), cancelling with an
accessible reason prompt (confirmed no native `window.prompt`/`confirm`
fires anywhere in the flow), and staff seeing a read-only view. All 24
passing, plus a full re-run of the Phase 4, 5, and 6 Playwright suites (no
regressions) and all 24 unit tests. `0007_purchase_orders.sql`'s RLS was
verified by hand the same way Phase 3's was — applied to a scratch local
Postgres 16 alongside `0001`-`0006` and exercised with the JWT-claims stub:
confirmed a manager can create/view/send/receive orders at their own
store, a non-manager staff member is denied, a manager at a different
store is denied (both create and read), and a draft order's line can be
deleted but a sent/received one cannot.

Two real bugs were caught by this phase's Playwright run, not just the
test script needing adjustment, and fixed in product code:
1. **Toast blocking clicks.** `.tt-toast` sat as a fixed, centred element
   with default pointer events, so tapping something directly underneath
   it (e.g. opening the order you'd just created) could hit the toast
   instead for its ~3s visible window. Fixed by making the toast itself
   `pointer-events: none` and re-enabling it only on `.tt-toast-action`
   (the "Undo" button), so informational toasts never block the content
   they float over.
2. **Item cards rounding decimal stock to a whole number.** `itemCardHtml`
   called `fmtQty(i.currentStock)` with no decimals argument, so a kg item
   like Frozen Blueberries showed "6 kg on hand" instead of "6.2 kg" right
   after a delivery added a fractional amount — a real accuracy problem
   for a stocktake app (working rule 9). Fixed in `items.js` and in this
   phase's own `orders.js` output to pass `decimalsForUnit(unit)`
   (`config.js`, already used correctly in `stocktake.js`'s count cards)
   instead of defaulting to whole numbers. Note: `home.js` and
   `reports.js` have a handful of older `fmtQty(...)` calls with the same
   default-to-whole-number gap for non-variance fields — left alone here
   since fixing them touches already-checkpointed Home/Reports work beyond
   this phase's scope, but flagging it now rather than leaving it silent;
   worth a pass in Phase 10 (design/accessibility) or a dedicated cleanup.

### Phase 8 — reports + exports

Turns the Reports tab from one fixed panel into a report picker with seven
reports, each exportable — real CSV/JSON file downloads (no server round
trip) and a Print button. "Print" opens the browser's own print-to-PDF via
`window.print()` rather than generating a PDF file directly; that's the
honest description of what it does, not a claim of a PDF export this app
doesn't build (working rule 7). A `@media print` stylesheet hides the nav
chrome so only the active report prints.

- **Today's stocktake** (Phase 4, unchanged) — system/counted/variance per
  counted item, kept per-unit rather than summed across units.
- **Staff completion** — who's counted how many of the store's items today,
  including staff who haven't started (0 counted, not silently absent).
- **Waste** — every batch logged as wasted in the last 30 days (item,
  quantity, reason, staff, date), with an estimated cost total that
  explicitly excludes items with no unit cost on file rather than counting
  them as free.
- **Expiry** — batches expired or expiring in the next 14 days, a longer
  planning window than Home's urgent 3-day badge.
- **Valuation** (manager-only, matching unit cost already being
  manager-only everywhere else in the app): on-hand stock value by
  category and in total, again never silently treating a missing unit
  cost as $0 — it's flagged and excluded from the total instead.
- **Orders** — a read-only rollup of Phase 7's order history.
- **Audit log** (manager-only): every recorded action (item added/edited/
  archived, batch received/wasted, order created/sent/received/cancelled,
  etc.) with who did it and when, resolving the actor id to a name rather
  than showing raw ids.

Verified with 27 new Playwright checks: all seven report tabs present for
a manager and the two manager-only ones (valuation, audit log) correctly
hidden from a staff account; switching between reports renders the right
title/table each time; a CSV export is a real downloaded `.csv` file with
a header row, and a JSON export is valid, parseable JSON; the staff
completion, expiry, and valuation reports show real numbers derived from
the actual mock data rather than placeholders; waste and orders reports
update after performing a real waste/order action in the same test run;
the audit log shows an action just performed with the correct actor name;
and the Print button genuinely calls `window.print()`. All 27 passing,
plus a clean re-run of the Phase 4-7 Playwright suites and all 25 unit
tests (one new test added for `formatBrisbaneInstant`, below).

Along the way, converting order/audit timestamps for display surfaced the
same class of bug Phase 7 had already fixed once in `orders.js` (naively
slicing an ISO instant's first 10 characters instead of converting through
Brisbane time) about to be reintroduced in `reports.js`. Rather than fix
it twice, `date.js` gained a shared `formatBrisbaneInstant(isoInstant,
opts)` — composes `brisbaneDateISO` + `formatBrisbaneDate` in one place —
and `orders.js`'s local copy of the same fix was replaced with a call to
it, with a new unit test (`tests/date.test.js`) covering the exact
9am-Brisbane-is-still-yesterday-in-UTC case that motivates it.

## Running tests

No dependency install required:

```bash
node --test tests/date.test.js                                  # 17 tests
node --experimental-strip-types --test tests/hash_and_jwt.test.mjs  # 8 tests, needs Node 22+
```

RLS policies were verified by hand against a local Postgres 16 instance
using `tests/sql/_local_auth_stub.sql` to simulate `auth.jwt()` — see the
Phase 3 commit message for the full list of scenarios exercised (store
isolation, impersonation blocking, manager-only approval, PIN table
lockdown, append-only enforcement). Not yet wired into an automated test
script; that's worth doing once a real Supabase project (or the `supabase`
CLI's local dev stack) is available to run migrations against directly
rather than the hand-built stub.

## Why isn't this deployed / connected to Supabase yet?

Per the working rules for this project: no production database changes, no
deployment, and no external actions happen without explicit approval. Each
phase's migrations and Edge Functions are written for review under
`supabase/`, not run. See AUDIT.md §13 for the full list of changes that
need sign-off before they touch production.
