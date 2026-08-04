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
- [ ] Phase 3 — RLS + auth hardening proposals
- [ ] Phase 4 — Information architecture + mobile counting UI
- [ ] Phase 5 — Error prevention / anomaly confirmation / archive-not-delete
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
  index.html                app shell (pending — Phase 4)
  css/app.css                styles (pending — Phase 4, migrated from original)
  js/
    date.js                 Australia/Brisbane business-date utilities (done)
    config.js                Supabase URL/key, constants (pending)
    auth.js                   PIN/session handling, client side of auth (pending)
    database.js                 Supabase query helpers (pending)
    inventory.js                  item master + store inventory (pending)
    stocktake.js                   stocktake sessions, count lines, movements (pending)
    orders.js                       suggested ordering (pending)
    reports.js                       reports + exports (pending)
    ui.js                              rendering/DOM helpers (pending)
  service-worker.js         offline app shell (pending — Phase 11)
  manifest.webmanifest       installable PWA manifest (pending — Phase 11)
  supabase/
    migrations/               proposed SQL migrations (not run against production;
                                 0001-0004 verified to apply cleanly against a
                                 throwaway local Postgres 16, see DATA_MODEL.md)
    functions/                  proposed Edge Function source (not deployed)
  tests/
    date.test.js               Brisbane date tests (done, 16 passing)
```

## Running tests

No dependency install required — tests use Node's built-in test runner
(Node 18+):

```bash
node --test tests/
```

## Why isn't this deployed / connected to Supabase yet?

Per the working rules for this project: no production database changes, no
deployment, and no external actions happen without explicit approval. Each
phase's migrations and Edge Functions are written for review under
`supabase/`, not run. See AUDIT.md §13 for the full list of changes that
need sign-off before they touch production.
