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
- [ ] Phase 6 — Inventory model split + batch expiry
- [ ] Phase 7 — Ordering workflow
- [ ] Phase 8 — Reports + exports
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
                                 0001-0006 verified to apply cleanly against a
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

Pick a store (only Mooloolaba has seed data), then sign in with one of the
demo PINs: **1111** (Alice, staff), **2222** (Bob, manager), **3333**
(Chloe, staff). These are mock/demo-only credentials seeded by
`mock-data.js` — see the warning at the top of `js/pin-hash.js` for why this
approach is fine for a mock layer but must never be how a real deployment
checks a PIN.

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

## Running tests

No dependency install required:

```bash
node --test tests/date.test.js                                  # 16 tests
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
